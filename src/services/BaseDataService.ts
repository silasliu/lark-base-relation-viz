import { bitable, FieldType } from '@lark-base-open/js-sdk'
import type { BaseTask, GraphData, TableOption, LinkFieldOption, BuildOptions, TaskState } from '../types'
import { config } from '../config'
import { buildGraphData } from './graphBuilder'
import { readAllPages } from './pagination'
import { cellToRecordIds, cellToOptionKeys, looksLikeLinkCell } from './cellValues'
import { stateFromKeys } from './statusMapping'

/**
 * 开发调试回退：在飞书宿主之外（浏览器直接打开）时，SDK 永不 resolve。
 * 此时加载 public/mock-data.json（从真实 Base 导出的快照，gitignore），
 * 让布局/交互可以在浏览器里直接调试。生产构建刻意不打包它。
 */
interface MockData {
  _comment?: string
  _tables?: { id: string; name: string }[]
  /** 字段元数据：mock 路径用它把「字段名 → fieldId」解析出来（与宿主 getFieldMetaList 等价） */
  _fieldMeta?: { id: string; name: string; isPrimary?: boolean }[]
  records: { recordId: string; fields: Record<string, unknown> }[]
}

let mockCache: MockData | null = null

async function loadMock(): Promise<MockData> {
  if (mockCache) return mockCache
  const res = await fetch('mock-data.json')
  if (!res.ok) {
    // 生产构建刻意不打包 mock 数据（那是真实 Base 快照，仓库公开，不能发布）。
    // 所以在飞书之外直接打开部署地址时，这里没有数据可用——给一句人话，而不是开发术语。
    throw new Error(
      import.meta.env.DEV
        ? '浏览器直开模式需要 public/mock-data.json（未找到）'
        : '请在飞书多维表格中打开这个插件；直接用浏览器访问时没有可显示的数据。',
    )
  }
  mockCache = await res.json()
  return mockCache
}

/** 是否处于飞书宿主内（扩展脚本以 iframe 形式运行） */
function probablyInHost(): boolean {
  return typeof window !== 'undefined' && window.parent !== window
}

/**
 * 单次请求的记录数上限。
 * SDK 文档明确：pageSize 默认 200，**最大不得超过 200**。
 * 超过时宿主会直接报 `single record operation exceeds records limit`。
 * 更大的表靠 pageToken 翻页，不要往上调。
 */
const PAGE_SIZE = 200

/** SDK 在非宿主环境下可能永不 resolve，必须自己设超时兜底 */
const HOST_TIMEOUT_MS = 20_000

const HOST_TIMEOUT_MESSAGE =
  '连接多维表格宿主超时。这个页面需要作为「多维表格扩展程序」在飞书里打开，直接用浏览器访问是读不到表的。'

/** 探测 SDK 是否可用时的超时：短一点，避免把「请在飞书里打开」的提示拖住 */
const PROBE_TIMEOUT_MS = 2_500

function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  ms: number = HOST_TIMEOUT_MS,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms)
    }),
  ])
}

interface TextLike {
  text?: string
}

/** 单元格 → 纯文本 */
function cellToText(value: unknown): string {
  if (value == null) return ''
  if (Array.isArray(value)) {
    return value
      .map((v) => cellToText(v))
      .filter((s) => s !== '')
      .join(', ')
  }
  if (typeof value === 'object') {
    const v = value as TextLike
    return 'text' in v ? String(v.text ?? '') : ''
  }
  return String(value)
}

/** 单元格 → 字符串数组 */
function cellToArray(value: unknown): string[] {
  if (value == null) return []
  if (Array.isArray(value)) {
    return value.flatMap((v) => cellToArray(v)).filter((s) => s !== '')
  }
  if (typeof value === 'object') {
    const text = cellToText(value)
    return text ? [text] : []
  }
  const text = String(value).trim()
  return text ? [text] : []
}

/** 时间戳 → YYYY-MM-DD（Asia/Shanghai） */
function cellToDate(value: unknown): string | undefined {
  const text = cellToText(value)
  if (!text) return undefined
  const num = Number(text)
  if (Number.isFinite(num) && num > 0) {
    const d = new Date(num)
    if (!Number.isNaN(d.getTime())) {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d)
    }
  }
  return text.slice(0, 10)
}

/** 读取参数 */
export interface LoadProgress {
  onProgress?: (loaded: number, total?: number) => void
  /** 状态字段 id。不给 = 中性模式（不知道完成与否） */
  statusFieldId?: string
  /** 勾选为「已完成」的选项 key（选项 id 与名称的并集） */
  doneOptionKeys?: string[]
}

/** 一个状态选项 */
export interface StatusOption {
  id: string
  name: string
  color: number
}

/** 可以作为「完成状态」来源的字段（单选 / 多选） */
export interface StatusFieldMeta {
  id: string
  name: string
  multiple: boolean
  options: StatusOption[]
}

