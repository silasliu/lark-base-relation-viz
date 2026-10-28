import React, { useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from 'react'
import G6, { Graph } from '@antv/g6'
import type { GraphNode, GraphData, LayoutMode, GraphApi } from '../types'
import { toG6Data, nodeDisplayLines, nodeMetricsFor } from './nodeMetrics'
import { layoutConfig, registerShapes, isVerticalAxis, separateOverlaps, applyRelationStyles, edgeBaseWidth } from './graphShapes'
import { attachWheelZoom, createZoomReporter, WHEEL_ZOOM_MIN, FIT_ZOOM_MIN, ZOOM_MAX } from './graphZoom'
import './DependencyGraph.css'

interface DependencyGraphProps {
  data: GraphData
  layout: LayoutMode
  selectedId?: string | null
  onNodeClick?: (node: GraphNode) => void
  onNodeDoubleClick?: (node: GraphNode) => void
  onToggleCollapse?: (nodeId: string) => void
  collapsible?: (nodeId: string) => boolean
  onCanvasClick?: () => void
  onZoomChange?: (zoom: number) => void
  /** 「整理」时先让上层清掉折叠状态，再由本组件重新布局 */
  onRequestArrange?: () => void
  /** 变化时重建整张图（换表 / 刷新） */
  renderKey?: string
}

/** 这些布局的半径/引力中心依赖画布尺寸，changeSize 后需要重排 */
function layoutIsSizeDependent(mode: LayoutMode): boolean {
  return mode === 'circular' || mode === 'radial' || mode === 'force'
}

/** 原地切换节点紧凑模式：不销毁 graph，保留位置与状态 */
function applyNodeMetrics(graph: Graph, compact: boolean): void {
  const metrics = nodeMetricsFor(compact)
  graph.setAutoPaint(false)
  try {
    for (const item of graph.getNodes()) {
      const node = (item.getModel() as any).display?.node as GraphNode | undefined
      if (!node) continue
      const { lines, width, height } = nodeDisplayLines(node, metrics)
      graph.updateItem(
        item,
        { compact, size: [width, height], display: { lines, width, height, node } },
        false,
      )
    }
  } finally {
    graph.setAutoPaint(true)
    graph.paint()
  }
}

/**
 * 适配整张图。
 *
 * 两个关键点：
 * 1. 用 FIT_ZOOM_MIN（0.02）而不是手动下限 0.2 —— 「显示全部」的职责是
 *    把整张图塞进视口，大图必须允许比手动缩得更小，否则永远差一块。
 * 2. 小图不放大超过 100%：12px 字放大只会发虚，图也会显得空荡。
 *
 * G6 v4 的 fitView 在算出的比例小于 minZoom 时仍会先调用 zoom，
 * 于是控制台出现 "zoom failed, ratio out of range"。这里自己算绝对比例再 zoomTo。
 */
function fitGraph(graph: Graph, padding = 28): boolean {
  const group = graph.get('group') as any
  if (!group) return false
  group.resetMatrix()

  const bbox = group.getCanvasBBox()
  if (!bbox || !Number.isFinite(bbox.width) || !Number.isFinite(bbox.height)) return false
  if (bbox.width <= 0 || bbox.height <= 0) return false

  const width = graph.getWidth()
  const height = graph.getHeight()
  if (width <= 1 || height <= 1) return false

  const availableWidth = Math.max(1, width - padding * 2)
  const availableHeight = Math.max(1, height - padding * 2)
  const raw = Math.min(availableWidth / bbox.width, availableHeight / bbox.height)
  const zoom = Math.min(1, Math.max(FIT_ZOOM_MIN, raw))

  const viewCenter = { x: width / 2, y: height / 2 }
  const groupCenter = { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 }

  graph.translate(viewCenter.x - groupCenter.x, viewCenter.y - groupCenter.y)
  graph.zoomTo(zoom, viewCenter)
  return true
}

/** 按 id 做 diff 同步，避免全量重建 */
function syncGraphData(graph: Graph, data: GraphData, compact: boolean, vertical: boolean): boolean {
  // 样式注册表必须在建模型之前刷新：draw() 会立刻按 relationId 取线型与箭头
  applyRelationStyles(data.relations)
  const g6 = toG6Data(data, compact)
  const axis = vertical ? 'vertical' : 'horizontal'
  const wantNodes = new Map(g6.nodes.map((n) => [n.id, n]))
  // 不写死 sourceAnchor/targetAnchor：task-node.getLinkPoint 会按两节点相对位置动态选锚点。
  // 写死会让线从侧边斜着插进节点，箭头落到角上。
  const wantEdges = new Map(g6.edges.map((e) => [e.id, { ...e, axis }]))

  const existingNodeIds = new Set(graph.getNodes().map((n) => n.getModel().id))
  const existingEdgeIds = new Set(graph.getEdges().map((e) => e.getModel().id))

  // 先判结构变化（决定是否需要重排）
  const addedNodes = [...wantNodes.keys()].filter((id) => !existingNodeIds.has(id))
  const removedNodes = [...existingNodeIds].filter((id) => !wantNodes.has(id))
  const addedEdges = [...wantEdges.keys()].filter((id) => !existingEdgeIds.has(id))
  const removedEdges = [...existingEdgeIds].filter((id) => !wantEdges.has(id))
  const structureChanged =
    addedNodes.length > 0 || removedNodes.length > 0 || addedEdges.length > 0 || removedEdges.length > 0

  if (!structureChanged) {
    // 只更新内容（例如状态变了导致颜色变化），不动布局
    let touched = false
    for (const [id, model] of wantNodes) {
      const item = graph.findById(id)
      if (!item) continue
      const prev = item.getModel() as any
      if (
        !prev.size ||
        prev.size[0] !== model.size[0] ||
        prev.size[1] !== model.size[1] ||
        prev.compact !== model.compact
      ) {
        graph.updateItem(item, { size: model.size, display: model.display, compact: model.compact }, false)
        touched = true
      }
    }
    if (touched) graph.paint()
    return false
  }

  const center = graph.getGraphCenterPoint()
  graph.setAutoPaint(false)
  try {
    for (const id of removedNodes) {
      const item = graph.findById(id)
      if (item) graph.removeItem(item, false)
    }
    for (const [id, model] of wantNodes) {
      if (existingNodeIds.has(id)) {
        const item = graph.findById(id)!
        graph.updateItem(item, { size: model.size, display: model.display, compact: model.compact }, false)
      } else {
        // 新节点先放在视口中心，布局会覆盖坐标
        graph.addItem('node', { ...model, x: center.x, y: center.y }, false)
      }
    }
    for (const id of removedEdges) {
      const item = graph.findById(id)
      if (item) graph.removeItem(item, false)
    }
    for (const [id, model] of wantEdges) {
      const existing = graph.findById(id)
      if (existing) {
        // 只改颜色/主轴时也要发出更新：锚点由 getLinkPoint 动态计算，
        // 但主轴与颜色变化仍需要触发重绘
        const prev = existing.getModel() as Record<string, unknown>
        if (
          prev.prerequisiteComplete !== model.prerequisiteComplete ||
          prev.sourceComplete !== model.sourceComplete ||
          prev.axis !== model.axis
        ) {
          graph.updateItem(existing, model, false)
        }
      } else {
        graph.addItem('edge', model, false)
      }
    }
  } finally {
    graph.setAutoPaint(true)
  }
  return true
}

export const DependencyGraph = forwardRef<GraphApi, DependencyGraphProps>(
  (
    { data, layout, selectedId, onNodeClick, onNodeDoubleClick, onToggleCollapse, collapsible, onCanvasClick, onZoomChange, onRequestArrange, renderKey },
    ref,
  ) => {
    const containerRef = useRef<HTMLDivElement>(null)
    const graphRef = useRef<Graph | null>(null)
    const clickRef = useRef(onNodeClick)
    clickRef.current = onNodeClick
    const dblClickRef = useRef(onNodeDoubleClick)
    dblClickRef.current = onNodeDoubleClick
    const toggleRef = useRef(onToggleCollapse)
    toggleRef.current = onToggleCollapse
    const collapsibleRef = useRef(collapsible)
    collapsibleRef.current = collapsible
    const canvasClickRef = useRef(onCanvasClick)
    canvasClickRef.current = onCanvasClick
    const zoomRef = useRef(onZoomChange)
    zoomRef.current = onZoomChange

    const dataRef = useRef(data)
    dataRef.current = data
    const layoutRef = useRef(layout)
    layoutRef.current = layout
    const verticalRef = useRef(isVerticalAxis(layout))
    const compactRef = useRef(false)
    /** 是否做过首次 fitView */
    const didFitRef = useRef(false)
    /**
     * 用户是否手动缩放过。
     * 没手动缩放过时，容器尺寸变化要重新适配：否则「第一次 fit 发生在容器还没定型时」
     * 会让整张图一直卡在错误比例上，看起来就是「显示不全」。
     */
    const userZoomRef = useRef(false)
    /** 缩放上报节流 */
    const zoomReporterRef = useRef<ReturnType<typeof createZoomReporter> | null>(null)
    if (!zoomReporterRef.current) {
      zoomReporterRef.current = createZoomReporter((z) => zoomRef.current?.(z))
    }

    /** 适配请求的防抖定时器：布局可能连发多次，只在最后一次之后适配 */
    const fitTimerRef = useRef<number | null>(null)

    const runFit = useCallback(() => {
      const graph = graphRef.current
      if (!graph || graph.get('destroyed')) return
      fitGraph(graph)
      zoomReporterRef.current?.report(graph.getZoom())
    }, [])

    /**
     * 延迟适配。为什么必须防抖：
     * 「整理」会先清折叠（触发一次数据同步布局），再触发一次重新布局，
     * 两次都会发出 afterlayout。每次都立刻 fit 会停在中间态，看起来就是「显示不全」。
     */
    const scheduleFit = useCallback(
      (delay = 260) => {
        if (fitTimerRef.current) window.clearTimeout(fitTimerRef.current)
        fitTimerRef.current = window.setTimeout(() => {
          fitTimerRef.current = null
          runFit()
        }, delay)
      },
      [runFit],
    )

    /**
     * 整理：重新执行当前布局 + 消除重叠 + 适配全图。
     * 与「显示全部」的区别：显示全部只动视口，整理会动布局。
     */
    const arrange = useCallback(() => {
      const graph = graphRef.current
      if (!graph || graph.get('destroyed')) return

      let finished = false
      let timer = 0
      const finish = () => {
        if (finished) return
        finished = true
        graph.off('afterlayout', onLayout)
        window.clearTimeout(timer)
        if (graph.get('destroyed')) return
        separateOverlaps(graph)
        // 布局刚结束，等一帧再算包围盒，避免拿到半更新的坐标
        scheduleFit(60)
      }
      const onLayout = () => finish()

      graph.on('afterlayout', onLayout)
      // 兜底：个别布局不触发 afterlayout，也不能让「整理」点了没反应
      timer = window.setTimeout(finish, 900)
      graph.updateLayout(layoutConfig(layoutRef.current))
    }, [scheduleFit])

    useImperativeHandle(ref, () => ({
      focus(nodeId: string) {
        const graph = graphRef.current
        if (!graph || graph.get('destroyed')) return
        // 用户主动定位节点后，不再让 resize 自动重置视野
        userZoomRef.current = true
        graph.focusItem(nodeId, true, { easing: 'easeCubic', duration: 300 })
        // getGraphCenterPoint() 是模型坐标，不能直接当 zoomTo 的中心
        if (graph.getZoom() < WHEEL_ZOOM_MIN + 0.05) {
          graph.zoomTo(0.9, { x: graph.getWidth() / 2, y: graph.getHeight() / 2 })
        }
        zoomReporterRef.current?.report(graph.getZoom())
      },
      fit() {
        runFit()
      },
      arrange() {
        arrange()
      },
      captureFullImage() {
        const graph = graphRef.current
        if (!graph || graph.get('destroyed')) {
          return Promise.reject(new Error('图还没准备好'))
        }
        return new Promise<string>((resolve, reject) => {
          let settled = false
          const timer = window.setTimeout(() => {
            if (settled) return
            settled = true
            reject(new Error('生成图片超时'))
          }, 20000)
          try {
            graph.toFullDataURL(
              (res: string) => {
                if (settled) return
                settled = true
                window.clearTimeout(timer)
                if (res) resolve(res)
                else reject(new Error('导出的图片为空'))
              },
              'image/png',
              { backgroundColor: '#ffffff', padding: 32 },
            )
          } catch (err) {
            if (settled) return
            settled = true
            window.clearTimeout(timer)
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })
      },
    }))

    // ── 1. 建实例（仅挂载 / renderKey 变化时重建） ──
    useEffect(() => {
      const container = containerRef.current
      if (!container) return

      registerShapes()
      didFitRef.current = false
      userZoomRef.current = false
      compactRef.current = container.clientWidth > 0 && container.clientWidth < 560

      const graph = new Graph({
        container,
        width: container.clientWidth || 1,
        height: container.clientHeight || 1,
        modes: {
          // zoom-canvas 被移除：滚轮由 attachWheelZoom 接管
          default: [{ type: 'drag-canvas', scalableRange: 0.3 }, 'drag-node'],
        },
        defaultNode: { type: 'task-node' },
        defaultEdge: { type: 'dependency-edge' },
        layout: layoutConfig(layoutRef.current),
        animate: false,
        // 下限必须用自动适配的那个：否则大图「显示全部」会被 G6 内部夹回 0.2
        minZoom: FIT_ZOOM_MIN,
        maxZoom: ZOOM_MAX,
      })

      graphRef.current = graph
      if (import.meta.env.DEV) {
        ;(window as unknown as Record<string, unknown>).__depGraph = graph
      }

      const detachWheel = attachWheelZoom(graph, container, () => {
        userZoomRef.current = true
      })

      let clickTimer: number | null = null
      let suppressClick = false

      graph.on('node:click', (evt: any) => {
        const id = evt.item?.getModel()?.id
        if (clickTimer) window.clearTimeout(clickTimer)
        clickTimer = window.setTimeout(() => {
          clickTimer = null
          if (suppressClick) {
            suppressClick = false
            return
          }
          const node = dataRef.current.nodes.find((n) => n.id === id)
          if (node) clickRef.current?.(node)
        }, 200)
      })

      graph.on('node:dblclick', (evt: any) => {
        if (clickTimer) {
          window.clearTimeout(clickTimer)
          clickTimer = null
        }
        suppressClick = true
        const id = evt.item?.getModel()?.id
        if (!id) return
        const node = dataRef.current.nodes.find((n) => n.id === id)
        if (node) dblClickRef.current?.(node)
      })

      graph.on('node:contextmenu', (evt: any) => {
        evt.preventDefault?.()
        const id = evt.item?.getModel()?.id
        if (!id) return
        if (collapsibleRef.current?.(id)) toggleRef.current?.(id)
      })

      graph.on('canvas:click', () => canvasClickRef.current?.())

      graph.on('viewportchange', () => {
        zoomReporterRef.current?.report(graph.getZoom())
      })

      let resizeTimer: number | null = null
      const handleResize = () => {
        if (resizeTimer) window.clearTimeout(resizeTimer)
        resizeTimer = window.setTimeout(() => {
          const g = graphRef.current
          if (!g || g.get('destroyed') || !containerRef.current) return
          const w = containerRef.current.clientWidth
          const h = containerRef.current.clientHeight
          if (w === 0 || h === 0) return

          // 滞回：进 380 出 420，避免拖动分栏时来回抖
          const nextCompact = compactRef.current ? w < 620 : w < 560
          if (nextCompact !== compactRef.current) {
            compactRef.current = nextCompact
            applyNodeMetrics(g, nextCompact)
          }

          g.changeSize(w, h)
          // 用户没手动缩放过 → 容器变了就重新适配，保证整张图始终可见。
          // 用户手动缩放过 → 尊重他的视野，不擅自重置。
          if (!didFitRef.current || !userZoomRef.current) {
            didFitRef.current = true
            scheduleFit(0)
          } else if (layoutIsSizeDependent(layoutRef.current)) {
            g.updateLayout(layoutConfig(layoutRef.current))
          }
        }, 160)
      }
      const ro = new ResizeObserver(handleResize)
      ro.observe(container)

      return () => {
        detachWheel()
        if (clickTimer) window.clearTimeout(clickTimer)
        if (resizeTimer) window.clearTimeout(resizeTimer)
        if (fitTimerRef.current) {
          window.clearTimeout(fitTimerRef.current)
          fitTimerRef.current = null
        }
        ro.disconnect()
        zoomReporterRef.current?.dispose()
        zoomReporterRef.current = null
        graph.destroy()
        graphRef.current = null
        // 重建后需要新的 reporter
        zoomReporterRef.current = createZoomReporter((z) => zoomRef.current?.(z))
      }
    }, [renderKey])

    // ── 2. 切布局：updateLayout 原地重排 ──
    useEffect(() => {
      const graph = graphRef.current
      if (!graph || graph.get('destroyed')) return
      layoutRef.current = layout
      const vertical = isVerticalAxis(layout)
      verticalRef.current = vertical
      const axis = vertical ? 'vertical' : 'horizontal'

      graph.getEdges().forEach((edge) => {
        graph.updateItem(edge, { axis }, false)
      })

      const afterLayout = () => {
        graph.off('afterlayout', afterLayout)
        if (graph.get('destroyed')) return
        if (layoutIsSizeDependent(layout)) separateOverlaps(graph)
        // 用防抖适配：切布局后可能还有一次数据同步布局，只在最后一次之后 fit
        scheduleFit(60)
      }
      graph.on('afterlayout', afterLayout)
      graph.updateLayout(layoutConfig(layout))

      return () => {
        graph.off('afterlayout', afterLayout)
      }
    }, [layout, scheduleFit])

    // ── 3. 数据同步 ──
    useEffect(() => {
      const graph = graphRef.current
      if (!graph || graph.get('destroyed')) return
      if (!data.nodes.length) return

      const changed = syncGraphData(graph, data, compactRef.current, verticalRef.current)

      const doFit = () => {
        if (graph.get('destroyed')) return
        didFitRef.current = true
        // 交给防抖：同一批数据可能触发多次布局
        scheduleFit(80)
      }

      if (!didFitRef.current) {
        const afterLayout = () => {
          graph.off('afterlayout', afterLayout)
          doFit()
        }
        graph.on('afterlayout', afterLayout)
        // 兜底：布局不触发 afterlayout 时也要适配。
        // 之前是 150ms，早于 dagre 完成，拿到的是旧坐标 → 这就是「显示不全」的根因之一。
        const timer = window.setTimeout(() => {
          if (didFitRef.current) return
          graph.off('afterlayout', afterLayout)
          doFit()
        }, 600)

        if (changed) graph.updateLayout(layoutConfig(layoutRef.current))

        return () => {
          window.clearTimeout(timer)
          graph.off('afterlayout', afterLayout)
        }
      }

      if (changed) graph.updateLayout(layoutConfig(layoutRef.current))
      return undefined
    }, [data, scheduleFit])

    // ── 选中态 ──
    useEffect(() => {
      const graph = graphRef.current
      if (!graph || graph.get('destroyed')) return

      const nodes = graph.getNodes()
      const edges = graph.getEdges()

      if (!selectedId) {
        for (const n of nodes) {
          graph.setItemState(n, 'dim', false)
          graph.setItemState(n, 'highlight', false)
          graph.setItemState(n, 'selected', false)
        }
        for (const e of edges) {
          graph.setItemState(e, 'dim', false)
          graph.setItemState(e, 'highlight', false)
          const base = edgeBaseWidth(e.getModel() as any)
          const shape =
            e.get('group').find((s: any) => s.get('name') === 'edge-dependency') ||
            e.get('group').find((s: any) => s.get('name') === 'edge-parent')
          shape?.attr('lineWidth', base)
          e.get('group').attr('opacity', 1)
        }
        return
      }

      const neighborIds = new Set<string>([selectedId])
      const neighborEdges = new Set<unknown>()
      for (const e of edges) {
        const model = e.getModel() as { source: string; target: string }
        if (model.source === selectedId || model.target === selectedId) {
          neighborIds.add(model.source)
          neighborIds.add(model.target)
          neighborEdges.add(e)
        }
      }

      for (const n of nodes) {
        const id = n.getModel().id
        graph.setItemState(n, 'selected', id === selectedId)
        graph.setItemState(n, 'highlight', id !== selectedId && neighborIds.has(id))
        graph.setItemState(n, 'dim', !neighborIds.has(id))
      }
      for (const e of edges) {
        graph.setItemState(e, 'highlight', neighborEdges.has(e))
        graph.setItemState(e, 'dim', !neighborEdges.has(e))
      }
    }, [selectedId, data])

    const zoomBy = (factor: number) => {
      const graph = graphRef.current
      if (!graph || graph.get('destroyed')) return
      const next = Math.min(ZOOM_MAX, Math.max(WHEEL_ZOOM_MIN, graph.getZoom() * factor))
      if (Math.abs(next - graph.getZoom()) < 1e-6) return
      userZoomRef.current = true
      graph.zoomTo(next, { x: graph.getWidth() / 2, y: graph.getHeight() / 2 })
      zoomReporterRef.current?.report(next)
    }

    return (
      <div className="dependency-graph-container">
        <div ref={containerRef} className="graph-canvas" />
        <div className="graph-controls">
          <button className="graph-ctrl-btn" title="放大" aria-label="放大" onClick={() => zoomBy(1.25)}>
            ＋
          </button>
          <button className="graph-ctrl-btn" title="缩小" aria-label="缩小" onClick={() => zoomBy(0.8)}>
            －
          </button>
          <button
            className="graph-ctrl-btn wide"
            title="显示全部：只把整张图塞进视口，不改变布局"
            aria-label="显示全部"
            onClick={runFit}
          >
            显示全部
          </button>
          <button
            className="graph-ctrl-btn wide"
            title="整理：展开全部节点、重新布局、消除重叠，再适配全图"
            aria-label="整理布局"
            onClick={() => {
              // 先让上层清掉折叠状态，再重新布局；两件事都会触发一次布局，防抖适配只跑最后一次
              onRequestArrange?.()
              arrange()
            }}
          >
            整理
          </button>
        </div>
      </div>
    )
  },
)

DependencyGraph.displayName = 'DependencyGraph'
