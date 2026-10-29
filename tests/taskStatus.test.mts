import test from 'node:test'
import assert from 'node:assert/strict'
import { isIncomplete, buildGraphData } from '../src/services/graphBuilder.ts'
import type { BaseTask } from '../src/types.ts'

function task(recordId: string, extra: Partial<BaseTask> = {}): BaseTask {
  return {
    recordId,
    title: recordId,
    status: [],
    tags: [],
    prerequisites: [],
    ...extra,
  }
}

test('没有状态字段 / 状态为空 → 算未完成', () => {
  // 这条是「每日赏金统计」那张表的根因：没有状态字段，以前被判成全部已完成，
  // 于是没有任何种子任务，整张表都进不了图
  assert.equal(isIncomplete(undefined), true)
  assert.equal(isIncomplete([]), true)
  assert.equal(isIncomplete(''), true)
  assert.equal(isIncomplete(['']), true)
})

test('明确的完成类状态 → 已完成', () => {
  for (const s of ['已完成', '完成', 'done', 'closed', 'completed', '已关闭']) {
    assert.equal(isIncomplete([s]), false, s)
  }
})

test('进行中 / 打开 → 未完成', () => {
  for (const s of ['打开', '进行中', 'open', 'in_progress', 'todo']) {
    assert.equal(isIncomplete([s]), true, s)
  }
})

test('认不出来的状态词按未完成处理', () => {
  assert.equal(isIncomplete(['待评审']), true)
})

test('没有状态字段的表也能画出图', () => {
  const data = buildGraphData([
    task('A'),
    task('B', { prerequisites: ['A'] }),
  ])
  assert.equal(data.nodes.length, 2)
  assert.equal(data.edges.length, 1)
})

test('有状态字段时，已完成的任务仍会被排除在种子之外', () => {
  const data = buildGraphData([
    task('A', { status: ['已完成'] }),
    task('B', { status: ['已完成'], prerequisites: ['A'] }),
  ])
  assert.equal(data.nodes.length, 0)
})