/** 关联字段扫描结果（含跨表字段，用于诊断） */
export interface ScannedLinkField {
  id: string
  name: string
  targetTableId: string
  /** 是否指向本表（只有自关联才能画图） */
  selfLink: boolean
}

/**
 * 读取多维表格并构建依赖图。
 * 插件运行在飞书宿主中，鉴权由宿主提供，无需 token。
 */
export class BaseDataService {
  /**
   * 运行环境：宿主 / 本地 mock。
   * 不用「是不是 iframe」当唯一依据——有些宿主会把插件开在独立窗口里，
   * 那样 window.parent === window，但 SDK 其实是可用的。
   */
  private mode: 'unknown' | 'host' | 'mock' = 'unknown'

  /** 是否处于本地 mock 模式（判定完成后才有意义） */
  get isMock(): boolean {
    return this.mode === 'mock'
  }

  /**
   * 判定一次并缓存。
   *
   * 先用「是不是 iframe」快速判断，不做任何桥接等待——否则每次启动都要先等一次
   * SDK 超时，浏览器里调试会卡十几秒。只有「判成 mock 但本地没有 mock 数据」时
   * 才回头探一次真实 SDK（有些宿主会把插件开在独立窗口里，此时
   * window.parent === window，但 SDK 其实可用）。
   */
  private async ensureMode(): Promise<'host' | 'mock'> {
    if (this.mode !== 'unknown') return this.mode
    this.mode = probablyInHost() ? 'host' : 'mock'
    return this.mode
  }

  /** 探一次真实 SDK，用来纠正「独立窗口里其实是宿主」的情况 */
  private async probeHost(): Promise<boolean> {
    try {
      await withTimeout(
        bitable.base.getTableMetaList(),
        HOST_TIMEOUT_MESSAGE,
        PROBE_TIMEOUT_MS,
      )
      this.mode = 'host'
      return true
    } catch {
      return false
    }
  }

  /** 当前 Base 里的所有数据表 */
  async listTables(): Promise<TableOption[]> {
    if ((await this.ensureMode()) === 'mock') {
      try {
        const mock = await loadMock()
        return mock._tables ?? []
      } catch (mockError) {
        // 拿不到本地 mock：可能其实在宿主里，只是宿主开的是独立窗口
        if (await this.probeHost()) {
          const metas = await withTimeout(bitable.base.getTableMetaList(), HOST_TIMEOUT_MESSAGE)
          return metas.map((m) => ({ id: m.id, name: m.name }))
        }
        throw mockError
      }
    }
    const metas = await withTimeout(bitable.base.getTableMetaList(), HOST_TIMEOUT_MESSAGE)
    return metas.map((m) => ({ id: m.id, name: m.name }))
  }

  /**
   * 当前在 Base 界面里正打开的那张表。
   *
   * 为什么需要它：以前是盲选「第一张表」，但用户实际看的是 URL 里那张
   * （`?table=tblXXXX`）。多表 Base 里这会让插件打开错误的表，
   * 表现为「什么都显示不出来」。
   */
  async getActiveTableId(): Promise<string | undefined> {
    if ((await this.ensureMode()) === 'mock') return undefined
    try {
      const table = await withTimeout(bitable.base.getActiveTable(), HOST_TIMEOUT_MESSAGE)
      return table?.id || undefined
    } catch {
      // 拿不到就退回「已保存 / 第一张表」，不阻断
      return undefined
    }
  }

  /**
   * 扫描一张表里所有关联字段（含跨表），用于诊断。
   * 只有 `selfLink = true`（指向本表）的字段能画图。
   */
  async scanLinkFields(tableId: string): Promise<ScannedLinkField[]> {
    if ((await this.ensureMode()) === 'mock') {
      const mock = await loadMock()
      const metas = mock._fieldMeta ?? []
      // 不写死字段名：扫一遍记录，凡是「值为 record 引用数组」的字段都算关联字段。
      // 这样本地 mock 加一个新的依赖字段就能直接验证多关系，不用改代码。
      const linkIds = new Set<string>()
      for (const record of mock.records) {
        for (const [fieldId, value] of Object.entries(record.fields)) {
          if (linkIds.has(fieldId)) continue
          if (looksLikeLinkCell(value)) linkIds.add(fieldId)
        }
      }
      return metas
        .filter((m) => linkIds.has(m.id))
        .map((m) => ({ id: m.id, name: m.name, targetTableId: tableId, selfLink: true }))
    }

    const table = await withTimeout(bitable.base.getTableById(tableId), HOST_TIMEOUT_MESSAGE)
    const metas = await withTimeout(table.getFieldMetaList(), HOST_TIMEOUT_MESSAGE)

    const result: ScannedLinkField[] = []
    for (const meta of metas) {
      if (meta.type !== FieldType.SingleLink && meta.type !== FieldType.DuplexLink) continue
      const property = (meta as { property?: { tableId?: string } }).property
      const targetTableId = String(property?.tableId ?? '')
      result.push({
        id: meta.id,
        name: meta.name,
        targetTableId,
        selfLink: targetTableId === tableId,
      })
    }
    return result
  }

