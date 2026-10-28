import type { GraphNode, GraphData } from '../types'

export const NODE_METRICS = {
  fontSize: 12,
  dueFontSize: 11,
  tagFontSize: 10,
  lineHeight: 18,
  paddingX: 14,
  paddingY: 13,
  accentBarW: 3,
  /** 文本区最大宽度（不含内边距与色条） */
  maxTextWidth: 200,
  minWidth: 132,
  maxWidth: 240,
}

export type NodeMetrics = typeof NODE_METRICS

/**
 * 紧凑模式：窄容器（飞书侧边栏，画布约 200-380px）下使用。
 * 只压缩留白与文本宽度，不动字号 —— 字号是"能不能读"的底线。
 */
export const NODE_METRICS_COMPACT: NodeMetrics = {
  ...NODE_METRICS,
  paddingX: 9,
  paddingY: 9,
  lineHeight: 16,
  maxTextWidth: 132,
  minWidth: 100,
  maxWidth: 168,
}

export function nodeMetricsFor(compact: boolean): NodeMetrics {
  return compact ? NODE_METRICS_COMPACT : NODE_METRICS
}

/** 标签 chip 参数 */
export const TAG_CHIP = {
  fontSize: 10,
  padX: 4,
  gap: 4,
  radius: 3,
  height: 15,
  /** 最多显示的完整标签数，其余折叠为 +N */
  maxCount: 2,
  /** 单个标签最大文字宽 */
  maxSingleWidth: 76,
} as const

/** 按字符估算文本宽度：CJK / emoji 约等于字号，拉丁字符约 0.55 字号 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0
  for (const ch of text) {
    width += /[\u3000-\u9FFF\uFF00-\uFFEF\u{1F300}-\u{1FAFF}]/u.test(ch)
      ? fontSize
      : fontSize * 0.55
  }
  return width
}

/** 按最大宽度截断文本（宽度感知），预留一个字号给省略号 */
export function truncateToWidth(text: string, maxWidth: number, fontSize: number): string {
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text
  let out = ''
  let width = 0
  const limit = Math.max(fontSize, maxWidth - fontSize)
  for (const ch of text) {
    const w = /[\u3000-\u9FFF\uFF00-\uFFEF\u{1F300}-\u{1FAFF}]/u.test(ch)
      ? fontSize
      : fontSize * 0.55
    if (width + w > limit) return out + '…'
    out += ch
    width += w
  }
  return out
}

export interface TagChip {
  text: string
  x: number
  width: number
  overflow?: boolean
  /** 是否为「所属清单」chip（用不同底色） */
  isList?: boolean
}

/** 截止时间文案 */
function dueText(node: GraphNode): string {
  if (!node.dueDate) return ''
  const d = node.dueDate.slice(5) // MM-DD
  return node.overdueDays ? `📅 ${d} 逾期${node.overdueDays}天` : `📅 ${d}`
}

/** 阻塞徽标文案：表示本任务卡住了多少个下游未完成任务（关键性） */
function blockText(node: GraphNode): string {
  if (!node.isIncomplete) return ''
  if (node.blocksCount > 0) return `阻塞：${node.blocksCount}`
  return ''
}

/**
 * 计算标签 chip 布局。
 * 规则：最多 maxCount 个完整标签，其余折叠 +N；单标签超宽则截断。
 */
function layoutTagChips(node: GraphNode, contentWidth: number): TagChip[] {
  // 清单优先展示（分类主维度），标签在后
  const tags = node.listName ? [node.listName, ...node.tags] : node.tags
  if (tags.length === 0) return []

  const chips: TagChip[] = []
  let x = 0
  const shown = Math.min(tags.length, TAG_CHIP.maxCount)
  const hiddenCount = tags.length - shown

  for (let i = 0; i < shown; i += 1) {
    const raw = tags[i]
    const avail = Math.min(
      TAG_CHIP.maxSingleWidth,
      contentWidth - x - TAG_CHIP.padX * 2,
    )
    if (avail < TAG_CHIP.fontSize * 2) break
    const text = truncateToWidth(raw, avail, TAG_CHIP.fontSize)
    const w = estimateTextWidth(text, TAG_CHIP.fontSize) + TAG_CHIP.padX * 2
    // 第一个 chip 是所属清单，用更深的底色区分
    chips.push({ text, x, width: w, isList: i === 0 && Boolean(node.listName) })
    x += w + TAG_CHIP.gap
  }

  if (hiddenCount > 0) {
    const text = `+${hiddenCount}`
    const w = estimateTextWidth(text, TAG_CHIP.fontSize) + TAG_CHIP.padX * 2
    chips.push({ text, x, width: w, overflow: true })
  }

  return chips
}

/** 单行展示内容（按 kind 对应的字号计算宽度） */
export interface DisplayLine {
  kind: 'title' | 'due' | 'tags'
  text?: string
  overdue?: boolean
  blockText?: string
  chips?: TagChip[]
  fontSize: number
  width: number
}

/** 节点内容行（不含最终截断，截断在拿到节点宽度后二次进行） */
function measureLines(node: GraphNode): {
  titleRaw: string
  due: string
  block: string
  hasTags: boolean
} {
  return {
    titleRaw: `${node.emoji} ${node.title}`,
    due: dueText(node),
    block: blockText(node),
    hasTags: Boolean(node.listName) || node.tags.length > 0,
  }
}

