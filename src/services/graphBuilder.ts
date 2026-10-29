import type {
  BaseTask,
  GraphNode,
  GraphEdge,
  GraphData,
  BuildOptions,
  LinkedTaskRef,
  DependencyRole,
  GraphRelation,
} from '../types'

/** 视为「未完成」的状态值 */
const INCOMPLETE_STATUSES = new Set(['打开', '进行中', 'open', 'in_progress', 'todo'])

/** 明确表示「已完成」的状态值 */
const DONE_STATUSES = new Set([
  '已完成',
  '完成',
  '已关闭',
  '关闭',
  'done',
  'closed',
  'complete',
  'completed',
  'finished',
])

/**
 * 任务是否未完成。
 *
 * 三条规则，顺序很重要：
 * 1. 没有状态字段、或这一格是空的 → **算未完成**。
 *    以前这里是「空 = 已完成」，结果是没有状态字段的表（比如各种统计表）
 *    一条记录都进不了图，表现就是「读到 368 条，但没有任何关系」。
 * 2. 明确写着完成类的值 → 已完成。
 * 3. 其余（打开 / 进行中 / 自定义进度词）→ 未完成。
 *
 * 宁可把已完成的任务多显示一次，也不要把整张表藏起来。
 */
export function isIncomplete(status?: string | string[]): boolean {
  const raw = Array.isArray(status) ? status[0] : status
  const normalized = String(raw ?? '').split(',')[0].trim().toLowerCase()
  if (!normalized) return true
  if (DONE_STATUSES.has(normalized)) return false
  if (INCOMPLETE_STATUSES.has(normalized)) return true
  // 认不出来的状态词按未完成处理（上面两条已经覆盖了明确的完成/进行中）
  return true
}

/** 从标题里抽出开头的 emoji */
export function extractEmoji(title: string): string {
  const regex = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)/u
  const match = title.match(regex)
  return match ? match[1] : '📌'
}

/** 去掉标题开头的 emoji */
export function stripEmoji(title: string): string {
  return title.replace(
    /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*/u,
    '',
  )
}

