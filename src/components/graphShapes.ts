import G6 from '@antv/g6'
import type { LayoutMode, GraphRelation } from '../types'
import { resolveRelationStyles, fallbackStyle, type RelationStyle } from '../services/relationStyles'
import { TAG_CHIP, NODE_METRICS, NODE_METRICS_COMPACT } from './nodeMetrics'

/** 飞书设计语言配色 */
export const COLOR = {
  surface: '#ffffff',
  border: '#e5e6eb',
  borderStrong: '#c9cdd4',
  textPrimary: '#1f2329',
  textSecondary: '#8f959e',
  textTertiary: '#a9aeb8',
  danger: '#f54a45',
  success: '#34c724',
  /** 已完成任务的侧边条：灰绿，弱化但保留「完成」语义 */
  successMuted: '#8faa9b',
  warning: '#ff8800',
  primary: '#3370ff',
  primaryLite: '#e1eaff',
  highlightStroke: '#94bfff',
  tagBg: '#f2f3f5',
  tagText: '#646a73',
  tagOverflowBg: '#e8ebf0',
  edgeParent: '#c9cdd4',
  /** 已完成任务引出的依赖边：关系仍存在，但已无行动意义 */
  edgeIdle: '#c9cdd4',
} as const

/**
 * 关系样式注册表：由 GraphData.relations 解析后存成模块级表。
 *
 * 为什么放模块级：G6 的 draw/setState 只拿到 cfg，拿不到 React 的 props。
 * 图实例只有一个，切换数据前统一刷新这张表即可。
 */
let activeStyles = new Map<string, RelationStyle>()

/** 每次同步数据前调用：把关系声明换成具体样式 */
export function applyRelationStyles(relations: GraphRelation[]): void {
  activeStyles = resolveRelationStyles(relations)
}

/** 取某条边的样式；数据没声明关系时按 kind 兜底 */
export function styleForModel(model: { relationId?: string; kind?: string } | undefined): RelationStyle {
  const relationId = model?.relationId
  if (relationId) {
    const hit = activeStyles.get(relationId)
    if (hit) return hit
  }
  return fallbackStyle(model?.kind === 'parent' ? 'parent' : 'dependency')
}

/** 边的基准线宽（选中态恢复时用，不要写字面量） */
export function edgeBaseWidth(model: { relationId?: string; kind?: string } | undefined): number {
  return styleForModel(model).lineWidth
}

/** 按样式生成箭头配置；'none' 返回 undefined */
function arrowConfig(style: RelationStyle, color: string): Record<string, unknown> | undefined {
  switch (style.arrow) {
    case 'none':
      return undefined
    case 'hollow':
      // 空心三角：白色填充 + 状态色描边，用来区分第二种依赖关系
      return { path: G6.Arrow.vee(9, 11, 0), d: 0, fill: '#ffffff', stroke: color, lineWidth: 1.3 }
    case 'diamond':
      return { path: G6.Arrow.diamond(10, 12, 0), d: 0, fill: color, stroke: color }
    case 'filled':
    default:
      // 第三个参数是 offset：让箭头尖退后 2px，不被节点边框压平
      return { path: G6.Arrow.triangle(7, 9, 2), d: 2, fill: color, stroke: color }
  }
}

/** 环形/辐射布局的节点碰撞尺寸：按最大节点对角线给，避免圆周上互相压住 */
const CIRCULAR_NODE_SIZE = 260

/** 主轴方向：决定边的曲线方向与锚点 */
export function isVerticalAxis(mode: LayoutMode): boolean {
  return mode === 'dagre-tb' || mode === 'radial'
}

