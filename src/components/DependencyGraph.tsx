import React, { useEffect, useRef, useImperativeHandle, forwardRef } from 'react'
import G6, { Graph } from '@antv/g6'
import type { GraphNode, GraphData, LayoutMode, GraphApi } from '../types'
import { toG6Data, nodeDisplayLines, nodeMetricsFor } from './nodeMetrics'
import { layoutConfig, registerShapes, isVerticalAxis, separateOverlaps, EDGE_WIDTH } from './graphShapes'
import { attachWheelZoom, createZoomReporter, ZOOM_MIN, ZOOM_MAX } from './graphZoom'
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
 * 适配整张图，但始终把最终缩放限制在 G6 的有效范围内。
 *
 * G6 v4 的 fitView 在计算出小于 minZoom 的比例时仍会先调用 graph.zoom，
 * 于是控制台会出现 "zoom failed, ratio out of range"。这里复用它的计算
 * 逻辑，但直接使用夹紧后的绝对比例调用 zoomTo。
 */
function fitGraph(graph: Graph, padding = 24): void {
  const group = graph.get('group') as any
  group.resetMatrix()

  const bbox = group.getCanvasBBox()
  if (!bbox || bbox.width === 0 || bbox.height === 0) return

  const width = graph.getWidth()
  const height = graph.getHeight()
  const availableWidth = Math.max(1, width - padding * 2)
  const availableHeight = Math.max(1, height - padding * 2)
  const ratio = Math.min(availableWidth / bbox.width, availableHeight / bbox.height)
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, ratio))
  const viewCenter = { x: width / 2, y: height / 2 }
  const groupCenter = { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 }

  graph.translate(viewCenter.x - groupCenter.x, viewCenter.y - groupCenter.y)
  graph.zoomTo(zoom, viewCenter)
}

/** 按 id 做 diff 同步，避免全量重建 */
function syncGraphData(graph: Graph, data: GraphData, compact: boolean, vertical: boolean): boolean {
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
    { data, layout, selectedId, onNodeClick, onNodeDoubleClick, onToggleCollapse, collapsible, onCanvasClick, onZoomChange, renderKey },
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
    /** 缩放上报节流 */
    const zoomReporterRef = useRef<ReturnType<typeof createZoomReporter> | null>(null)
    if (!zoomReporterRef.current) {
      zoomReporterRef.current = createZoomReporter((z) => zoomRef.current?.(z))
    }

    useImperativeHandle(ref, () => ({
      focus(nodeId: string) {
        const graph = graphRef.current
        if (!graph || graph.get('destroyed')) return
        graph.focusItem(nodeId, true, { easing: 'easeCubic', duration: 300 })
        // getGraphCenterPoint() 是模型坐标，不能直接当 zoomTo 的中心
        if (graph.getZoom() < ZOOM_MIN + 0.05) {
          graph.zoomTo(0.9, { x: graph.getWidth() / 2, y: graph.getHeight() / 2 })
        }
        zoomReporterRef.current?.report(graph.getZoom())
      },
      fit() {
        const graph = graphRef.current
        if (!graph || graph.get('destroyed')) return
        fitGraph(graph)
        zoomReporterRef.current?.report(graph.getZoom())
      },
    }))

    // ── 1. 建实例（仅挂载 / renderKey 变化时重建） ──
    useEffect(() => {
      const container = containerRef.current
      if (!container) return

      registerShapes()
      didFitRef.current = false
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
        minZoom: ZOOM_MIN,
        maxZoom: ZOOM_MAX,
      })

      graphRef.current = graph
      if (import.meta.env.DEV) {
        ;(window as unknown as Record<string, unknown>).__depGraph = graph
      }

      const detachWheel = attachWheelZoom(graph, container)

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
          if (!didFitRef.current) {
            fitGraph(g)
            didFitRef.current = true
            zoomReporterRef.current?.report(g.getZoom())
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
        fitGraph(graph)
        zoomReporterRef.current?.report(graph.getZoom())
      }
      graph.on('afterlayout', afterLayout)
      graph.updateLayout(layoutConfig(layout))

      return () => {
        graph.off('afterlayout', afterLayout)
      }
    }, [layout])

    // ── 3. 数据同步 ──
    useEffect(() => {
      const graph = graphRef.current
      if (!graph || graph.get('destroyed')) return
      if (!data.nodes.length) return

      const changed = syncGraphData(graph, data, compactRef.current, verticalRef.current)

      const doFit = () => {
        if (graph.get('destroyed')) return
        fitGraph(graph)
        didFitRef.current = true
        zoomReporterRef.current?.report(graph.getZoom())
      }

      if (!didFitRef.current) {
        const afterLayout = () => {
          graph.off('afterlayout', afterLayout)
          doFit()
        }
        graph.on('afterlayout', afterLayout)
        const timer = window.setTimeout(() => {
          if (didFitRef.current) return
          graph.off('afterlayout', afterLayout)
          doFit()
        }, 150)

        if (changed) graph.updateLayout(layoutConfig(layoutRef.current))

        return () => {
          window.clearTimeout(timer)
          graph.off('afterlayout', afterLayout)
        }
      }

      if (changed) graph.updateLayout(layoutConfig(layoutRef.current))
      return undefined
    }, [data])

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
          const isParent = (e.getModel() as any).kind === 'parent'
          const base = isParent ? EDGE_WIDTH.parent : EDGE_WIDTH.dependency
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
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, graph.getZoom() * factor))
      if (Math.abs(next - graph.getZoom()) < 1e-6) return
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
            title="显示全部（图太大时会停在最小缩放，可拖动画布查看其余部分）"
            aria-label="显示全部"
            onClick={() => {
              const g = graphRef.current
              if (!g || g.get('destroyed')) return
              fitGraph(g)
              zoomReporterRef.current?.report(g.getZoom())
            }}
          >
            显示全部
          </button>
        </div>
      </div>
    )
  },
)

DependencyGraph.displayName = 'DependencyGraph'
