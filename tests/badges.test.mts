import test from 'node:test'
import assert from 'node:assert/strict'
import { badgeOf } from '../src/components/nodeMetrics.ts'
import type { GraphNode } from '../src/types.ts'

function node(patch: Partial<GraphNode>): GraphNode {
  return {
    id: 'n',
    recordId: 'n',
    label: 'n',
    emoji: '📌',
    title: 'n',
    rawTitle: 'n',
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
    ...patch,
  }
}

test('未完成：显示「阻塞：N」', () => {
  const badge = badgeOf(node({ isIncomplete: true, blocksCount: 2 }))
  assert.deepEqual(badge, { text: '阻塞：2', kind: 'block' })
})

test('已完成：同样的数字显示为「解锁：N」', () => {
  const badge = badgeOf(node({ isIncomplete: false, blocksCount: 2 }))
  assert.deepEqual(badge, { text: '解锁：2', kind: 'unlock' })
})

test('没有下游时不出徽标', () => {
  assert.equal(badgeOf(node({ isIncomplete: true, blocksCount: 0 })), null)
  assert.equal(badgeOf(node({ isIncomplete: false, blocksCount: 0 })), null)
})
