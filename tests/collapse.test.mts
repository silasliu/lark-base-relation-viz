import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCollapse, collapsibleKinds, EMPTY_COLLAPSE } from '../src/services/collapse.ts'
import type { GraphData, GraphNode } from '../src/types.ts'

function node(id: string): GraphNode {
  return {
    id,
    recordId: id,
    label: id,
    emoji: '📌',
    title: id,
    rawTitle: id,
    tags: [],
    status: '打开',
    isIncomplete: true,
    isTerminal: true,
    prerequisiteCount: 0,
    successorCount: 0,
    blockingCount: 0,
    blocksCount: 0,
    prerequisiteTitles: [],
    successorTitles: [],
    childTitles: [],
    prerequisiteRefs: [],
    successorRefs: [],
    childRefs: [],
  }
}

const relations = [
  { relationId: 'fldParent', kind: 'parent' as const, label: '父记录' },
  { relationId: 'fldDep', kind: 'dependency' as const, label: '前置' },
]

function data(): GraphData {
  return {
    nodes: [node('P'), node('C1'), node('X')],
    edges: [
      { source: 'P', target: 'C1', kind: 'parent', relationId: 'fldParent' },
      { source: 'X', target: 'C1', kind: 'dependency', relationId: 'fldDep' },
    ],
    relations,
  }
}

test('折叠后仍然保留 relations（图例不能因为折叠就消失）', () => {
  const result = applyCollapse(data(), { parents: new Set(['P']), deps: new Set() })
  assert.deepEqual(result.data.relations, relations)
})

test('独占子任务被折叠隐藏，relations 依旧保留', () => {
  const single: GraphData = {
    nodes: [node('P'), node('C1')],
    edges: [{ source: 'P', target: 'C1', kind: 'parent', relationId: 'fldParent' }],
    relations,
  }
  const result = applyCollapse(single, { parents: new Set(['P']), deps: new Set() })
  assert.deepEqual(
    result.data.nodes.map((n) => n.id),
    ['P'],
  )
  assert.equal(result.data.edges.length, 0)
  assert.deepEqual(result.data.relations, relations)
})

test('无折叠时原样返回', () => {
  const original = data()
  const result = applyCollapse(original, EMPTY_COLLAPSE)
  assert.equal(result.data, original)
})

test('折叠能力判断', () => {
  assert.deepEqual(collapsibleKinds(data(), 'P'), { parent: true, dep: false })
  assert.deepEqual(collapsibleKinds(data(), 'C1'), { parent: false, dep: true })
})
