import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraphData } from '../src/services/graphBuilder.ts'
import { stateFromKeys, guessDoneKeys } from '../src/services/statusMapping.ts'
import type { BaseTask, TaskState } from '../src/types.ts'

function task(recordId: string, state: TaskState, extra: Partial<BaseTask> = {}): BaseTask {
  return {
    recordId,
    title: recordId,
    status: [],
    statusKeys: [],
    state,
    tags: [],
    prerequisites: [],
    ...extra,
  }
}

// ── 完成判定 ──

test('命中任一勾选选项就算已完成（选项 id 或名称都能匹配）', () => {
  const done = new Set(['opt_done', '已完成'])
  assert.equal(stateFromKeys(['opt_done'], done), 'done')
  assert.equal(stateFromKeys(['已完成'], done), 'done')
  assert.equal(stateFromKeys(['opt_todo', '进行中'], done), 'todo')
})

test('没有状态值算未完成', () => {
  assert.equal(stateFromKeys([], new Set(['已完成'])), 'todo')
})

test('什么都没勾选时，任何记录都不算完成', () => {
  assert.equal(stateFromKeys(['已完成'], new Set()), 'todo')
})

test('初始猜测：完成类选项默认勾上，否定语义不会被误判', () => {
  const keys = guessDoneKeys([
    { id: 'o1', name: '打开' },
    { id: 'o2', name: '进行中' },
    { id: 'o3', name: '已完成' },
    { id: 'o4', name: '未完成' },
    { id: 'o5', name: 'Done' },
  ])
  assert.ok(keys.includes('o3'))
  assert.ok(keys.includes('已完成'))
  assert.ok(keys.includes('o5'))
  assert.ok(!keys.includes('o1'))
  assert.ok(!keys.includes('o4'))
  assert.ok(!keys.includes('未完成'))
  assert.ok(!keys.includes('o2'))
})

// ── 图构建 ──

test('没有状态字段的表也能画出图', () => {
  // 「每日赏金统计」那张表的根因就是这条：unknown 被当成已完成，一条都不进图
  const data = buildGraphData([
    task('A', 'unknown'),
    task('B', 'unknown', { prerequisites: ['A'] }),
  ])
  assert.equal(data.nodes.length, 2)
  assert.equal(data.edges.length, 1)
})

test('状态未知时边是中性色，不会装成「正在阻塞」', () => {
  const data = buildGraphData([
    task('A', 'unknown'),
    task('B', 'unknown', { prerequisites: ['A'] }),
  ])
  assert.equal(data.edges[0].state, 'neutral')
})

test('一端未知也是中性，不做判断', () => {
  const data = buildGraphData([
    task('A', 'done'),
    task('B', 'unknown', { prerequisites: ['A'] }),
  ])
  assert.equal(data.edges[0].state, 'neutral')
})

test('有状态时三态正常：blocked / ready / idle', () => {
  const data = buildGraphData([
    task('A', 'todo'),
    task('B', 'todo', { prerequisites: ['A'] }),
  ])
  assert.equal(data.edges[0].state, 'blocked')

  const ready = buildGraphData([
    task('A', 'done'),
    task('B', 'todo', { prerequisites: ['A'] }),
  ])
  assert.equal(ready.edges[0].state, 'ready')

  const idle = buildGraphData([
    task('A', 'todo'),
    task('B', 'done', { prerequisites: ['A'] }),
  ])
  assert.equal(idle.edges[0].state, 'idle')
})

test('全部已完成时不凭空生出节点', () => {
  const data = buildGraphData([
    task('A', 'done'),
    task('B', 'done', { prerequisites: ['A'] }),
  ])
  assert.equal(data.nodes.length, 0)
})

test('未知状态的下游也计入传递阻塞数', () => {
  const data = buildGraphData([
    task('A', 'todo'),
    task('B', 'unknown', { prerequisites: ['A'] }),
    task('C', 'unknown', { prerequisites: ['B'] }),
  ])
  assert.equal(data.nodes.find((n) => n.recordId === 'A')?.blocksCount, 2)
})