/** 今天（YYYY-MM-DD，本地时区） */
function today(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 逾期天数：dueDate 早于今天且未完成时为正数 */
function overdueDays(dueDate: string | undefined, isIncompleteTask: boolean): number | undefined {
  if (!dueDate || !isIncompleteTask) return undefined
  const diff = Math.floor(
    (new Date(today()).getTime() - new Date(dueDate).getTime()) / 86_400_000,
  )
  return diff > 0 ? diff : undefined
}

/** 一条依赖关系的解析结果 */
interface ResolvedRelation {
  relationId: string
  label: string
  role: DependencyRole
}

/**
 * 把 BuildOptions 归一化成「一条或多条依赖关系」。
 * 旧调用只给 dependencyRole 时，退化成一条默认关系。
 */
function resolveDependencyRelations(opts: BuildOptions): ResolvedRelation[] {
  if (opts.dependencyRelations && opts.dependencyRelations.length > 0) {
    return opts.dependencyRelations.map((r) => ({
      relationId: r.relationId,
      label: r.label,
      role: r.role,
    }))
  }
  return [
    {
      relationId: opts.dependencyFieldId ?? 'dependency',
      label: opts.dependencyLabel ?? '依赖',
      role: opts.dependencyRole ?? 'fieldIsPrereq',
    },
  ]
}

/**
 * 由任务列表构建依赖图。
 *
 * 节点 id 用「表命名空间 + recordId」：
 * - 单表时 namespace 为空，id 仍然是 recordId（保持旧行为与旧配置兼容）
 * - 多表时 id 变成 `${tableId}:${recordId}`，同名记录不会互相覆盖
 *
 * 图的构成：
 * - 种子：未完成、且（有依赖边 或 有父子边）的任务
 * - 闭包：沿依赖（前置/后继）与父子（父/子）双向扩展
 * - 依赖边：任务 → 前置，颜色只表达状态
 * - 父子边：父 → 子，灰色虚线（不参与「未完成」种子判断，但参与闭包与展示）
 */
export function buildGraphData(tasks: BaseTask[], opts: BuildOptions = {}): GraphData {
  const namespace = opts.namespace?.trim() ?? ''
  const nodeId = (recordId: string) => (namespace ? `${namespace}:${recordId}` : recordId)

  const parentRole = opts.parentRole ?? 'fieldIsParent'
  const relations = resolveDependencyRelations(opts)

  const taskMap = new Map<string, BaseTask>()
  for (const task of tasks) taskMap.set(task.recordId, task)

  // 任务 → 可跳转引用
  const refOf = (task: BaseTask | undefined): LinkedTaskRef | null => {
    if (!task) return null
    return {
      id: nodeId(task.recordId),
      title: stripEmoji(task.title) || task.title,
      emoji: extractEmoji(task.title),
      isIncomplete: isIncomplete(task.status),
    }
  }

  // ── 依赖边（仅指向表内记录） ──
  // 字段语义可能是「前置」也可能是「后续」，这里统一归一化成 prereqMap: 任务 → 它的前置。
  // 多条关系合并进 prereqMap 用于计数与闭包；depPairs 保留每条边的来源关系。
  const prereqMap = new Map<string, string[]>()
  for (const task of tasks) prereqMap.set(task.recordId, [])
  const depPairs: Array<{ taskId: string; prereqId: string; relationId: string }> = []
  const seenPair = new Set<string>()

  const addPair = (taskId: string, prereqId: string, relationId: string) => {
    if (taskId === prereqId || !taskMap.has(taskId) || !taskMap.has(prereqId)) return
    const list = prereqMap.get(taskId)!
    if (!list.includes(prereqId)) list.push(prereqId)
    // 同一对记录只画一条边：多条关系指向同一对时，多重边会完全重叠，反而看不清
    const pairKey = `${taskId}|${prereqId}`
    if (seenPair.has(pairKey)) return
    seenPair.add(pairKey)
    depPairs.push({ taskId, prereqId, relationId })
  }

  for (const task of tasks) {
    for (const relation of relations) {
      const fromField = task.prerequisitesByField?.[relation.relationId]
      // 旧数据只有合并后的 prerequisites 时，只在第一条关系上使用，避免重复计入
      const refs = fromField ?? (relations.length === 1 ? task.prerequisites ?? [] : [])
      for (const ref of refs) {
        if (relation.role === 'fieldIsPrereq') {
          // 字段存的是「我的前置」：本行 → ref
          addPair(task.recordId, ref, relation.relationId)
        } else {
          // 字段存的是「我的后续」：ref 的前置是本行
          addPair(ref, task.recordId, relation.relationId)
        }
      }
    }
  }

  const dependentsMap = new Map<string, string[]>()
  for (const [id, prereqs] of prereqMap) {
    for (const prereqId of prereqs) {
      const list = dependentsMap.get(prereqId) ?? []
      list.push(id)
      dependentsMap.set(prereqId, list)
    }
  }

  // ── 父子边 ──
  const parentMap = new Map<string, string>() // child -> parent
  for (const task of tasks) {
    const ref = task.parentRecordId
    if (!ref || ref === task.recordId || !taskMap.has(ref)) continue
    if (parentRole === 'fieldIsParent') {
      parentMap.set(task.recordId, ref)
    } else {
      // 字段存的是「我的子任务」：ref 的父是本行
      parentMap.set(ref, task.recordId)
    }
  }
  const childrenMap = new Map<string, string[]>()
  for (const [child, parent] of parentMap) {
    const list = childrenMap.get(parent) ?? []
    list.push(child)
    childrenMap.set(parent, list)
  }

  // ── 种子与闭包 ──
  // 种子只看依赖关系：父子关系是附加信息，不该单独撑起节点。
  // 开启父子时，闭包会把它连带拉进来；关掉时不出现。
  const seeds = tasks.filter((t) => {
    if (!isIncomplete(t.status)) return false
    return (
      (prereqMap.get(t.recordId)?.length ?? 0) > 0 ||
      (dependentsMap.get(t.recordId)?.length ?? 0) > 0
    )
  })

  const involved = new Set<string>()
  const visited = new Set<string>()
  const collect = (id: string, depth = 0) => {
    if (visited.has(id) || depth > 50) return
    visited.add(id)
    if (!taskMap.has(id)) return
    involved.add(id)
    for (const p of prereqMap.get(id) ?? []) collect(p, depth + 1)
    for (const d of dependentsMap.get(id) ?? []) collect(d, depth + 1)
    const parent = parentMap.get(id)
    if (parent) collect(parent, depth + 1)
    for (const c of childrenMap.get(id) ?? []) collect(c, depth + 1)
  }
  for (const seed of seeds) collect(seed.recordId)

  /**
   * 传递阻塞数：从本任务沿「谁依赖我」方向走到底，统计未完成的下游任务。
   * A→B→C（A 被 B 依赖，B 被 C 依赖）时，A 的阻塞数 = 2。
   * 用 visited 去重，菱形依赖不会重复计数。
   */
  const blockedDownstream = (startId: string): number => {
    const seen = new Set<string>()
    const stack = [...(dependentsMap.get(startId) ?? [])]
    while (stack.length > 0) {
      const id = stack.pop() as string
      if (seen.has(id)) continue
      seen.add(id)
      for (const next of dependentsMap.get(id) ?? []) {
        if (!seen.has(next)) stack.push(next)
      }
    }
    let count = 0
    for (const id of seen) {
      if (id === startId) continue
      if (isIncomplete(taskMap.get(id)?.status)) count += 1
    }
    return count
  }

  // ── 节点 ──
  const nodes: GraphNode[] = []
  for (const recordId of involved) {
    const task = taskMap.get(recordId)
    if (!task) continue

    const title = stripEmoji(task.title) || task.title
    const prereqs = prereqMap.get(recordId) ?? []
    const succs = dependentsMap.get(recordId) ?? []
    const inc = isIncomplete(task.status)
    const toRef = (id: string) => refOf(taskMap.get(id))

    nodes.push({
      id: nodeId(recordId),
      namespace: namespace || undefined,
      recordId,
      label: title,
      emoji: extractEmoji(task.title),
      title,
      rawTitle: task.title,
      dueDate: task.dueDate,
      overdueDays: overdueDays(task.dueDate, inc),
      tags: task.tags ?? [],
      status: (task.status ?? []).join(', '),
      isIncomplete: inc,
      isTerminal: prereqs.length === 0,
      prerequisiteCount: prereqs.length,
      successorCount: succs.length,
      blockingCount: prereqs.filter((p) => isIncomplete(taskMap.get(p)?.status)).length,
      blocksCount: blockedDownstream(recordId),
      didaId: task.didaId,
      projectId: task.projectId,
      listName: task.listName,
      description: task.description,
      prerequisiteTitles: prereqs.map((p) => taskMap.get(p)?.title ?? p),
      successorTitles: succs.map((s) => taskMap.get(s)?.title ?? s),
      parentTitle: parentMap.get(recordId)
        ? taskMap.get(parentMap.get(recordId)!)?.title
        : undefined,
      childTitles: (childrenMap.get(recordId) ?? []).map((c) => taskMap.get(c)?.title ?? c),
      prerequisiteRefs: prereqs.map((id) => toRef(id)).filter(Boolean) as LinkedTaskRef[],
      successorRefs: succs.map((id) => toRef(id)).filter(Boolean) as LinkedTaskRef[],
      parentRef: parentMap.get(recordId) ? toRef(parentMap.get(recordId)!) : undefined,
      childRefs: (childrenMap.get(recordId) ?? [])
        .map((id) => toRef(id))
        .filter(Boolean) as LinkedTaskRef[],
    })
  }

  // ── 边 ──
  // 依赖边方向：任务 → 前置（箭头指向「它在等的那件事」）。
  // 颜色只看状态；relationId 交给样式注册表决定线型与箭头。
  const edges: GraphEdge[] = []
  for (const pair of depPairs) {
    if (!involved.has(pair.taskId) || !involved.has(pair.prereqId)) continue
    edges.push({
      source: nodeId(pair.taskId),
      target: nodeId(pair.prereqId),
      kind: 'dependency',
      relationId: pair.relationId,
      prerequisiteComplete: !isIncomplete(taskMap.get(pair.prereqId)?.status),
      sourceComplete: !isIncomplete(taskMap.get(pair.taskId)?.status),
    })
  }

  for (const recordId of involved) {
    const parentId = parentMap.get(recordId)
    if (!parentId || !involved.has(parentId)) continue
    edges.push({
      source: nodeId(parentId),
      target: nodeId(recordId),
      kind: 'parent',
      relationId: opts.parentFieldId ?? 'parent',
    })
  }

  // 只把真正出现在图里的关系交给图例与样式解析
  const usedRelations: GraphRelation[] = []
  const usedIds = new Set(edges.map((e) => e.relationId))
  for (const relation of relations) {
    if (usedIds.has(relation.relationId)) {
      usedRelations.push({
        relationId: relation.relationId,
        kind: 'dependency',
        label: relation.label,
      })
    }
  }
  if (opts.parentFieldId && usedIds.has(opts.parentFieldId)) {
    usedRelations.push({
      relationId: opts.parentFieldId,
      kind: 'parent',
      label: opts.parentLabel ?? '父子',
    })
  }

  return { nodes, edges, relations: usedRelations }
}

/** 清单分组的依据 */
export interface ChecklistItem {
  node: GraphNode
  /** 可立即动手：未完成且所有依赖前置都已完成（或无前置） */
  ready: boolean
  /** 被阻塞：未完成且存在未完成的前置 */
  blocked: boolean
}

/** 由图数据派生清单：未完成任务按 可动手/被阻塞 分组，按截止时间排序 */
export function buildChecklist(data: GraphData): {
  ready: ChecklistItem[]
  blocked: ChecklistItem[]
  done: ChecklistItem[]
} {
  const toItems = (nodes: GraphNode[]): ChecklistItem[] =>
    nodes.map((node) => ({
      node,
      ready: node.isIncomplete && node.blockingCount === 0,
      blocked: node.isIncomplete && node.blockingCount > 0,
    }))

  const byDue = (a: ChecklistItem, b: ChecklistItem) => {
    const da = a.node.dueDate ?? '9999-12-31'
    const db = b.node.dueDate ?? '9999-12-31'
    if (da !== db) return da < db ? -1 : 1
    return a.node.label.localeCompare(b.node.label, 'zh')
  }

  const items = toItems(data.nodes)
  return {
    ready: items.filter((i) => i.ready).sort(byDue),
    blocked: items.filter((i) => i.blocked).sort(byDue),
    done: items.filter((i) => !i.node.isIncomplete).sort(byDue),
  }
}
