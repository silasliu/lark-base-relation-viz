import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraphData } from '../src/services/graphBuilder.ts'
import type { BaseTask } from '../src/types.ts'

function task(recordId: string, extra: Partial<BaseTask> = {}): BaseTask {
  return {
    recordId,
    title: `${recordId} 任务`,
    status: ['打开'],
    tags: [],
    prerequisites: [],
    ...extra,
  }
}

const ids = (data: { nodes: Array<{ id: string }> }) => data.nodes.map((n) => n.id).sort()

test('传递阻塞数：A→B→C 时 A 记 2', () => {
  const data = buildGraphData([
    task('A'),
    task('B', { prerequisites: ['A'] }),
    task('C', { prerequisites: ['B'] }),
  ])

  const byId = new Map(data.nodes.map((n) => [n.recordId, n]))
  assert.equal(byId.get('A')?.blocksCount, 2)
  assert.equal(byId.get('B')?.blocksCount, 1)
  assert.equal(byId.get('C')?.blocksCount, 0)
})

test('菱形依赖不重复计数', () => {
  // A 被 B、C 依赖，B 和 C 又都被 D 依赖：A 的下游是 {B, C, D} = 3
  const data = buildGraphData([
    task('A'),
    task('B', { prerequisites: ['A'] }),
    task('C', { prerequisites: ['A'] }),
    task('D', { prerequisites: ['B', 'C'] }),
  ])

  const a = data.nodes.find((n) => n.recordId === 'A')
  assert.equal(a?.blocksCount, 3)
})

test('已完成的下游任务不计入传递阻塞数', () => {
  const data = buildGraphData([
    task('A'),
    task('B', { prerequisites: ['A'], status: ['已完成'] }),
  ])

  const a = data.nodes.find((n) => n.recordId === 'A')
  assert.equal(a?.blocksCount, 0)
})

test('依赖边颜色状态：前置完成=可推进，本任务完成=失效', () => {
  const data = buildGraphData([
    task('A', { status: ['已完成'] }),
    task('B', { prerequisites: ['A'] }),
    task('C', { prerequisites: ['B'], status: ['已完成'] }),
  ])

  const bToA = data.edges.find((e) => e.source === 'B' && e.target === 'A')
  assert.equal(bToA?.prerequisiteComplete, true)
  assert.equal(bToA?.sourceComplete, false)

  const cToB = data.edges.find((e) => e.source === 'C' && e.target === 'B')
  assert.equal(cToB?.sourceComplete, true)
})

test('表命名空间：节点 id 加前缀，recordId 保持原样', () => {
  const data = buildGraphData(
    [task('A'), task('B', { prerequisites: ['A'] })],
    { namespace: 'tblXYZ' },
  )

  assert.deepEqual(ids(data), ['tblXYZ:A', 'tblXYZ:B'])
  assert.equal(data.nodes.find((n) => n.id === 'tblXYZ:A')?.recordId, 'A')
  // 边的端点也必须用命名空间 id，否则连不上节点
  for (const edge of data.edges) {
    assert.ok(edge.source.startsWith('tblXYZ:'))
    assert.ok(edge.target.startsWith('tblXYZ:'))
  }
})

test('不加命名空间时保持旧的 recordId 行为', () => {
  const data = buildGraphData([task('A'), task('B', { prerequisites: ['A'] })])
  assert.deepEqual(ids(data), ['A', 'B'])
})

test('多依赖关系：每条边带自己的 relationId', () => {
  const data = buildGraphData(
    [
      task('A', { prerequisitesByField: { f1: [], f2: [] } }),
      task('B', { prerequisitesByField: { f1: ['A'], f2: [] }, prerequisites: ['A'] }),
      task('C', { prerequisitesByField: { f1: [], f2: ['A'] }, prerequisites: ['A'] }),
    ],
    {
      dependencyRelations: [
        { relationId: 'f1', label: '前置', role: 'fieldIsPrereq' },
        { relationId: 'f2', label: '阻塞', role: 'fieldIsPrereq' },
      ],
    },
  )

  const bToA = data.edges.find((e) => e.source === 'B' && e.target === 'A')
  const cToA = data.edges.find((e) => e.source === 'C' && e.target === 'A')
  assert.equal(bToA?.relationId, 'f1')
  assert.equal(cToA?.relationId, 'f2')
  assert.deepEqual(
    data.relations.map((r) => r.relationId).sort(),
    ['f1', 'f2'],
  )
})

test('同一对记录被两条关系同时引用时只保留一条边', () => {
  const data = buildGraphData(
    [
      task('A', { prerequisitesByField: { f1: [], f2: [] } }),
      task('B', { prerequisitesByField: { f1: ['A'], f2: ['A'] }, prerequisites: ['A'] }),
    ],
    {
      dependencyRelations: [
        { relationId: 'f1', label: '前置', role: 'fieldIsPrereq' },
        { relationId: 'f2', label: '阻塞', role: 'fieldIsPrereq' },
      ],
    },
  )

  const depEdges = data.edges.filter((e) => e.kind === 'dependency')
  assert.equal(depEdges.length, 1)
  assert.equal(depEdges[0].relationId, 'f1')
})

test('父子边带 parentFieldId 作为 relationId', () => {
  // 注意：父子关系是附加信息，不单独撑起节点（种子只看依赖）。
  // 所以这里给 P 一条依赖，让闭包把父子关系一起拉进来。
  const data = buildGraphData(
    [
      task('X'),
      task('P', { prerequisites: ['X'] }),
      task('C1', { parentRecordId: 'P' }),
    ],
    { parentFieldId: 'fldParent', parentRole: 'fieldIsParent', parentLabel: '父记录' },
  )

  const parentEdge = data.edges.find((e) => e.kind === 'parent')
  assert.equal(parentEdge?.relationId, 'fldParent')
  assert.equal(parentEdge?.source, 'P')
  assert.equal(parentEdge?.target, 'C1')
  assert.ok(data.relations.some((r) => r.relationId === 'fldParent' && r.kind === 'parent'))
})

test('只有父子关系、没有任何依赖时不产生图（种子只看依赖）', () => {
  const data = buildGraphData([task('P'), task('C1', { parentRecordId: 'P' })], {
    parentFieldId: 'fldParent',
  })
  assert.deepEqual(data.nodes, [])
})

test('只有已完成任务时不会凭空生出节点', () => {
  const data = buildGraphData([
    task('A', { status: ['已完成'] }),
    task('B', { status: ['已完成'], prerequisites: ['A'] }),
  ])
  assert.deepEqual(data.nodes, [])
  assert.deepEqual(data.edges, [])
})
