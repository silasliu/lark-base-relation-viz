/**
 * 导出图片：尺寸计算（纯函数，可单测）+ 浏览器下载。
 *
 * G6 的 `toFullDataURL` 会按**整图包围盒**生成 canvas，不受当前视口限制。
 * 但几百个节点时包围盒可能有上万像素，超过浏览器 canvas 面积上限会得到空白图，
 * 而且不会抛错。所以必须先算一个安全尺寸再等比压缩。
 */

/** 导出图最长边上限：4096px 足够看清结构，也不会撑爆 canvas */
export const EXPORT_MAX_EDGE = 4096
/** Safari 的 canvas 面积上限约 16.7M px²，留一点余量 */
export const EXPORT_MAX_AREA = 16_000_000
/** 导出留白 */
export const EXPORT_PADDING = 32

export interface ExportSize {
  width: number
  height: number
  /** 相对原始尺寸的缩放比 */
  scale: number
  /** 是否被压缩过 */
  scaled: boolean
}

/**
 * 计算导出尺寸：先按最长边压，再按面积兜底压。
 * 输入非法时返回 1×1，由调用方决定是否报错。
 */
export function computeExportSize(
  width: number,
  height: number,
  maxEdge = EXPORT_MAX_EDGE,
  maxArea = EXPORT_MAX_AREA,
): ExportSize {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1, scale: 0, scaled: true }
  }

  let scale = Math.min(1, maxEdge / Math.max(width, height))
  const area = width * scale * height * scale
  if (area > maxArea) {
    scale *= Math.sqrt(maxArea / area)
  }

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
    scaled: scale < 1,
  }
}

/** 导出文件名：依赖图-全图-20261029-1030.png（label 可选） */
export function exportFileName(at: Date = new Date(), label?: string): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}`
  const middle = label ? `-${label}` : ''
  return `依赖图${middle}-${stamp}.png`
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = dataUrl
  })
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null)
      return
    }
    canvas.toBlob((blob) => resolve(blob), 'image/png')
  })
}

/**
 * 把 G6 导出的 dataURL 转成可下载的 PNG。
 * 返回最终尺寸，便于在提示里告诉用户「已压缩到 4096px」。
 */
export async function downloadPng(
  dataUrl: string,
  fileName: string,
  maxEdge = EXPORT_MAX_EDGE,
): Promise<ExportSize> {
  if (!dataUrl || !dataUrl.startsWith('data:image/')) {
    throw new Error('导出的图片数据为空')
  }

  const img = await loadImage(dataUrl)
  const size = computeExportSize(img.naturalWidth, img.naturalHeight, maxEdge)
  if (size.width <= 1 || size.height <= 1) {
    throw new Error('导出的图片尺寸异常')
  }

  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持导出画布')
  // 白底：G6 的透明背景在深色看图器里会变成黑底
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, size.width, size.height)
  ctx.drawImage(img, 0, 0, size.width, size.height)

  const blob = await canvasToBlob(canvas)
  const href = blob ? URL.createObjectURL(blob) : canvas.toDataURL('image/png')

  const link = document.createElement('a')
  link.href = href
  link.download = fileName
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)

  if (blob) {
    // 给下载一点时间再回收，Safari 上立刻 revoke 会取消下载
    window.setTimeout(() => URL.revokeObjectURL(href), 10_000)
  }

  return size
}