  /**
   * 扫描可以作为「完成状态」来源的字段（单选 / 多选），连同它们的选项。
   * 有了选项列表，用户就能直接勾「哪些选项算完成」，不用靠代码猜词。
   */
  async scanStatusFields(tableId: string): Promise<StatusFieldMeta[]> {
    if ((await this.ensureMode()) === 'mock') {
      const mock = await loadMock()
      const metas = mock._fieldMeta ?? []
      const statusMeta = metas.find((m) => m.name === config.optionalFields.status)
      if (!statusMeta) return []
      // mock 没有字段选项元数据，退而从记录里收集出现过的值
      const names = new Set<string>()
      for (const record of mock.records) {
        for (const name of cellToArray(record.fields[statusMeta.id])) names.add(name)
      }
      return [
        {
          id: statusMeta.id,
          name: statusMeta.name,
          multiple: false,
          options: [...names].map((name, index) => ({ id: `opt_${name}`, name, color: index })),
        },
      ]
    }

    const table = await withTimeout(bitable.base.getTableById(tableId), HOST_TIMEOUT_MESSAGE)
    const metas = await withTimeout(table.getFieldMetaList(), HOST_TIMEOUT_MESSAGE)

    const result: StatusFieldMeta[] = []
    for (const meta of metas) {
      const isSingle = meta.type === FieldType.SingleSelect
      const isMulti = meta.type === FieldType.MultiSelect
      if (!isSingle && !isMulti) continue
      const property = (meta as {
        property?: { options?: Array<{ id?: string; name?: string; color?: number }> }
      }).property
      const options: StatusOption[] = []
      for (const option of property?.options ?? []) {
        const id = typeof option?.id === 'string' ? option.id : ''
        const name = typeof option?.name === 'string' ? option.name : ''
        if (!id && !name) continue
        options.push({ id, name, color: typeof option?.color === 'number' ? option.color : 0 })
      }
      result.push({ id: meta.id, name: meta.name, multiple: isMulti, options })
    }
    return result
  }

  /**
   * 某张表里的自关联字段（可作为依赖或父子来源）。
   * 只有「关联到本表自己」的字段才有图上的语义，跨表关联不参与。
   */
  async listLinkFields(tableId: string): Promise<LinkFieldOption[]> {
    const all = await this.scanLinkFields(tableId)
    return all
      .filter((f) => f.selfLink)
      .map((f) => ({ id: f.id, name: f.name, targetTableId: f.targetTableId }))
  }

  /**
   * 某张表里有没有「填了值」的自关联关系。
   * 用来在「当前表画不出图」时判断要不要切回上次那张能画的表。
   */
  async tableHasRelations(tableId: string): Promise<boolean> {
    try {
      const links = await this.listLinkFields(tableId)
      if (links.length === 0) return false
      const tasks = await this.loadTasks(
        tableId,
        links.map((l) => l.id),
      )
      return tasks.some((t) => (t.prerequisites ?? []).length > 0)
    } catch {
      return false
    }
  }

