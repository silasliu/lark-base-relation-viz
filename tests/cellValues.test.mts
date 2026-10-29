import test from 'node:test'
import assert from 'node:assert/strict'
import { cellToRecordIds, looksLikeLinkCell } from '../src/services/cellValues.ts'

test('双向关联：recordIds 数组', () => {
  assert.deepEqual(cellToRecordIds([{ recordIds: ['recAAA111111'] }]), ['recAAA111111'])
})

test('兼容 record_ids 下划线写法', () => {
  assert.deepEqual(cellToRecordIds([{ record_ids: ['recBBB222222'] }]), ['recBBB222222'])
})

test('单向关联：单项 recordId', () => {
  assert.deepEqual(cellToRecordIds([{ recordId: 'recCCC333333' }]), ['recCCC333333'])
})

test('只有 id + text 的引用也能认出来', () => {
  assert.deepEqual(cellToRecordIds([{ id: 'recDDD444444', text: '12-30' }]), ['recDDD444444'])
})

test('纯 recordId 字符串数组', () => {
  assert.deepEqual(cellToRecordIds(['recEEE555555']), ['recEEE555555'])
})

test('不把展示文本当成记录 id', () => {
  assert.deepEqual(cellToRecordIds([{ text: '12-30' }]), [])
  assert.deepEqual(cellToRecordIds([{ id: 'not-a-record-id' }]), [])
})

test('空值安全', () => {
  assert.deepEqual(cellToRecordIds(null), [])
  assert.deepEqual(cellToRecordIds(undefined), [])
  assert.deepEqual(cellToRecordIds([]), [])
})

test('多值去重保序', () => {
  assert.deepEqual(
    cellToRecordIds([{ recordIds: ['recA111111', 'recB222222', 'recA111111'] }]),
    ['recA111111', 'recB222222'],
  )
})

test('looksLikeLinkCell 与实际解析保持一致', () => {
  assert.equal(looksLikeLinkCell([{ recordIds: ['recA111111'] }]), true)
  assert.equal(looksLikeLinkCell([{ recordId: 'recA111111' }]), true)
  assert.equal(looksLikeLinkCell([{ id: 'recA111111', text: 'x' }]), true)
  assert.equal(looksLikeLinkCell([{ text: '12-30' }]), false)
  assert.equal(looksLikeLinkCell([]), false)
  assert.equal(looksLikeLinkCell(null), false)
})
