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
import { WHEEL_ZOOM_MIN } from './components/graphZoom'
import { resolveRelationStyles, lineDashCss } from './services/relationStyles'
import { downloadPng, exportFileName } from './services/exportImage'
import {
  requestFullscreen,
  exitFullscreen,
  isFullscreen,
  onFullscreenChange,
} from './services/fullscreen'
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
  /** iframe 内沉浸模式（宿主不允许真全屏时的兜底） */
  const [immersive, setImmersive] = useState(false)
  const [nativeFull, setNativeFull] = useState(false)

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
    window.setTimeout(() => setToast(null), 3200)
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
    setDepFieldIds([])
    setParentFieldId('')
    setGraphData(null)
    ;(async () => {
      try {
        const list = await service.listLinkFields(tableId)
        if (cancelled) return
        setFields(list)

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
        { onProgress: onReadProgress },
      )
      if (seq !== analyzeSeq.current) return

      const data = service.buildGraphData(tasks, buildOptions())

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
      if (seq === analyzeSeq.current) {
        setAnalyzing(false)
        setReadProgress('')
      }
    }
  }, [tableId, depFieldIds, parentFieldId, showParent, service, buildOptions, onReadProgress])

  /** 静默刷新：保留选中、折叠、缩放，只更新数据 */
  const silentAnalyze = useCallback(async () => {
    if (!tableId || depFieldIds.length === 0) return
    const seq = ++analyzeSeq.current
    try {
      const tasks = await service.loadTasks(
        tableId,
        depFieldIds,
        showParent ? parentFieldId || undefined : undefined,
        { onProgress: onReadProgress },
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
  }, [tableId, depFieldIds, parentFieldId, showParent, service, buildOptions, onReadProgress])

  // 实时监听表格变更
  useEffect(() => {
    if (!liveOn || !tableId || depFieldIds.length === 0 || service.isMock) return
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
  }, [liveOn, tableId, depFieldIds, parentFieldId, service.isMock])

  useEffect(() => {
    if (liveTick === 0) return
    void silentAnalyze()
  }, [liveTick, silentAnalyze])

  const autoKey = useRef('')
  useEffect(() => {
    if (!tableId || depFieldIds.length === 0) return
    const key = `${tableId}|${depFieldIds.join(',')}|${showParent ? parentFieldId : ''}|${depRole}|${parentRole}`
    if (autoKey.current === key) return
    autoKey.current = key
    void analyze()
  }, [tableId, depFieldIds, parentFieldId, showParent, depRole, parentRole, analyze])

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

  /** 整理前先清掉折叠：整理的语义是「恢复成一张完整、整齐的图」 */
  const handleRequestArrange = useCallback(() => {
    setCollapse(EMPTY_COLLAPSE)
  }, [])

  // ── 导出图片 ──
  const handleExport = useCallback(async () => {
    if (!graphData || exporting) return
    setExporting(true)
    try {
      const dataUrl = await graphApiRef.current?.captureFullImage()
      if (!dataUrl) throw new Error('图还没准备好')
      const size = await downloadPng(dataUrl, exportFileName())
      showToast(
        size.scaled
          ? `已导出 ${size.width}×${size.height}（原图过大，已等比压缩）`
          : `已导出 ${size.width}×${size.height}`,
      )
    } catch (err) {
      showToast(`导出失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setExporting(false)
    }
  }, [graphData, exporting, showToast])

  // ── 全屏 / 沉浸模式 ──
  useEffect(() => {
    const off = onFullscreenChange(() => setNativeFull(isFullscreen()))
    return off
  }, [])

  const toggleFullscreen = useCallback(async () => {
    if (nativeFull) {
      await exitFullscreen()
      return
    }
    if (immersive) {
      setImmersive(false)
      return
    }
    const el = appRef.current
    if (el && (await requestFullscreen(el))) return
    // 宿主 iframe 没给 allowfullscreen 时走这里：至少把可用区域用满
    setImmersive(true)
    showToast('当前环境不允许真全屏，已切换为沉浸模式（按 Esc 退出）')
  }, [nativeFull, immersive, showToast])

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
  const isImmersive = immersive || nativeFull

  return (
    <div className={`app-container ${isImmersive ? 'immersive' : ''}`} ref={appRef}>
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

        <button
          className="icon-button text"
          onClick={handleExport}
          disabled={!graphData || exporting}
          title="导出整张图为 PNG（不受当前视口限制）"
          aria-label="导出图片"
        >
          {exporting ? '导出中…' : '导出'}
        </button>

        <button
          className={`icon-button text ${isImmersive ? 'active' : ''}`}
          onClick={toggleFullscreen}
          disabled={!graphData}
          title="全屏（宿主不允许时降级为沉浸模式，Esc 退出）"
          aria-label="全屏"
        >
          {isImmersive ? '退出' : '全屏'}
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
              onRequestArrange={handleRequestArrange}
              renderKey={`${tableId}|${depFieldIds.join(',')}|${parentFieldId}|${showParent}|${depRole}|${parentRole}`}
            />
            <div className="graph-statusbar">
              <span className="statusbar-left">
                {depField ? `依赖：${depField.name}` : ''}
                {depFieldIds.length > 1 && ` 等 ${depFieldIds.length} 个字段`}
                {showParent && parentField ? `｜父子：${parentField.name}` : ''}
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

      {isImmersive && (
        <button
          className="immersive-exit"
          onClick={() => {
            if (nativeFull) void exitFullscreen()
            setImmersive(false)
          }}
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