  /**
   * 读取指定表的记录。
   * @param tableId 数据表
   * @param dependencyFieldIds 依赖字段（可多个，同时显示多种依赖关系）
   * @param parentFieldId 父子字段（父 → 子，灰虚线边），可空 = 不画父子
   */
  async loadTasks(
    tableId: string,
    dependencyFieldIds: string[],
    parentFieldId?: string,
    progress: LoadProgress = {},
  ): Promise<BaseTask[]> {
    const depFieldIds = dependencyFieldIds.filter(Boolean)

    // 浏览器直开 → mock 快照（走与宿主完全相同的归一化路径，字段元数据从 _fieldMeta 取）
    if ((await this.ensureMode()) === 'mock') {
      const mock = await loadMock()
      const metas = mock._fieldMeta ?? []
      const idByName = new Map(metas.map((m) => [m.name, m.id]))
      const primary = metas.find((m) => m.isPrimary)
      const optional = config.optionalFields
      return normalizeRecords(mock.records, {
        titleId: primary?.id,
        statusId: idByName.get(optional.status),
        tagsId: idByName.get(optional.tags),
        dueId: idByName.get(optional.dueDate),
        didaIdFieldId: idByName.get(optional.didaId),
        projectIdId: idByName.get(optional.projectId),
        listId: idByName.get(optional.list),
        descriptionId: optional.descriptionCandidates
          .map((n) => idByName.get(n))
          .find((id) => Boolean(id)),
        dependencyFieldIds: depFieldIds,
        parentFieldId,
        statusFieldId: progress.statusFieldId,
        doneKeys: new Set(progress.doneOptionKeys ?? []),
      })
    }

    const table = await withTimeout(bitable.base.getTableById(tableId), HOST_TIMEOUT_MESSAGE)
    const metas = await withTimeout(table.getFieldMetaList(), HOST_TIMEOUT_MESSAGE)

    const idByName = new Map(metas.map((m) => [m.name, m.id]))
    const primary = metas.find((m) => m.isPrimary)

    const optional = config.optionalFields
    const fieldIds = {
      titleId: primary?.id,
      statusId: idByName.get(optional.status),
      tagsId: idByName.get(optional.tags),
      dueId: idByName.get(optional.dueDate),
      didaIdFieldId: idByName.get(optional.didaId),
      projectIdId: idByName.get(optional.projectId),
      listId: idByName.get(optional.list),
      descriptionId: optional.descriptionCandidates
        .map((n) => idByName.get(n))
        .find((id) => Boolean(id)),
      dependencyFieldIds: depFieldIds,
      parentFieldId,
      statusFieldId: progress.statusFieldId,
      doneKeys: new Set(progress.doneOptionKeys ?? []),
    }

    type RawRecord = { recordId: string; fields: Record<string, unknown> }

    // 分页令牌保持 SDK 的 number 类型；转成字符串会让宿主在第二页报参数非法
    const records = await readAllPages<RawRecord>(
      (pageToken) =>
        withTimeout(
          table.getRecordsByPage({
            pageSize: PAGE_SIZE,
            pageToken,
          }) as Promise<{
            records: RawRecord[]
            hasMore: boolean
            pageToken?: number
            total?: number
          }>,
          HOST_TIMEOUT_MESSAGE,
        ),
      {
        onProgress: progress.onProgress,
        describeError: (err, loaded) => {
          const reason = err instanceof Error ? err.message : String(err)
          return `读取记录失败（已读到 ${loaded} 条）：${reason}`
        },
      },
    )

    return normalizeRecords(records, fieldIds)
  }

  /** 构建依赖图（纯逻辑见 graphBuilder） */
  buildGraphData(tasks: BaseTask[], options?: BuildOptions): GraphData {
    return buildGraphData(tasks, options)
  }
}

/** 记录页 → BaseTask[]（宿主与 mock 共用的归一化） */
function normalizeRecords(
  records: Array<{ recordId: string; fields: Record<string, unknown> }>,
  ids: {
    titleId?: string
    statusId?: string
    tagsId?: string
    dueId?: string
    didaIdFieldId?: string
    projectIdId?: string
    listId?: string
    descriptionId?: string
    dependencyFieldIds: string[]
    parentFieldId?: string
    /** 状态字段（单选/多选）。不给 = 中性模式 */
    statusFieldId?: string
    /** 勾选为已完成的选项 key */
    doneKeys?: Set<string>
  },
): BaseTask[] {
  const tasks: BaseTask[] = []
  for (const record of records) {
    const get = (fieldId?: string) => (fieldId ? record.fields[fieldId] : undefined)

    const prerequisitesByField: Record<string, string[]> = {}
    const merged: string[] = []
    for (const fieldId of ids.dependencyFieldIds) {
      const refs = cellToRecordIds(get(fieldId))
      prerequisitesByField[fieldId] = refs
      for (const ref of refs) if (!merged.includes(ref)) merged.push(ref)
    }

    const statusKeys = ids.statusFieldId ? cellToOptionKeys(get(ids.statusFieldId)) : []
    const state: TaskState = ids.statusFieldId
      ? stateFromKeys(statusKeys, ids.doneKeys ?? new Set())
      : 'unknown'

    tasks.push({
      recordId: record.recordId,
      didaId: cellToText(get(ids.didaIdFieldId)) || undefined,
      title: ids.titleId ? cellToText(get(ids.titleId)) : '',
      // 展示用：优先用配置的状态字段，没配置就沿用名字匹配到的那个
      status: cellToArray(get(ids.statusFieldId ?? ids.statusId)),
      statusKeys,
      state,
      tags: cellToArray(get(ids.tagsId)),
      dueDate: cellToDate(get(ids.dueId)),
      prerequisitesByField,
      prerequisites: merged,
      parentRecordId: ids.parentFieldId
        ? cellToRecordIds(get(ids.parentFieldId))[0]
        : undefined,
      projectId: cellToText(get(ids.projectIdId)) || undefined,
      listName: cellToArray(get(ids.listId))[0] || undefined,
      description: cellToText(get(ids.descriptionId)).trim() || undefined,
    })
  }
  for (const task of tasks) {
    if (!task.title) task.title = task.recordId
  }
  return tasks
}