/** 各布局模式的 G6 配置 */
export function layoutConfig(mode: LayoutMode): Record<string, unknown> {
  // dagre 公共项：
  // - controlPoints: true 让 dagre 预留边空间，减少交叉
  // - edgeLabelSpace: false 去掉无用的 dummy 节点（本图没有边标签）
  // - nodesep/ranksep 是节点边缘间的净空隙（不是中心距）
  const dagreBase = { type: 'dagre', controlPoints: true, edgeLabelSpace: false, edgesep: 12 }
  switch (mode) {
    case 'dagre-lr':
      return { ...dagreBase, rankdir: 'LR', nodesep: 20, ranksep: 64 }
    case 'force':
      // 用 force2：它的 collide 会对所有节点生效并推动重叠的节点分离；
      // gForce 在边长差异大的节点（132–240 宽）下收敛不稳定
      return {
        type: 'force2',
        linkDistance: 200,
        nodeStrength: 300,
        edgeStrength: 0.4,
        collideStrength: 1,
        nodeSize: CIRCULAR_NODE_SIZE,
        preventOverlap: true,
        alpha: 0.3,
        alphaDecay: 0.02,
        alphaMin: 0.001,
        factor: 3,
        maxIteration: 800,
        gravity: 3,
        clustering: false,
        onTick: null,
      }
    case 'circular':
      // 必须同时给 nodeSpacing 与 nodeSize：布局会按
      // Σ(nodeSize + nodeSpacing) 算周长再反推半径，否则半径按画布高度乱定 → 节点必然重叠
      return {
        type: 'circular',
        ordering: 'topology',
        radius: null,
        nodeSize: CIRCULAR_NODE_SIZE,
        nodeSpacing: 24,
      }
    case 'radial':
      // unitRadius 是相邻环的径向间距：节点最大宽度 240，环间距必须大于它才不会跨环重叠
      return {
        type: 'radial',
        unitRadius: 300,
        preventOverlap: true,
        nodeSize: CIRCULAR_NODE_SIZE,
        nodeSpacing: 40,
        strictRadial: false,
        maxIteration: 1000,
      }
    case 'dagre-tb':
    default:
      // BT = bottom-to-top：dagre 把 source 放在下方、target 放在上方。
      // 依赖边是「任务 → 前置」，于是任务在下、前置在上，符合「被依赖的排在上面」。
      return { ...dagreBase, rankdir: 'BT', nodesep: 20, ranksep: 56 }
  }
}

/** 布局模式的展示名 */
export const LAYOUT_LABELS: Record<LayoutMode, string> = {
  'dagre-tb': '层级 · 上下',
  'dagre-lr': '层级 · 左右',
  force: '力导向',
  circular: '环形',
  radial: '辐射',
}

/**
 * 布局后兜底：把仍然重叠的节点沿连心线推开。
 *
 * dagre/force2 自身能保证不重叠，但 circular/radial 会跨环或跨扇区叠在一起，
 * G6 v4 没有对应的「排除重叠」选项，只能布局后自己做一次分离。
 * 迭代有限（最多 40 轮），宁可留少量残余也不让图变形到不可读。
 */
export function separateOverlaps(graph: any, gap = 16): void {
  const nodes = graph.getNodes()
  if (nodes.length < 2 || nodes.length > 300) return

  const boxes = nodes.map((n: any) => {
    const b = n.getBBox()
    return { n, w: b.maxX - b.minX, h: b.maxY - b.minY, x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
  })

  let moved = false

  // 每轮 O(n²)，节点多了会慢：限制轮数并按重叠数量做缩放
  const maxIter = Math.min(24, Math.max(6, Math.round(600 / Math.max(nodes.length, 1))))
  for (let iter = 0; iter < maxIter; iter += 1) {
    let anyOverlap = false
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]
        const b = boxes[j]
        const needX = (a.w + b.w) / 2 + gap
        const needY = (a.h + b.h) / 2 + gap
        const dx = b.x - a.x
        const dy = b.y - a.y
        const overlapX = needX - Math.abs(dx)
        const overlapY = needY - Math.abs(dy)
        if (overlapX <= 0 || overlapY <= 0) continue

        anyOverlap = true
        // 沿重叠更小的轴推开，位移最小
        if (overlapX / needX < overlapY / needY) {
          const push = overlapX / 2 + 0.5
          const dir = dx === 0 ? 1 : Math.sign(dx)
          a.x -= push * dir
          b.x += push * dir
        } else {
          const push = overlapY / 2 + 0.5
          const dir = dy === 0 ? 1 : Math.sign(dy)
          a.y -= push * dir
          b.y += push * dir
        }
        moved = true
      }
    }
    if (!anyOverlap) break
  }

  if (!moved) return

  graph.setAutoPaint(false)
  for (const box of boxes) {
    // 直接改模型坐标并刷新位置；不调用 graph.layout()（会再次触发 afterlayout → 递归死循环）
    const model = box.n.getModel()
    model.x = box.x
    model.y = box.y
    graph.updateItem(box.n, { x: box.x, y: box.y }, false)
  }
  graph.refreshPositions()
  graph.paint()
  graph.setAutoPaint(true)
}