/**
 * 计算节点尺寸。
 *
 * 关键：先按 maxTextWidth 上界算宽，再用最终宽度二次截断文字，
 * 保证「文字永远不溢出框」，也保证 dagre 拿到的是真实尺寸。
 */
export function measureNode(node: GraphNode, metrics: NodeMetrics = NODE_METRICS): [number, number] {
  const R = metrics
  const { titleRaw, due, block, hasTags } = measureLines(node)

  const titleW = estimateTextWidth(titleRaw, R.fontSize)
  // 第二行：截止 + 阻塞徽标（两者之间留 8px）
  const dueW = due ? estimateTextWidth(due, R.dueFontSize) : 0
  const blockW = block ? estimateTextWidth(block, R.dueFontSize) : 0
  const metaW = dueW && blockW ? dueW + 8 + blockW : dueW || blockW

  // 标签行：按 2 个 + 可能的 +N 估算上界
  const allTags = node.listName ? [node.listName, ...node.tags] : node.tags
  let tagsW = 0
  if (allTags.length > 0) {
    const shown = Math.min(allTags.length, TAG_CHIP.maxCount)
    for (let i = 0; i < shown; i += 1) {
      tagsW +=
        Math.min(estimateTextWidth(allTags[i], TAG_CHIP.fontSize), TAG_CHIP.maxSingleWidth) +
        TAG_CHIP.padX * 2 +
        TAG_CHIP.gap
    }
    if (allTags.length > shown) {
      tagsW += estimateTextWidth(`+${allTags.length - shown}`, TAG_CHIP.fontSize) + TAG_CHIP.padX * 2
    }
    tagsW = Math.max(0, tagsW - TAG_CHIP.gap)
  }

  const widest = Math.min(R.maxTextWidth, Math.max(titleW, metaW, tagsW))
  const contentW = R.accentBarW + R.paddingX * 2 + widest
  const width = Math.min(R.maxWidth, Math.max(R.minWidth, contentW))

  const lineCount = 1 + (due || block ? 1 : 0) + (hasTags ? 1 : 0)
  const height = R.paddingY * 2 + lineCount * R.lineHeight

  return [width, height]
}

/**
 * 生成最终展示行（此时宽度已确定，按内容区宽度截断）。
 * 必须与 measureNode 使用同一套字号。
 */
export function nodeDisplayLines(
  node: GraphNode,
  metrics: NodeMetrics = NODE_METRICS,
): {
  lines: DisplayLine[]
  width: number
  height: number
} {
  const R = metrics
  const [width, height] = measureNode(node, metrics)
  const contentWidth = width - R.accentBarW - R.paddingX * 2
  const { titleRaw, due, block, hasTags } = measureLines(node)

  const lines: DisplayLine[] = []

  const titleText = truncateToWidth(titleRaw, contentWidth, R.fontSize)
  lines.push({
    kind: 'title',
    text: titleText,
    fontSize: R.fontSize,
    width: estimateTextWidth(titleText, R.fontSize),
  })

  if (due || block) {
    // 若两者都放不下，优先保留阻塞信息（可动手性优先）
    const dueShown =
      due && estimateTextWidth(due, R.dueFontSize) + (block ? 8 + estimateTextWidth(block, R.dueFontSize) : 0) <= contentWidth
        ? due
        : ''
    const blockShown = block && estimateTextWidth(block, R.dueFontSize) <= contentWidth ? block : ''
    const totalW =
      (dueShown ? estimateTextWidth(dueShown, R.dueFontSize) : 0) +
      (dueShown && blockShown ? 8 : 0) +
      (blockShown ? estimateTextWidth(blockShown, R.dueFontSize) : 0)
    lines.push({
      kind: 'due',
      text: dueShown || undefined,
      blockText: blockShown || undefined,
      overdue: Boolean(node.overdueDays) && Boolean(dueShown),
      fontSize: R.dueFontSize,
      width: totalW,
    })
  }

  if (hasTags) {
    const chips = layoutTagChips(node, contentWidth)
    if (chips.length) {
      const last = chips[chips.length - 1]
      lines.push({
        kind: 'tags',
        chips,
        fontSize: TAG_CHIP.fontSize,
        width: last.x + last.width,
      })
    }
  }

  return { lines, width, height }
}

/** 组装 G6 节点/边数据：预计算 display，并给 dagre 真实 size */
export function toG6Data(data: GraphData, compact = false) {
  const metrics = nodeMetricsFor(compact)
  return {
    nodes: data.nodes.map((node) => {
      const { lines, width, height } = nodeDisplayLines(node, metrics)
      return {
        id: node.id,
        // dagre 优先读 node.size；不写的话按 40×40 排布 → 节点大面积重叠
        size: [width, height] as [number, number],
        compact,
        display: { lines, width, height, node },
      }
    }),
    edges: data.edges.map((edge) => ({
      // relationId 进 id：同一对记录如果来自不同关系，不会被误判成同一条边
      id: `${edge.relationId}:${edge.source}->${edge.target}`,
      source: edge.source,
      target: edge.target,
      relationId: edge.relationId,
      prerequisiteComplete: edge.prerequisiteComplete,
      sourceComplete: edge.sourceComplete,
      kind: edge.kind,
    })),
  }
}
