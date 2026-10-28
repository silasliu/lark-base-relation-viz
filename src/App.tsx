import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { DependencyGraph } from './components/DependencyGraph'
import { ChecklistPanel } from './components/ChecklistPanel'
import { DetailsPanel } from './components/DetailsPanel'
import { BaseDataService } from './services/BaseDataService'
import { loadConfig, saveConfig, type PersistedConfig, type DependencyRole, type ParentRole } from './services/ConfigStore'
import { applyCollapse, collapsibleKinds, EMPTY_COLLAPSE, type CollapseState } from './services/collapse'
import { watchTable } from './services/DataWatcher'
import type {
  GraphNode,
  GraphData,
  TableOption,
  LinkFieldOption,
  LayoutMode,
  GraphApi,
} from './types'
import { LAYOUT_LABELS } from './components/graphShapes'
import { ZOOM_MIN } from './components/graphZoom'
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
  const [depFieldId, setDepFieldId] = useState('')
  const [parentFieldId, setParentFieldId] = useState('')
  const [depRole, setDepRole] = useState<DependencyRole>('fieldIsPrereq')
  const [parentRole, setParentRole] = useState<ParentRole>('fieldIsParent')
  const [showParent, setShowParent] = useState(true)

  const [graphData, setGraphData] = useState<GraphData | null>(null)
  const [layout, setLayout] = useState<LayoutMode>('dagre-tb')
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const graphApiRef = useRef<GraphApi>(null)

  const [recordCount, setRecordCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadStage, setLoadStage] = useState('正在连接多维表格…')
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

  const [collapse, setCollapse] = useState<CollapseState>(EMPTY_COLLAPSE)
  const [liveTick, setLiveTick] = useState(0)
  const [liveOn, setLiveOn] = useState(true)

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
    window.setTimeout(() => setToast(null), 2800)
  }, [])

  // ── 启动 ──
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const saved = await loadConfig()
        configRef.current = saved
        if (cancelled) return
        setLayout(saved.layout)
        setDepRole(saved.dependencyRole)
        setParentRole(saved.parentRole)
        setShowParent(saved.showParent ?? true)
        // 窄屏（飞书侧边栏）下默认收起，避免侧栏盖住画布；宽屏沿用用户选择
        const isNarrow = window.innerWidth < 620
        setSidebarCollapsed(isNarrow ? true : (saved.sidebarCollapsed ?? false))

        setLoadStage('正在读取数据表…')
        const list = await service.listTables()
        if (cancelled) return
        setTables(list)
        if (list.length === 0) {
          setError('这个 Base 里还没有数据表。')
          return
        }
        const preferred =
          saved.tableId && list.some((t) => t.id === saved.tableId) ? saved.tableId : list[0].id
        setTableId(preferred)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取数据表列表失败')
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
    setDepFieldId('')
    setParentFieldId('')
    setGraphData(null)
    ;(async () => {
      try {
        const list = await service.listLinkFields(tableId)
        if (cancelled) return
        setFields(list)

        const saved = configRef.current
        const savedDep = list.find((f) => f.id === saved?.dependencyFieldId)
        if (savedDep) {
          setDepFieldId(savedDep.id)
          setParentFieldId(list.find((f) => f.id === saved?.parentFieldId)?.id ?? '')
          return
        }
        const dep = list.find((f) => /前置|依赖|先|block|prereq/i.test(f.name)) ?? list[0]
        const parent = list.find((f) => /父|parent|子/i.test(f.name) && f.id !== dep?.id)
        setDepFieldId(dep?.id ?? '')
        setParentFieldId(parent?.id ?? '')
        if (dep) {
          persist({
            tableId,
            dependencyFieldId: dep.id,
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

  const analyze = useCallback(async () => {
    if (!tableId || !depFieldId) return
    const seq = ++analyzeSeq.current
    setAnalyzing(true)
    setError(null)

    try {
      const tasks = await service.loadTasks(
        tableId,
        depFieldId,
        showParent ? parentFieldId || undefined : undefined,
      )
      if (seq !== analyzeSeq.current) return

      const data = service.buildGraphData(tasks, { dependencyRole: depRole, parentRole })

      if (tasks.length === 0) throw new Error('这张表里没有任何记录。')
      if (data.nodes.length === 0) {
        throw new Error(
          `读到 ${tasks.length} 条记录，但没有任何${showParent ? '依赖或父子' : '依赖'}关系，没有可绘制的图。\n` +
            `可以换一个字段，或在表里给任务填上关联记录。`,
        )
      }

      setRecordCount(tasks.length)
      setGraphData(data)
      setSelectedNode(null)
      setCollapse(EMPTY_COLLAPSE)
    } catch (err) {
      if (seq !== analyzeSeq.current) return
      setError(err instanceof Error ? err.message : '分析失败')
      setGraphData(null)
    } finally {
      if (seq === analyzeSeq.current) setAnalyzing(false)
    }
  }, [tableId, depFieldId, parentFieldId, showParent, depRole, parentRole, service])

  /** 静默刷新：保留选中、折叠、缩放，只更新数据 */
  const silentAnalyze = useCallback(async () => {
    if (!tableId || !depFieldId) return
    const seq = ++analyzeSeq.current
    try {
      const tasks = await service.loadTasks(
        tableId,
        depFieldId,
        showParent ? parentFieldId || undefined : undefined,
      )
      if (seq !== analyzeSeq.current) return
      const data = service.buildGraphData(tasks, { dependencyRole: depRole, parentRole })
      setRecordCount(tasks.length)
      setGraphData(data)
      // 不清空选中与折叠；选中的节点被删了才清
      setSelectedNode((prev) => (prev && data.nodes.some((n) => n.id === prev.id) ? prev : null))
    } catch {
      // 静默失败，保留旧图
    }
  }, [tableId, depFieldId, parentFieldId, showParent, depRole, parentRole, service])

  // 实时监听表格变更
  useEffect(() => {
    if (!liveOn || !tableId || !depFieldId || service.isMock) return
    const relevant = [depFieldId, parentFieldId].filter(Boolean) as string[]
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
  }, [liveOn, tableId, depFieldId, parentFieldId, service.isMock])

  useEffect(() => {
    if (liveTick === 0) return
    void silentAnalyze()
  }, [liveTick, silentAnalyze])

  const autoKey = useRef('')
  useEffect(() => {
    if (!tableId || !depFieldId) return
    const key = `${tableId}|${depFieldId}|${showParent ? parentFieldId : ''}|${depRole}|${parentRole}`
    if (autoKey.current === key) return
    autoKey.current = key
    void analyze()
  }, [tableId, depFieldId, parentFieldId, showParent, depRole, parentRole, analyze])

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
    setSelectedNode(node)
    setSideTab('details')
    graphApiRef.current?.focus(node.id)
  }, [])

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

  const depField = fields.find((f) => f.id === depFieldId)
  const parentField = fields.find((f) => f.id === parentFieldId)
  const displayData = viewData?.data ?? graphData
  const collapsedCount = collapse.parents.size + collapse.deps.size

  return (
    <div className="app-container">
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

        <button className="analyze-button" onClick={analyze} disabled={analyzing || !depFieldId}>
          {analyzing ? '分析中…' : '刷新'}
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
          {displayData
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
            value={depFieldId}
            onChange={(e) => {
              setDepFieldId(e.target.value)
              persist({ dependencyFieldId: e.target.value })
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
                  .filter((f) => f.id !== depFieldId)
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
          </>
        )}
      </div>

      {error && (
        <div className="toolbar-error">
          <span>{error}</span>
          <button className="confirm-btn" onClick={analyze}>
            重试
          </button>
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
              onZoomChange={setZoom}
              renderKey={`${tableId}|${depFieldId}|${parentFieldId}|${showParent}|${depRole}|${parentRole}`}
            />
            <div className="graph-statusbar">
              <span className="statusbar-left">
                {depField ? `依赖：${depField.name}` : ''}
                {showParent && parentField ? `｜父子：${parentField.name}` : ''}
                {collapsedCount > 0 && (
                  <button className="reset-collapse" onClick={() => setCollapse(EMPTY_COLLAPSE)}>
                    展开全部
                  </button>
                )}
              </span>
              <span>
                {zoom <= ZOOM_MIN + 0.01 && <span className="zoom-floor-hint">最小缩放</span>}
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
                  {showParent && (
                    <div className="legend-item">
                      <span className="legend-edge parent" />
                      父子关系
                    </div>
                  )}
                  <div className="legend-item">
                    <span className="legend-node terminal" />
                    无前置
                  </div>
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
                <p>当前表没有「自关联字段」，无法表达任务关系。</p>
                <p>
                  需要建一个关联到本表的字段，例如「前置」：记录 B 的「前置」里放 A，表示 A 完成后才能做 B。
                </p>
              </div>
            )}
          </div>
        )
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

export default App
