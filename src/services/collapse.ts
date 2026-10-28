import type { GraphNode, GraphData, GraphEdge } from '../types'

/** 折叠状态：被折叠的节点 id 集合，以及折叠类型 */
export interface CollapseState {
  /** 父任务折叠：隐藏其子任务 */
  parents: Set<string>
  /** 依赖折叠：隐藏其独有的前置/后继 */
  deps: Set<string>
}

export const EMPTY_COLLAPSE: CollapseState = { parents: new Set(), deps: new Set() }

/** 节点折叠后额外显示的信息 */
export interface CollapseInfo {
  /** 被折叠隐藏的直接子任务数（父子折叠） */
  hiddenChildren: number
  /** 被折叠隐藏的独有依赖数（依赖折叠） */
  hiddenDeps: number
}

/**
 * 应用折叠：从完整图里剔除被折叠节点「独占」的下游节点。
 *
 * 关键保护规则：只隐藏**除了折叠源之外没有任何其它连接**的节点。
 * 否则会出现「图里少了几个节点，但边指着空气」的断层。
 */
export function applyCollapse(
  data: GraphData,
  collapse: CollapseState,
): { data: GraphData; info: Map<string, CollapseInfo> } {
  const info = new Map<string, CollapseInfo>()
  const hidden = new Set<string>()

  const adjacency = new Map<string, Set<string>>()
  const addEdge = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set())
    adjacency.get(a)!.add(b)
  }
  for (const e of data.edges) {
    addEdge(e.source, e.target)
    addEdge(e.target, e.source)
  }

  // ── 父子折叠：隐藏子任务（子任务如果还连着别人才保留） ──
  const parentEdges = data.edges.filter((e) => e.kind === 'parent')
  for (const parentId of collapse.parents) {
    const children = parentEdges.filter((e) => e.source === parentId).map((e) => e.target)
    let n = 0
    for (const childId of children) {
      const neighbours = adjacency.get(childId) ?? new Set()
      // 只连着父节点的才藏
      const exclusive = [...neighbours].every((id) => id === parentId)
      if (exclusive) {
        hidden.add(childId)
        n += 1
      }
    }
    info.set(parentId, { hiddenChildren: n, hiddenDeps: info.get(parentId)?.hiddenDeps ?? 0 })
  }

  // ── 依赖折叠：隐藏只连着它的前置/后继 ──
  const depEdges = data.edges.filter((e) => e.kind === 'dependency')
  for (const nodeId of collapse.deps) {
    const related = depEdges
      .filter((e) => e.source === nodeId || e.target === nodeId)
      .map((e) => (e.source === nodeId ? e.target : e.source))
    let n = 0
    for (const otherId of related) {
      if (hidden.has(otherId)) continue
      const neighbours = adjacency.get(otherId) ?? new Set()
      const exclusive = [...neighbours].every((id) => id === nodeId)
      if (exclusive) {
        hidden.add(otherId)
        n += 1
      }
    }
    const prev = info.get(nodeId)
    info.set(nodeId, {
      hiddenChildren: prev?.hiddenChildren ?? 0,
      hiddenDeps: (prev?.hiddenDeps ?? 0) + n,
    })
  }

  if (hidden.size === 0) return { data, info }

  const nodes = data.nodes
    .filter((n) => !hidden.has(n.id))
    .map((n) => {
      const ci = info.get(n.id)
      if (!ci) return n
      return n
    })
  const kept = new Set(nodes.map((n) => n.id))
  const edges: GraphEdge[] = data.edges.filter(
    (e) => kept.has(e.source) && kept.has(e.target),
  )

  return { data: { nodes, edges }, info }
}

/** 该节点是否可以展开/折叠（有子任务或有多条依赖） */
export function collapsibleKinds(
  data: GraphData,
  nodeId: string,
): { parent: boolean; dep: boolean } {
  const parent = data.edges.some((e) => e.kind === 'parent' && e.source === nodeId)
  const depCount = data.edges.filter(
    (e) => e.kind === 'dependency' && (e.source === nodeId || e.target === nodeId),
  ).length
  return { parent, dep: depCount > 0 }
}

/** 折叠节点上显示的标记文本 */
export function collapseBadge(node: GraphNode, info?: CollapseInfo): string {
  if (!info) return ''
  const parts: string[] = []
  if (info.hiddenChildren > 0) parts.push(`👪${info.hiddenChildren}`)
  if (info.hiddenDeps > 0) parts.push(`📦${info.hiddenDeps}`)
  return parts.join(' ')
}
