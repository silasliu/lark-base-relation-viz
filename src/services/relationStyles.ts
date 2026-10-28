/**
 * 关系样式注册表（纯逻辑，无 G6 依赖，可单测）。
 *
 * 编码分工（第二轮讨论结论，推翻了最初「颜色 = 关系」的提案）：
 * - **状态 → 颜色**：红 = 前置未完成（阻塞中）、绿 = 前置已完成（可推进）、
 *   灰 = 本任务已完成（关系已失效）。颜色是最显眼的通道，必须留给用户据以行动的信息。
 * - **关系类型 → 线型 + 箭头形状 + 线宽**：关系种类天生少（2～4 种），
 *   用低显著性通道足够区分，也不会和状态色打架。
 *
 * 新增一种关系时只需要在 GraphData.relations 里多一条，样式由这里按顺序分配，
 * 不需要再改绘制分支 —— 这是为「多种依赖关系 + 未来多表」留的扩展点。
 */

export type RelationKind = 'dependency' | 'parent'

/** 箭头形状：实心三角 / 空心三角 / 菱形 / 无 */
export type ArrowShape = 'filled' | 'hollow' | 'diamond' | 'none'

export interface RelationStyle {
  /** 关系 id（通常是来源关联字段 id） */
  id: string
  kind: RelationKind
  lineWidth: number
  /** 虚线间隔；undefined = 实线 */
  lineDash?: number[]
  arrow: ArrowShape
  /** 图例顺序 */
  order: number
}

/** 图里的一条关系（用于图例与样式解析） */
export interface GraphRelation {
  relationId: string
  kind: RelationKind
  /** 展示名，通常是字段名 */
  label: string
}

type StyleBody = Pick<RelationStyle, 'lineWidth' | 'lineDash' | 'arrow'>

/**
 * 依赖关系的样式变体，按顺序分配。
 * 第一种保持实线 + 实心箭头（与已验证的旧外观一致），后续才用虚线区分。
 */
const DEPENDENCY_VARIANTS: StyleBody[] = [
  { lineWidth: 1.5, arrow: 'filled' },
  { lineWidth: 1.5, lineDash: [7, 3], arrow: 'hollow' },
  { lineWidth: 1.3, lineDash: [2, 2], arrow: 'diamond' },
]

/** 父子关系：灰色虚线、无箭头，不参与「方向」表达 */
const PARENT_BASE: StyleBody = {
  lineWidth: 1.2,
  lineDash: [3, 3],
  arrow: 'none',
}

/** 按「标签、id」稳定排序，保证同一份数据每次得到同样的样式（截图与测试才可比） */
function byLabelThenId(a: GraphRelation, b: GraphRelation): number {
  return a.label.localeCompare(b.label, 'zh') || a.relationId.localeCompare(b.relationId)
}

/**
 * 把关系列表解析成 relationId → 样式。
 * 依赖关系在前（order 0..n），父子关系在后（order 100+）。
 */
export function resolveRelationStyles(relations: GraphRelation[]): Map<string, RelationStyle> {
  const result = new Map<string, RelationStyle>()

  relations
    .filter((r) => r.kind === 'dependency')
    .slice()
    .sort(byLabelThenId)
    .forEach((relation, index) => {
      const variant = DEPENDENCY_VARIANTS[index % DEPENDENCY_VARIANTS.length]
      result.set(relation.relationId, {
        id: relation.relationId,
        kind: 'dependency',
        lineWidth: variant.lineWidth,
        lineDash: variant.lineDash,
        arrow: variant.arrow,
        order: index,
      })
    })

  relations
    .filter((r) => r.kind === 'parent')
    .slice()
    .sort(byLabelThenId)
    .forEach((relation, index) => {
      result.set(relation.relationId, {
        id: relation.relationId,
        kind: 'parent',
        lineWidth: PARENT_BASE.lineWidth,
        lineDash: PARENT_BASE.lineDash,
        arrow: PARENT_BASE.arrow,
        order: 100 + index,
      })
    })

  return result
}

/** 兜底样式：数据里没有声明关系时也不至于画不出来 */
export function fallbackStyle(kind: RelationKind): RelationStyle {
  const base = kind === 'parent' ? PARENT_BASE : DEPENDENCY_VARIANTS[0]
  return {
    id: kind,
    kind,
    lineWidth: base.lineWidth,
    lineDash: base.lineDash,
    arrow: base.arrow,
    order: kind === 'parent' ? 100 : 0,
  }
}

/** 图例用的 CSS 类后缀：solid / dashed / dotted */
export function lineDashCss(style: RelationStyle): 'solid' | 'dashed' | 'dotted' {
  if (!style.lineDash || style.lineDash.length === 0) return 'solid'
  const [dash] = style.lineDash
  return dash <= 3 ? 'dotted' : 'dashed'
}