/** 注册自定义节点与边（幂等） */export function registerShapes(): void {
  if ((G6 as any).__dependencyGraphRegistered) return
  ;(G6 as any).__dependencyGraphRegistered = true

  G6.registerNode(
    'task-node',
    {
      draw(cfg: any, group: any) {
        // 紧凑模式随数据一起传下来，不依赖全局状态
        const R = cfg.compact ? NODE_METRICS_COMPACT : NODE_METRICS
        const { lines, width, height, node } = cfg.display as {
          lines: Array<{
            kind: 'title' | 'due' | 'tags'
            text?: string
            blockText?: string
            overdue?: boolean
            chips?: Array<{ text: string; x: number; width: number; overflow?: boolean; isList?: boolean }>
            fontSize: number
            width: number
          }>
          width: number
          height: number
          node: { isTerminal: boolean; isIncomplete: boolean }
        }

        // isTerminal = 没有前置 = 依赖链的**起点**（最容易动手的地方），必须醒目而不是虚化。
        // 真正该淡出的是「没人依赖它」的末端，用 isLeaf 表示。
        const boxOpacity = 1
        const isRoot = node.isTerminal
        // 未完成 → 红（要处理）；已完成 → 灰绿（弱化，不抢注意力）
        const accent = node.isIncomplete ? COLOR.danger : COLOR.successMuted
        const left = -width / 2
        const top = -height / 2

        const key = group.addShape('rect', {
          attrs: {
            x: left,
            y: top,
            width,
            height,
            fill: COLOR.surface,
            stroke: isRoot ? COLOR.borderStrong : COLOR.border,
            lineWidth: isRoot ? 2 : 1.2,
            radius: 8,
            opacity: boxOpacity,
            cursor: 'pointer',
          },
          name: 'box',
        })

        group.addShape('rect', {
          attrs: {
            x: left,
            y: top + 7,
            width: R.accentBarW,
            height: height - 14,
            fill: accent,
            radius: 2,
            opacity: boxOpacity,
          },
          name: 'accent',
        })

        const contentX = left + R.accentBarW + R.paddingX
        let y = top + R.paddingY + R.lineHeight / 2

        for (const line of lines) {
          if (line.kind === 'title') {
            group.addShape('text', {
              attrs: {
                x: contentX,
                y,
                text: line.text ?? '',
                fontSize: R.fontSize,
                fontWeight: 500,
                fill: COLOR.textPrimary,
                textBaseline: 'middle',
                cursor: 'pointer',
              },
              name: 'line-title',
            })
          } else if (line.kind === 'due') {
            let x = contentX
            if (line.text) {
              group.addShape('text', {
                attrs: {
                  x,
                  y,
                  text: line.text,
                  fontSize: R.dueFontSize,
                  fontWeight: line.overdue ? 500 : 400,
                  fill: line.overdue ? COLOR.danger : COLOR.tagText,
                  textBaseline: 'middle',
                  cursor: 'pointer',
                },
                name: 'line-due',
              })
              x += line.width - (line.blockText ? 0 : 0)
            }
            if (line.blockText) {
              group.addShape('text', {
                attrs: {
                  x: contentX + (line.text ? line.width + 8 : 0),
                  y,
                  text: line.blockText,
                  fontSize: R.dueFontSize,
                  fill: COLOR.warning,
                  textBaseline: 'middle',
                  cursor: 'pointer',
                },
                name: 'line-block',
              })
            }
          } else if (line.kind === 'tags' && line.chips) {
            for (let i = 0; i < line.chips.length; i += 1) {
              const chip = line.chips[i]
              const chipX = contentX + chip.x
              group.addShape('rect', {
                attrs: {
                  x: chipX,
                  y: y - TAG_CHIP.height / 2,
                  width: chip.width,
                  height: TAG_CHIP.height,
                  radius: TAG_CHIP.radius,
                  // 清单 chip 用浅蓝底，与普通标签区分
                  fill: chip.isList ? COLOR.primaryLite : chip.overflow ? COLOR.tagOverflowBg : COLOR.tagBg,
                },
                name: `tag-bg-${i}`,
              })
              group.addShape('text', {
                attrs: {
                  x: chipX + TAG_CHIP.padX,
                  y,
                  text: chip.text,
                  fontSize: TAG_CHIP.fontSize,
                  fill: chip.isList ? COLOR.primary : COLOR.tagText,
                  textBaseline: 'middle',
                  cursor: 'pointer',
                },
                name: `tag-text-${i}`,
              })
            }
          }
          y += R.lineHeight
        }

        return key
      },

      setState(name: string, value: boolean, item: any) {
        const group = item.get('group')
        const box = group.find((s: any) => s.get('name') === 'box')
        if (!box) return
        const selected = item.hasState('selected')

        if (name === 'dim') {
          // 压暗时保留选中节点的可见性
          group.attr('opacity', value ? 0.12 : 1)
        }

        // selected 优先级最高，其次 highlight，最后默认
        if ((name === 'selected' || name === 'highlight') && !item.hasState('dim')) {
          if (selected) {
            box.attr({
              stroke: COLOR.primary,
              lineWidth: 2,
              shadowColor: 'rgba(51,112,255,0.25)',
              shadowBlur: 12,
            })
          } else if (item.hasState('highlight')) {
            box.attr({
              stroke: COLOR.highlightStroke,
              lineWidth: 1.6,
              shadowColor: 'transparent',
              shadowBlur: 0,
            })
          } else {
            box.attr({
              stroke: COLOR.border,
              lineWidth: 1.2,
              shadowColor: 'transparent',
              shadowBlur: 0,
            })
          }
        }
      },

      getAnchorPoints() {
        // 0:上 1:下 2:左 3:右
        return [
          [0.5, 0],
          [0.5, 1],
          [0, 0.5],
          [1, 0.5],
        ]
      },

      /**
       * 精确求出边与节点边框的交点，锚点按两节点相对位置**动态**选择。
       *
       * 为什么不能写死 anchorIndex：
       * 写死「源出下边、目标入上边」只在严格上下排列时成立。真实图里
       * 兄弟任务会左右错开，写死的锚点会让线从侧边斜着插进节点，箭头落在角上。
       *
       * 规则：先看垂直落差够不够大（≥ 半高 + 半高），够就从下/上边中点连出，
       * 保证上下层级关系清晰；不够就退化为左右边中点，避免斜穿节点。
       */
      getLinkPoint(node: any, other: any, anchorIndex: number) {
        const model = node.getModel()
        const otherModel = other?.getModel?.() ?? {}
        const [w, h] = model.size || [120, 60]
        const [ow, oh] = otherModel.size || [120, 60]
        const cx = model.x ?? 0
        const cy = model.y ?? 0
        const ox = otherModel.x ?? cx
        const oy = otherModel.y ?? cy
        const halfW = w / 2
        const halfH = h / 2

        const dx = ox - cx
        const dy = oy - cy
        // 垂直落差超过两节点半高之和 → 判定为上下关系；否则视为横向关系
        const verticalGap = Math.abs(dy) >= (h + oh) / 2 + 4
        const horizontalGap = Math.abs(dx) >= (w + ow) / 2 + 4

        let dir: 'up' | 'down' | 'left' | 'right'
        if (verticalGap && (!horizontalGap || Math.abs(dy) >= Math.abs(dx) * 0.5)) {
          dir = dy < 0 ? 'up' : 'down'
        } else if (horizontalGap) {
          dir = dx < 0 ? 'left' : 'right'
        } else {
          // 都挤在一起时按主导轴兜底，避免落到中心点被白底盖住
          dir = Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? 'up' : 'down') : dx < 0 ? 'left' : 'right'
        }

        switch (dir) {
          case 'up':
            return { x: cx, y: cy - halfH }
          case 'down':
            return { x: cx, y: cy + halfH }
          case 'left':
            return { x: cx - halfW, y: cy }
          case 'right':
          default:
            return { x: cx + halfW, y: cy }
        }
      },
    },
    'single-node',
  )

  // ── 依赖边：前置 → 任务，箭头指向任务 ──
  G6.registerEdge(
    'dependency-edge',
    {
      getControlPoints(cfg: any) {
        const { startPoint: s, endPoint: e } = cfg
        if (!s || !e) return []
        let dx = e.x - s.x
        let dy = e.y - s.y

        // 防止退化成零长度（两端重合时给一个最小偏移）
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) dy = 40

        // 主轴由**实际几何**决定，而不是布局模式：
        // 动态锚点下，同一张图里既有上下连的边也有左右连的边，
        // 若按布局模式统一处理，横向边会被当成上下边画成奇怪的 S 形。
        const vertical = Math.abs(dy) >= Math.abs(dx)

        if (vertical) {
          const dyAbs = Math.abs(dy)
          // 同层横向相邻：强制绕行，避免直线穿过节点
          if (dyAbs < 6) {
            const midY = s.y + (dy >= 0 ? 28 : -28)
            return [
              { x: s.x, y: midY },
              { x: e.x, y: midY },
            ]
          }
          // 跨层：控制点外伸不超过层距的 45%，远距离时保持近端垂直
          const k = Math.min(0.45, 40 / dyAbs)
          return [
            { x: s.x, y: s.y + dy * k },
            { x: e.x, y: e.y - dy * k },
          ]
        }

        const dxAbs = Math.abs(dx)
        if (dxAbs < 6) {
          const midX = s.x + (dx >= 0 ? 28 : -28)
          return [
            { x: midX, y: s.y },
            { x: midX, y: e.y },
          ]
        }
        const k = Math.min(0.45, 40 / dxAbs)
        return [
          { x: s.x + dx * k, y: s.y },
          { x: e.x - dx * k, y: e.y },
        ]
      },

      // getPath 是几何的单一真相：draw 与 G6 内部 update 都走它，不会出现「刷新后变形」
      getPath(points: any[]) {
        if (!points || points.length < 4) return []
        const [s, c1, c2, e] = points
        return [
          ['M', s.x, s.y],
          ['C', c1.x, c1.y, c2.x, c2.y, e.x, e.y],
        ]
      },

      draw(cfg: any, group: any) {
        const { startPoint, endPoint, prerequisiteComplete, sourceComplete, kind, color } = cfg
        if (!startPoint || !endPoint) return null

        const self = this as any
        const style = styleForModel(cfg)
        const cps = self.getControlPoints ? self.getControlPoints(cfg) : []
        const path = cps.length >= 2
          ? self.getPath([startPoint, cps[0], cps[1], endPoint])
          : [['M', startPoint.x, startPoint.y], ['L', endPoint.x, endPoint.y]]

        // 颜色只表达状态，不表达关系：
        // 父子关系固定灰；依赖关系三态着色，优先级「本任务已完成 → 灰」最高，
        // 因为那时这条关系已经没有行动意义了。
        const strokeColor =
          kind === 'parent'
            ? COLOR.edgeParent
            : color ??
              (sourceComplete
                ? COLOR.edgeIdle
                : prerequisiteComplete
                  ? COLOR.success
                  : COLOR.danger)

        const attrs: Record<string, unknown> = {
          path,
          stroke: strokeColor,
          lineWidth: style.lineWidth,
        }
        if (style.lineDash) attrs.lineDash = style.lineDash
        const arrow = arrowConfig(style, strokeColor)
        if (arrow) attrs.endArrow = arrow

        return group.addShape('path', {
          attrs,
          name: kind === 'parent' ? 'edge-parent' : 'edge-dependency',
        })
      },

      setState(name: string, value: boolean, item: any) {
        if (name !== 'dim' && name !== 'highlight') return
        const group = item.get('group')
        const style = styleForModel(item.getModel())
        const shape =
          group.find((s: any) => s.get('name') === 'edge-dependency') ||
          group.find((s: any) => s.get('name') === 'edge-parent')
        if (!shape) return

        if (name === 'dim') {
          group.attr('opacity', value ? 0.06 : 1)
        }
        if (name === 'highlight') {
          // 恢复时用关系自己的基准线宽，不要写字面量
          shape.attr('lineWidth', value ? style.lineWidth + 1 : style.lineWidth)
        }
      },
    },
    'cubic',
  )
}
