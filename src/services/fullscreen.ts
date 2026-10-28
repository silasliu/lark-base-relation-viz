/**
 * 全屏能力封装。
 *
 * 插件跑在飞书 iframe 里，宿主 iframe 标签是否带 `allowfullscreen` 我们改不了。
 * 所以 `requestFullscreen()` 可能直接 reject —— 调用方必须准备降级方案
 * （沉浸模式），不能点了没反应。
 */

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void
  msRequestFullscreen?: () => Promise<void> | void
}

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}

/** 当前处于全屏的元素（兼容 webkit 前缀） */
export function fullscreenElement(): Element | null {
  if (typeof document === 'undefined') return null
  const doc = document as FullscreenDocument
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null
}

export function isFullscreen(): boolean {
  return fullscreenElement() !== null
}

/**
 * 尝试进入真全屏。
 * 返回 true = 宿主放行；false = 被拒绝或浏览器不支持，调用方应降级为沉浸模式。
 */
export async function requestFullscreen(el: HTMLElement): Promise<boolean> {
  const target = el as FullscreenElement
  try {
    if (typeof target.requestFullscreen === 'function') {
      await target.requestFullscreen()
      return isFullscreen()
    }
    if (typeof target.webkitRequestFullscreen === 'function') {
      await target.webkitRequestFullscreen()
      return isFullscreen()
    }
    return false
  } catch {
    // 权限被拒（iframe 没有 allowfullscreen）或用户拒绝，都属于正常分支
    return false
  }
}

export async function exitFullscreen(): Promise<void> {
  if (typeof document === 'undefined') return
  const doc = document as FullscreenDocument
  try {
    if (typeof doc.exitFullscreen === 'function' && fullscreenElement()) {
      await doc.exitFullscreen()
      return
    }
    if (typeof doc.webkitExitFullscreen === 'function' && fullscreenElement()) {
      await doc.webkitExitFullscreen()
    }
  } catch {
    // 已经退出时再调用会抛错，忽略
  }
}

/** 监听全屏状态变化（用户按 Esc 也会触发），返回取消订阅函数 */
export function onFullscreenChange(callback: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  const handler = () => callback()
  document.addEventListener('fullscreenchange', handler)
  document.addEventListener('webkitfullscreenchange', handler)
  return () => {
    document.removeEventListener('fullscreenchange', handler)
    document.removeEventListener('webkitfullscreenchange', handler)
  }
}
