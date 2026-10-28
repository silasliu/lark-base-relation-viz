import type { Graph } from '@antv/g6'

/**
 * 缩放下限。
 *
 * 之前是 0.55，窄侧边栏里图大一点就「缩不下去也看不全」，很别扭。
 * 降到 0.2：小图仍按实际需要适配，大图可以一直缩到能看见全貌为止。
 * 这个比例下文字已经不可读，属于「看结构」而非「读内容」的档位，可以接受。
 */
export const ZOOM_MIN = 0.2
/** 缩放上限：超过 2 倍后 12px 字渲染发虚，没意义 */
export const ZOOM_MAX = 2

/**
 * 接管滚轮缩放。
 *
 * 为什么不用 G6 的 zoom-canvas：
 * v4 的 onWheel 只读 deltaY 的正负号，每个事件固定乘 1/(1-0.05*sensitivity)，
 * 完全忽略 deltaY 的数值。触控板一次滑动会连发几十个 wheel 事件，
 * 于是变成指数级放大（sensitivity=2 时每事件 ×1.111，40 个事件 ≈ 67 倍）。
 *
 * 这里改成按物理像素换算：
 *   ratio = 2^(-Δpx / 260)
 * 滚 260px 缩放 2 倍，无论是触控板的小增量还是鼠标的大单步，口径一致。
 */
export function attachWheelZoom(graph: Graph, container: HTMLElement): () => void {
  /** 单次事件最大缩放倍数，防止某些设备一次发 deltaY=3000 */
  const MAX_STEP = 1.3
  /** 滚 260px 缩放 2 倍 */
  const PIXELS_PER_OCTAVE = 260
  /** 低通系数：抹平 deltaY 抖动 */
  const DELTA_EMA = 0.55
  /** 间隔超过这个值视为一次新手势，重置累计 */
  const GESTURE_GAP_MS = 160
  /** 触控板捏合（ctrlKey）的 deltaY 很小，放大口径才跟得上手指 */
  const PINCH_GAIN = 6

  let smoothDelta = 0
  let lastEventAt = 0

  const toCanvasPoint = (clientX: number, clientY: number) => {
    const rect = container.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }

  /** deltaMode: 0=像素 1=行 2=页 */
  const normalizeDeltaY = (e: WheelEvent): number => {
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
    return e.deltaY * unit
  }

  const onWheel = (e: WheelEvent) => {
    if (graph.get('destroyed')) return

    const pinching = e.ctrlKey
    // 以横向为主的手势（触控板左右滑）留给浏览器，避免横滑时乱缩
    if (!pinching && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5) return

    e.preventDefault()

    const dy = normalizeDeltaY(e) * (pinching ? PINCH_GAIN : 1)
    if (!dy) return

    const now = performance.now()
    if (now - lastEventAt > GESTURE_GAP_MS) smoothDelta = 0
    lastEventAt = now
    smoothDelta = smoothDelta * (1 - DELTA_EMA) + dy * DELTA_EMA

    let ratio = Math.pow(2, -smoothDelta / PIXELS_PER_OCTAVE)
    ratio = Math.min(MAX_STEP, Math.max(1 / MAX_STEP, ratio))

    const current = graph.getZoom()
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, current * ratio))
    if (Math.abs(next - current) < 1e-6) return

    graph.zoomTo(next, toCanvasPoint(e.clientX, e.clientY))
  }

  // 必须 passive: false，否则 preventDefault 无效
  container.addEventListener('wheel', onWheel, { passive: false })
  return () => container.removeEventListener('wheel', onWheel)
}

/**
 * 缩放回调节流：rAF 合并 + 整数百分比去重。
 *
 * 一次手势产生几十次 zoom 变化，若每次都 setState，整个 App
 * （工具栏、清单、详情）会跟着重渲染几十次。这里只在整数百分比变化时才回调。
 */
export function createZoomReporter(cb: (zoom: number) => void) {
  let raf = 0
  let pending = Number.NaN
  let lastSent = Number.NaN

  const send = () => {
    raf = 0
    const pct = Math.round(pending * 100)
    if (!Number.isFinite(pct) || pct === lastSent) return
    lastSent = pct
    cb(pct / 100)
  }

  return {
    report(zoom: number) {
      pending = zoom
      if (raf) return
      raf = requestAnimationFrame(send)
    },
    dispose() {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    },
  }
}
