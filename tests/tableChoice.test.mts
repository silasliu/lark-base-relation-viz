import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseTableId } from '../src/services/tableChoice.ts'

const available = ['tblA', 'tblB', 'tblC']

test('优先用 Base 界面里正在看的那张表', () => {
  // 这条就是这次「打不开」的核心：以前会盲选 tblA
  assert.equal(chooseTableId({ available, activeId: 'tblB', savedId: 'tblA' }), 'tblB')
})

test('拿不到当前表时退回上次选择', () => {
  assert.equal(chooseTableId({ available, savedId: 'tblC' }), 'tblC')
})

test('都没有时用第一张', () => {
  assert.equal(chooseTableId({ available }), 'tblA')
})

test('当前表不在列表里（已删除）时不采用', () => {
  assert.equal(chooseTableId({ available, activeId: 'tblGone', savedId: 'tblC' }), 'tblC')
  assert.equal(chooseTableId({ available, activeId: 'tblGone', savedId: 'tblGone' }), 'tblA')
})

test('没有任何表时返回 undefined', () => {
  assert.equal(chooseTableId({ available: [], activeId: 'tblA' }), undefined)
})
