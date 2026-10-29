import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { DependencyGraph } from './components/DependencyGraph'
import { ChecklistPanel } from './components/ChecklistPanel'
import { DetailsPanel } from './components/DetailsPanel'
import { BaseDataService, type ScannedLinkField, type StatusFieldMeta } from './services/BaseDataService'
import { loadConfig, saveConfig, type PersistedConfig, type DependencyRole, type ParentRole } from './services/ConfigStore'
import { applyCollapse, collapsibleKinds, EMPTY_COLLAPSE, type CollapseState } from './services/collapse'
import { watchTable } from './services/DataWatcher'
import { chooseTableId } from './services/tableChoice'
import { guessDoneKeys } from './services/statusMapping'
import type {
  GraphNode,
  GraphData,
  TableOption,
  LinkFieldOption,
  LayoutMode,
  GraphApi,
} from './types'
import { LAYOUT_LABELS } from './components/graphShapes'
import { WHEEL_ZOOM_MIN } from './components/graphZoom'
import { resolveRelationStyles, lineDashCss } from './services/relationStyles'
import { downloadPng, exportFileName } from './services/exportImage'
import { config } from './config'
import './App.css'

/** 清单筛选条件 */
export interface ChecklistFilter {
  list?: string
  tag?: string
}

function App() {
  const [tables, setTables] = useState<TableOption[]>([])
  const [tableId, setTableId] = useState('')
  const [fields, setFields] = useState<LinkFieldOption[]>([])
  /** 参与绘制的依赖字段，第一个为主字段。多选 = 同时显示多种依赖关系 */
  const [depFieldIds, setDepFieldIds] = useState<string[]>([])
  const [parentFieldId, setParentFieldId] = useState('')
  /** 可选作「完成状态」来源的字段（单选/多选）及其选项 */
  const [statusFields, setStatusFields] = useState<StatusFieldMeta[]>([])
  /** 当前选中的状态字段；空字符串 = 中性模式 */
  const [statusFieldId, setStatusFieldId] = useState('')
  /** 勾选为「已完成」的选项 key（选项 id 与名称的并集） */
  const [doneOptionKeys, setDoneOptionKeys] = useState<string[]>([])
  const [depRole, setDepRole] = useState<DependencyRole>('fieldIsPrereq')
  const [parentRole, setParentRole] = useState<ParentRole>('fieldIsParent')
  const [showParent, setShowParent] = useState(true)

  const [graphData, setGraphData] = useState<GraphData | null>(null)
  const [layout, setLayout] = useState<LayoutMode>('dagre-tb')
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const graphApiRef = useRef<GraphApi>(null)
  const appRef = useRef<HTMLDivElement>(null)

  const [recordCount, setRecordCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadStage, setLoadStage] = useState('正在连接多维表格…')
  /** 大表分页读取进度：已读 N / M 条 */
  const [readProgress, setReadProgress] = useState('')
  /** 长时间停在加载态时的提示（多半是在普通浏览器里直接打开了部署地址） */
  const [slowHint, setSlowHint] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sideTab, setSideTab] = useState<'checklist' | 'details'>('checklist')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [toast, setToast] = useState<string | null>(null)
  const [filter, setFilter] = useState<ChecklistFilter>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportMenu, setExportMenu] = useState(false)
  /** 沉浸模式：隐藏工具栏与侧栏，把插件可用区域全部给画布 */
  const [immersive, setImmersive] = useState(false)

  const [collapse, setCollapse] = useState<CollapseState>(EMPTY_COLLAPSE)
  const [liveTick, setLiveTick] = useState(0)
  const [liveOn, setLiveOn] = useState(true)
  /**
   * 自诊断信息。
   * 打不开时用户不该只能看到一句「失败」——把环境、表、字段都摊开，
   * 这样不用来回问就能定位是「选错表」「没有自关联字段」还是「宿主连不上」。
   */
  const [diag, setDiag] = useState<{
    inHost: boolean
    tables: string[]
    activeTableId?: string
    linkFields: ScannedLinkField[]
  }>({ inHost: true, tables: [], linkFields: [] })
  /** 运行环境是否已判定为本地 mock（判定发生在第一次读表之后） */
  const [isMockEnv, setIsMockEnv] = useState(false)

  // 点空白处关闭导出菜单
  useEffect(() => {
    if (!exportMenu) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target?.closest('.export-wrap')) setExportMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [exportMenu])

  const service = useMemo(() => new BaseDataService(), [])
  const configRef = useRef<PersistedConfig | null>(null)
  const analyzeSeq = useRef(0)

  const persist = useCallback((patch: Partial<PersistedConfig>) => {
    if (!configRef.current) return
    configRef.current = { ...configRef.current, ...patch }
    void saveConfig(configRef.current)
  }, [])

  const showToast = useCallback((text: string) => {
    setToast(text)
    window.setTimeout(() => setToast(null), 3200)
  }, [])

  // ── 启动 ──
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // 配置读取在非宿主环境下要等桥接超时，和读表并行跑，别让两条超时叠起来
      const configPromise = loadConfig()
      try {
        setLoadStage('正在读取数据表…')
        const list = await service.listTables()
        const saved = await configPromise
        if (cancelled) return

        configRef.current = saved
        setLayout(saved.layout)
        setDepRole(saved.dependencyRole)
        setParentRole(saved.parentRole)
        setShowParent(saved.showParent ?? true)
        // 窄屏（飞书侧边栏）下默认收起，避免侧栏盖住画布；宽屏沿用用户选择
        const isNarrow = window.innerWidth < 620
        setSidebarCollapsed(isNarrow ? true : (saved.sidebarCollapsed ?? false))

        setTables(list)
        const mockEnv = service.isMock
        setIsMockEnv(mockEnv)
        setDiag((prev) => ({
          ...prev,
          inHost: !mockEnv,
          tables: list.map((t) => `${t.name}（${t.id}）`),
        }))
        if (list.length === 0) {
          setError('这个 Base 里还没有数据表。')
          return
        }

        // 表的选择顺序：正在看的表 → 上次选的表 → 第一张。
        // 「正在看的表」优先，是因为用户就是照着 URL 里那张表打开插件的；
        // 以前盲选第一张，多表 Base 里会直接打开错误的表，看起来就是「什么都显示不出来」。
        const activeId = await service.getActiveTableId()
        if (cancelled) return
        setTableId(
          chooseTableId({
            available: list.map((t) => t.id),
            activeId,
            savedId: saved.tableId,
          }) ?? list[0].id,
        )
      } catch (err) {
        if (!cancelled) {
          // 出错时也要把环境如实写进诊断，否则会误报成「飞书宿主 iframe」
          const mockEnv = service.isMock
          setIsMockEnv(mockEnv)
          setDiag((prev) => ({ ...prev, inHost: !mockEnv }))
          setError(err instanceof Error ? err.message : '读取数据表列表失败')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [service])

  // ── 换表：列出字段 ──
  useEffect(() => {
    if (!tableId) return
    let cancelled = false
    setFields([])
    setDepFieldIds([])
    setParentFieldId('')
    setGraphData(null)
    ;(async () => {
      try {
        // 扫全部关联字段（含跨表），这样「一个都没找到」和「找到的都是跨表」能区分开
        const scanned = await service.scanLinkFields(tableId)
        if (cancelled) return
        setDiag((prev) => ({ ...prev, activeTableId: tableId, linkFields: scanned }))

        const list = scanned
          .filter((f) => f.selfLink)
          .map((f) => ({ id: f.id, name: f.name, targetTableId: f.targetTableId }))
        setFields(list)

        // 完成状态：只列单选/多选字段。没配置过就按名字猜一个（状态/status/stage），
        // 并按选项名给一版初始勾选；用户改一次就持久化，之后不再猜。
        const statusScans = await service.scanStatusFields(tableId).catch(() => [])
        if (cancelled) return
        setStatusFields(statusScans)

        const savedCfg = configRef.current
        const savedStatus = statusScans.find((f) => f.id === savedCfg?.statusFieldId)
        const guessed =
          savedStatus ??
          statusScans.find((f) => /状态|status|stage|进度/i.test(f.name))
        if (guessed) {
          const keys =
            savedStatus && (savedCfg?.doneOptionKeys?.length ?? 0) > 0
              ? savedCfg!.doneOptionKeys!
              : guessDoneKeys(guessed.options)
          setStatusFieldId(guessed.id)
          setDoneOptionKeys(keys)
          persist({ statusFieldId: guessed.id, doneOptionKeys: keys })
        } else {
          setStatusFieldId('')
          setDoneOptionKeys([])
          persist({ statusFieldId: undefined, doneOptionKeys: [] })
        }

        const saved = configRef.current
        const savedDeps = (saved?.dependencyFieldIds ?? []).filter((id) =>
          list.some((f) => f.id === id),
        )
        if (savedDeps.length > 0) {
          setDepFieldIds(savedDeps)
          setParentFieldId(list.find((f) => f.id === saved?.parentFieldId)?.id ?? '')
          return
        }
        const dep = list.find((f) => /前置|依赖|先|block|prereq/i.test(f.name)) ?? list[0]
        const parent = list.find((f) => /父|parent|子/i.test(f.name) && f.id !== dep?.id)
        setDepFieldIds(dep ? [dep.id] : [])
        setParentFieldId(parent?.id ?? '')
        if (dep) {
          persist({
            tableId,
            dependencyFieldIds: [dep.id],
            parentFieldId: parent?.id,
          })
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取字段列表失败')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tableId, service, persist])

  const primaryDepFieldId = depFieldIds[0] ?? ''
  const parentField = fields.find((f) => f.id === parentFieldId)

  /** 构建设置：命名空间 + 多条依赖关系 + 可选父子关系 */
  const buildOptions = useCallback(
    () => ({
      namespace: tableId,
      dependencyRelations: depFieldIds.map((id) => ({
        relationId: id,
        label: fields.find((f) => f.id === id)?.name ?? id,
        role: depRole,
      })),
      parentFieldId: showParent && parentFieldId ? parentFieldId : undefined,
      parentRole,
      parentLabel: parentField?.name ?? '父子',
    }),
    [tableId, depFieldIds, fields, depRole, showParent, parentFieldId, parentRole, parentField],
  )

  const onReadProgress = useCallback((loaded: number, total?: number) => {
    setReadProgress(total ? `已读 ${loaded} / ${total} 条` : `已读 ${loaded} 条`)
  }, [])

  const analyze = useCallback(async () => {
    if (!tableId || depFieldIds.length === 0) return
    const seq = ++analyzeSeq.current
    setAnalyzing(true)
    setError(null)
    setReadProgress('')

    try {
      const tasks = await service.loadTasks(
        tableId,
        depFieldIds,
        showParent ? parentFieldId || undefined : undefined,
        {
          onProgress: onReadProgress,
          statusFieldId: statusFieldId || undefined,
          doneOptionKeys,
        },
      )
      if (seq !== analyzeSeq.current) return

      const data = service.buildGraphData(tasks, buildOptions())

      if (tasks.length === 0) throw new Error('这张表里没有任何记录。')

      if (data.nodes.length === 0) {
        const tableName = (id: string) => tables.find((t) => t.id === id)?.name ?? id
        const depName = fields.find((f) => f.id === depFieldIds[0])?.name ?? '关联字段'

        // 当前表画不出图时，先试着切回上次真的画出过关系的那张表。
        // 统计类表（比如「每日赏金统计」）经常就是这么个死胡同：
        // 表里有关联字段但一条都没填，留在原地只能看到一片空白。
        const lastGood = configRef.current?.lastGoodTableId
        if (
          lastGood &&
          lastGood !== tableId &&
          tables.some((t) => t.id === lastGood) &&
          (await service.tableHasRelations(lastGood))
        ) {
          if (seq !== analyzeSeq.current) return
          showToast(`「${tableName(tableId)}」没有关系数据，已切回「${tableName(lastGood)}」`)
          setTableId(lastGood)
          return
        }

        const filled = tasks.filter((t) => (t.prerequisites ?? []).length > 0).length
        throw new Error(
          filled === 0
            ? `「${tableName(tableId)}」有 ${tasks.length} 条记录，但字段「${depName}」一条都没有填。\n` +
              `先在表里给任务填上关联记录，再点刷新。`
            : `「${tableName(tableId)}」读到 ${tasks.length} 条记录，其中 ${filled} 条填了关联，` +
              `但都没有指向本表的有效记录，画不出关系。`,
        )
      }

      setRecordCount(tasks.length)
      setGraphData(data)
      setSelectedNode(null)
      setCollapse(EMPTY_COLLAPSE)
      // 记住「真的能画出图」的表，下次在别的表上扑空时可以切回来
      if (configRef.current?.lastGoodTableId !== tableId) persist({ lastGoodTableId: tableId })
    } catch (err) {
      if (seq !== analyzeSeq.current) return
      setError(err instanceof Error ? err.message : '分析失败')
      setGraphData(null)
    } finally {
      if (seq === analyzeSeq.current) {
        setAnalyzing(false)
        setReadProgress('')
      }
    }
  }, [tableId, depFieldIds, parentFieldId, showParent, service, buildOptions, onReadProgress, tables, fields, showToast, persist, statusFieldId, doneOptionKeys])

  /** 静默刷新：保留选中、折叠、缩放，只更新数据 */
  const silentAnalyze = useCallback(async () => {
    if (!tableId || depFieldIds.length === 0) return
    const seq = ++analyzeSeq.current
    try {
      const tasks = await service.loadTasks(
        tableId,
        depFieldIds,
        showParent ? parentFieldId || undefined : undefined,
        {
          onProgress: onReadProgress,
          statusFieldId: statusFieldId || undefined,
          doneOptionKeys,
        },
      )
      if (seq !== analyzeSeq.current) return
      const data = service.buildGraphData(tasks, buildOptions())
      setRecordCount(tasks.length)
      setGraphData(data)
      // 不清空选中与折叠；选中的节点被删了才清
      setSelectedNode((prev) => (prev && data.nodes.some((n) => n.id === prev.id) ? prev : null))
    } catch {
      // 静默失败，保留旧图
    } finally {
      if (seq === analyzeSeq.current) setReadProgress('')
    }
  }, [tableId, depFieldIds, parentFieldId, showParent, service, buildOptions, onReadProgress, statusFieldId, doneOptionKeys])

  // 实时监听表格变更
  useEffect(() => {
    if (!liveOn || !tableId || depFieldIds.length === 0 || isMockEnv) return
    const relevant = [...depFieldIds, parentFieldId].filter(Boolean) as string[]
    let timer: number | undefined
    const stop = watchTable({ tableId, relevantFieldIds: relevant }, () => {
      window.clearTimeout(timer)
      // 防抖 800ms：批量编辑只算一轮
      timer = window.setTimeout(() => setLiveTick((v) => v + 1), 800)
    })
    return () => {
      window.clearTimeout(timer)
      stop()
    }
  }, [liveOn, tableId, depFieldIds, parentFieldId, isMockEnv])

  useEffect(() => {
    if (liveTick === 0) return
    void silentAnalyze()
  }, [liveTick, silentAnalyze])

  const autoKey = useRef('')
  useEffect(() => {
    if (!tableId || depFieldIds.length === 0) return
    const key = `${tableId}|${depFieldIds.join(',')}|${showParent ? parentFieldId : ''}|${depRole}|${parentRole}|${statusFieldId}|${doneOptionKeys.join(',')}`
    if (autoKey.current === key) return
    autoKey.current = key
    void analyze()
  }, [tableId, depFieldIds, parentFieldId, showParent, depRole, parentRole, statusFieldId, doneOptionKeys, analyze])

  /** 折叠后的视图 */
  const viewData = useMemo(
    () => (graphData ? applyCollapse(graphData, collapse) : null),
    [graphData, collapse],
  )

  const toggleCollapse = useCallback((nodeId: string) => {
    setCollapse((prev) => {
      const kinds = graphData ? collapsibleKinds(graphData, nodeId) : { parent: false, dep: false }
      const key = kinds.parent ? 'parents' : 'deps'
      const nextSet = new Set(prev[key])
      if (nextSet.has(nodeId)) nextSet.delete(nodeId)
      else nextSet.add(nodeId)
      return { ...prev, [key]: nextSet }
    })
  }, [graphData])

  // ── 交互 ──
  const openInDida = useCallback(
    (node: GraphNode) => {
      // 之前这里只弹提示、并没有真的跳转，所以「双击」看起来毫无反应。
      // 现在真实创建一个 <a href="ticktick://..."> 并点击：用户手势触发的导航
      // 比 location 赋值更容易被宿主放行。
      const scheme = config.didaSearchScheme(node.rawTitle)
      const a = document.createElement('a')
      a.href = scheme
      a.rel = 'noreferrer'
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      showToast(`正在唤起滴答：${node.label}`)
    },
    [showToast],
  )

  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNode(node)
    // 侧栏收起时自动展开成窄条，让用户知道有东西可看
    if (sidebarCollapsed) setSidebarCollapsed(false)
  }, [sidebarCollapsed])

  const handleNodeDoubleClick = useCallback(
    (node: GraphNode) => {
      setSelectedNode(node)
      openInDida(node)
    },
    [openInDida],
  )

  /** 详情里点相关任务：选中并在画布居中 */
  const jumpToNode = useCallback(
    (nodeId: string) => {
      const target = (viewData?.data ?? graphData)?.nodes.find((n) => n.id === nodeId)
      if (!target) return
      setSelectedNode(target)
      setSideTab('details')
      graphApiRef.current?.focus(nodeId)
    },
    [viewData, graphData],
  )

  /** 点清单 / 标签：转为清单筛选 */
  const filterBy = useCallback((f: ChecklistFilter) => {
    setFilter(f)
    setSideTab('checklist')
  }, [])

  const handleLocate = useCallback((node: GraphNode) => {
    // 在清单里点任务只是「在图里定位它」，不要把人拽到详情页，
    // 否则想连着看几条就要来回切标签。
    setSelectedNode(node)
    graphApiRef.current?.focus(node.id)
  }, [])

  /** 整理前先清掉折叠：整理的语义是「恢复成一张完整、整齐的图」 */
  const handleRequestArrange = useCallback(() => {
    setCollapse(EMPTY_COLLAPSE)
  }, [])

  // ── 导出图片：整图 / 当前视图 ──
  const handleExport = useCallback(
    async (mode: 'full' | 'viewport') => {
      if (!graphData || exporting) return
      setExporting(true)
      const label = mode === 'full' ? '全图' : '当前视图'
      try {
        const dataUrl =
          mode === 'full'
            ? await graphApiRef.current?.captureFullImage()
            : await graphApiRef.current?.captureViewportImage()
        if (!dataUrl) throw new Error('图还没准备好')
        const size = await downloadPng(dataUrl, exportFileName(new Date(), label))
        showToast(
          size.scaled
            ? `已导出${label} ${size.width}×${size.height}（原图过大，已等比压缩）`
            : `已导出${label} ${size.width}×${size.height}`,
        )
      } catch (err) {
        showToast(`导出失败：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setExporting(false)
      }
    },
    [graphData, exporting, showToast],
  )

  // ── 全屏：只把插件自己的可用区域铺满，不开新窗口、不切标签页 ──
  const toggleImmersive = useCallback(() => {
    setImmersive((v) => !v)
  }, [])

  useEffect(() => {
    if (!immersive) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setImmersive(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [immersive])

  // 加载超过 10 秒仍未拿到数据：多半是在普通浏览器里直接打开了部署地址，
  // 宿主 SDK 永不 resolve。给一条提示，避免看起来像卡死。
  useEffect(() => {
    if (!loading) {
      setSlowHint(false)
      return
    }
    const timer = window.setTimeout(() => setSlowHint(true), 10000)
    return () => window.clearTimeout(timer)
  }, [loading])

  // ── 图例：关系（线型）+ 状态（颜色）分开表达 ──
  const relationStyles = useMemo(
    () => resolveRelationStyles(graphData?.relations ?? []),
    [graphData],
  )
  const legendRelations = useMemo(() => {
    const order = (id: string) => relationStyles.get(id)?.order ?? 999
    return [...(graphData?.relations ?? [])].sort(
      (a, b) => order(a.relationId) - order(b.relationId),
    )
  }, [graphData, relationStyles])

  // ── 渲染 ──
  if (loading) {    return (
      <div className="app-container">
        <div className="loading">
          <span className="spinner" /> {loadStage}
        </div>
        {slowHint && (
          <div className="loading-hint">
            如果这是在浏览器里直接打开的：插件需要在飞书多维表格中作为扩展打开，
            宿主未连接时这里会一直等待。
          </div>
        )}
      </div>
    )
  }

  const depField = fields.find((f) => f.id === primaryDepFieldId)
  const displayData = viewData?.data ?? graphData
  const collapsedCount = collapse.parents.size + collapse.deps.size
  const extraDepFields = fields.filter((f) => f.id !== primaryDepFieldId)
  const activeStatusField = statusFields.find((f) => f.id === statusFieldId)
  const hasStatus = Boolean(statusFieldId)
  const hasNeutralEdge = Boolean(displayData?.edges.some((e) => e.state === 'neutral'))

  return (
    <div className={`app-container ${immersive ? 'immersive' : ''}`} ref={appRef}>
      {/* ── 工具栏：主行 + 设置抽屉 ── */}
      <div className="toolbar">
        <label className="toolbar-item">
          <span>视图</span>
          <select value={layout} onChange={(e) => {
            const next = e.target.value as LayoutMode
            setLayout(next)
            persist({ layout: next })
          }}>
            {Object.entries(LAYOUT_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <button className="analyze-button" onClick={analyze} disabled={analyzing || !primaryDepFieldId}>
          {analyzing ? '分析中…' : '刷新'}
        </button>

        <div className="export-wrap">
          <button
            className={`icon-button text ${exportMenu ? 'active' : ''}`}
            onClick={() => setExportMenu((v) => !v)}
            disabled={!graphData || exporting}
            title="导出为 PNG"
            aria-label="导出图片"
          >
            {exporting ? '导出中…' : '导出'}
          </button>
          {exportMenu && (
            <div className="export-menu" role="menu">
              <button
                role="menuitem"
                onClick={() => {
                  setExportMenu(false)
                  void handleExport('full')
                }}
              >
                导出全图
                <span className="export-menu-hint">整张图，不受视口限制</span>
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setExportMenu(false)
                  void handleExport('viewport')
                }}
              >
                导出当前视图
                <span className="export-menu-hint">只截现在看得到的部分</span>
              </button>
            </div>
          )}
        </div>

        <button
          className={`icon-button text ${immersive ? 'active' : ''}`}
          onClick={toggleImmersive}
          disabled={!graphData}
          title="全屏：把插件区域铺满，不打开新窗口；Esc 退出"
          aria-label="全屏"
        >
          {immersive ? '退出' : '全屏'}
        </button>

        <button
          className={`icon-button text ${settingsOpen ? 'active' : ''}`}
          onClick={() => setSettingsOpen((v) => !v)}
          title="更多设置"
          aria-label="更多设置"
        >
          {settingsOpen ? '收起' : '更多'}
        </button>

        <label className="toolbar-live" title="表格数据变化时自动刷新">
          <input
            type="checkbox"
            checked={liveOn}
            onChange={(e) => setLiveOn(e.target.checked)}
          />
          <span>实时</span>
        </label>

        <span className="toolbar-stats">
          {analyzing && readProgress
            ? readProgress
            : displayData
              ? `${recordCount} 条 · ${displayData.nodes.length} 节点 · ${displayData.edges.length} 边`
              : ''}
        </span>

      </div>

      {/* ── 基础设置常驻：数据表 / 依赖字段（最常用的两项，不该藏在弹窗里） ── */}
      <div className="settings-bar">
        <label className="settings-row inline">
          <span>数据表</span>
          <select value={tableId} onChange={(e) => setTableId(e.target.value)} disabled={analyzing}>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-row inline">
          <span>依赖字段</span>
          <select
            value={primaryDepFieldId}
            onChange={(e) => {
              const next = [e.target.value, ...depFieldIds.slice(1).filter((id) => id !== e.target.value)]
              setDepFieldIds(next)
              persist({ dependencyFieldIds: next })
            }}
            disabled={analyzing || fields.length === 0}
          >
            {fields.length === 0 && <option value="">（无自关联字段）</option>}
            {fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>

        {settingsOpen && (
          <>
            <label className="settings-row inline">
              <span>箭头方向</span>
              <select
                value={depRole}
                onChange={(e) => {
                  const next = e.target.value as DependencyRole
                  setDepRole(next)
                  persist({ dependencyRole: next })
                }}
              >
                <option value="fieldIsPrereq">箭头指向：被引用者</option>
                <option value="fieldIsSuccessor">箭头指向：引用者</option>
              </select>
            </label>

            <label className="settings-row inline">
              <span>父子字段</span>
              <select
                value={parentFieldId}
                onChange={(e) => {
                  setParentFieldId(e.target.value)
                  persist({ parentFieldId: e.target.value || undefined })
                }}
                disabled={analyzing || fields.length === 0}
              >
                <option value="">无</option>
                {fields
                  .filter((f) => !depFieldIds.includes(f.id))
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
            </label>

            <label className="settings-row inline checkbox">
              <input
                type="checkbox"
                checked={showParent}
                onChange={(e) => {
                  setShowParent(e.target.checked)
                  persist({ showParent: e.target.checked })
                }}
              />
              <span>显示父子关系</span>
            </label>

            <label className="settings-row inline">
              <span>完成状态</span>
              <select
                value={statusFieldId}
                onChange={(e) => {
                  const next = e.target.value
                  const field = statusFields.find((f) => f.id === next)
                  const keys = field ? guessDoneKeys(field.options) : []
                  setStatusFieldId(next)
                  setDoneOptionKeys(keys)
                  persist({ statusFieldId: next || undefined, doneOptionKeys: keys })
                }}
                disabled={analyzing}
              >
                <option value="">不用状态（中性）</option>
                {statusFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>

            {statusFieldId && (
              <div className="settings-row inline dep-extra">
                <span>算完成</span>
                {activeStatusField && activeStatusField.options.length > 0 ? (
                  activeStatusField.options.map((option) => {
                    const checked = doneOptionKeys.includes(option.id || option.name)
                    return (
                      <label key={option.id || option.name} className="check-inline">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const keys = new Set(doneOptionKeys)
                            for (const key of [option.id, option.name]) {
                              if (!key) continue
                              if (e.target.checked) keys.add(key)
                              else keys.delete(key)
                            }
                            const next = [...keys]
                            setDoneOptionKeys(next)
                            persist({ doneOptionKeys: next })
                          }}
                        />
                        <span>{option.name}</span>
                      </label>
                    )
                  })
                ) : (
                  <span className="settings-note">这个字段没有选项，勾不了</span>
                )}
              </div>
            )}

            {extraDepFields.length > 0 && (
              <div className="settings-row inline dep-extra">
                <span>同时显示</span>
                {extraDepFields.map((f) => (
                  <label key={f.id} className="check-inline">
                    <input
                      type="checkbox"
                      checked={depFieldIds.includes(f.id)}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...depFieldIds, f.id].filter((v, i, a) => a.indexOf(v) === i)
                          : depFieldIds.filter((id) => id !== f.id)
                        setDepFieldIds(next)
                        persist({ dependencyFieldIds: next })
                      }}
                    />
                    <span>{f.name}</span>
                  </label>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {error && (
        <div className="toolbar-error">
          <span>{error}</span>
          <button className="confirm-btn" onClick={analyze}>
            重试
          </button>
          <details className="diag">
            <summary>诊断信息</summary>
            <div className="diag-body">
              <div>运行环境：{diag.inHost ? '飞书宿主 iframe' : '独立窗口（没有连上宿主）'}</div>
              <div>
                数据表（{diag.tables.length}）：{diag.tables.join('、') || '—'}
              </div>
              <div>当前表：{tableId || '—'}</div>
              <div>
                关联字段（{diag.linkFields.length}）：
                {diag.linkFields.length === 0
                  ? '—'
                  : diag.linkFields
                      .map((f) => `${f.name} → ${f.selfLink ? '本表' : f.targetTableId || '未知表'}`)
                      .join('、')}
              </div>
              <div>其中指向本表：{diag.linkFields.filter((f) => f.selfLink).length} 个</div>
            </div>
          </details>
        </div>
      )}

      {graphData ? (
        <div className="graph-wrapper">
          <div className="graph-main">
            <DependencyGraph
              ref={graphApiRef}
              data={displayData!}
              layout={layout}
              selectedId={selectedNode?.id ?? null}
              onNodeClick={handleNodeClick}
              onNodeDoubleClick={handleNodeDoubleClick}
              onToggleCollapse={toggleCollapse}
              collapsible={(id) => {
                if (!graphData) return false
                const k = collapsibleKinds(graphData, id)
                return k.parent || k.dep
              }}
              onCanvasClick={() => setSelectedNode(null)}
              onCanvasDoubleClick={() => setSidebarCollapsed(true)}
              onZoomChange={setZoom}
              onRequestArrange={handleRequestArrange}
              renderKey={`${tableId}|${depFieldIds.join(',')}|${parentFieldId}|${showParent}|${depRole}|${parentRole}`}
            />
            <div className="graph-statusbar">
              <span className="statusbar-left">
                {depField ? `依赖：${depField.name}` : ''}
                {depFieldIds.length > 1 && ` 等 ${depFieldIds.length} 个字段`}
                {showParent && parentField ? `｜父子：${parentField.name}` : ''}
                {activeStatusField ? `｜状态：${activeStatusField.name}` : '｜状态：中性'}
                {collapsedCount > 0 && (
                  <button className="reset-collapse" onClick={() => setCollapse(EMPTY_COLLAPSE)}>
                    展开全部
                  </button>
                )}
              </span>
              <span>
                {zoom < WHEEL_ZOOM_MIN - 0.001 ? (
                  <span className="zoom-floor-hint">整体视图</span>
                ) : zoom <= WHEEL_ZOOM_MIN + 0.01 ? (
                  <span className="zoom-floor-hint">最小缩放</span>
                ) : null}
                {Math.round(zoom * 100)}%
              </span>
            </div>
          </div>

          {/* 侧栏：可收起 */}
          <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
            {sidebarCollapsed ? (
              <div className="sidebar-rail">
                <button
                  className="rail-btn"
                  title="展开清单"
                  onClick={() => {
                    setSideTab('checklist')
                    setSidebarCollapsed(false)
                  }}
                >
                  清单
                </button>
                <button
                  className={`rail-btn ${selectedNode ? 'has-dot' : ''}`}
                  title="展开详情"
                  onClick={() => {
                    setSideTab('details')
                    setSidebarCollapsed(false)
                  }}
                >
                  详情
                </button>
                <button
                  className="rail-btn expand"
                  title="展开侧栏"
                  onClick={() => setSidebarCollapsed(false)}
                >
                  ‹
                </button>
              </div>
            ) : (
              <>
                <div className="sidebar-tabs">
                  <button
                    className={`sidebar-tab ${sideTab === 'checklist' ? 'active' : ''}`}
                    onClick={() => setSideTab('checklist')}
                  >
                    清单
                  </button>
                  <button
                    className={`sidebar-tab ${sideTab === 'details' ? 'active' : ''}`}
                    onClick={() => setSideTab('details')}
                  >
                    详情
                  </button>
                  <button
                    className="sidebar-collapse"
                    title="收起侧栏"
                    aria-label="收起侧栏"
                    onClick={() => {
                      setSidebarCollapsed(true)
                      persist({ sidebarCollapsed: true })
                    }}
                  >
                    ›
                  </button>
                </div>
                <div className="sidebar-body">
                  {sideTab === 'checklist' ? (
                    <ChecklistPanel
                      data={displayData!}
                      selectedId={selectedNode?.id ?? null}
                      onLocate={handleLocate}
                      filter={filter}
                      onFilterChange={setFilter}
                      hasStatus={hasStatus}
                    />
                  ) : (
                    <DetailsPanel
                      node={selectedNode}
                      data={displayData}
                      onOpenInDida={openInDida}
                      onJumpToNode={jumpToNode}
                      onFilterBy={filterBy}
                      onToast={showToast}
                    />
                  )}
                </div>
                <div className="sidebar-legend">
                  {legendRelations.map((r) => {
                    const style = relationStyles.get(r.relationId)
                    const dash = style ? lineDashCss(style) : 'solid'
                    return (
                      <div className="legend-item" key={r.relationId}>
                        <span className={`legend-edge rel-${dash}`} />
                        {r.label}
                      </div>
                    )
                  })}
                  <div className="legend-item">
                    <span className="legend-edge dep-done" />
                    可推进：前置已完成
                  </div>
                  <div className="legend-item">
                    <span className="legend-edge dep-todo" />
                    阻塞中：前置未完成
                  </div>
                  <div className="legend-item">
                    <span className="legend-edge dep-idle" />
                    已失效：本任务已完成
                  </div>
                  {hasNeutralEdge && (
                    <div className="legend-item">
                      <span className="legend-edge dep-neutral" />
                      状态未知：未配置完成状态
                    </div>
                  )}
                </div>
              </>
            )}
          </aside>
        </div>
      ) : (
        !error && (
          <div className="empty-state">
            <p>{analyzing ? '正在读取表格…' : '选择数据表和字段后自动分析。'}</p>
            {fields.length === 0 && tables.length > 0 && (
              <div className="empty-hint">
                {diag.linkFields.length > 0 ? (
                  <>
                    <p>
                      这张表有 {diag.linkFields.length} 个关联字段，但都指向**其它表**：
                      插件只支持「关联到本表自己」的字段，所以画不出关系图。
                    </p>
                    <p>
                      字段明细：
                      {diag.linkFields
                        .map((f) => `${f.name} → ${f.targetTableId || '未知表'}`)
                        .join('、')}
                    </p>
                  </>
                ) : (
                  <>
                    <p>当前表没有任何关联字段，无法表达任务关系。</p>
                    <p>
                      需要建一个关联到本表的字段，例如「前置」：记录 B 的「前置」里放 A，表示 A 完成后才能做 B。
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        )
      )}

      {immersive && (
        <button
          className="immersive-exit"
          onClick={() => setImmersive(false)}
          title="退出全屏（Esc）"
        >
          退出全屏
        </button>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

export default App
