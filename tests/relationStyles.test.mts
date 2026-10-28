import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveRelationStyles,
  fallbackStyle,
  lineDashCss,
} from '../src/services/relationStyles.ts'

const twoDeps = [
  { relationId: 'f1', kind: 'dependency' as const, label: '前置' },
  { relationId: 'f2', kind: 'dependency' as const, label: '阻塞' },
]

test('两种依赖关系拿到不同的线型或箭头', () => {
  const styles = resolveRelationStyles(twoDeps)
  const a = styles.get('f1')!
  const b = styles.get('f2')!

  assert.equal(a.arrow, 'filled')
  assert.equal(a.lineDash, undefined)
  assert.notEqual(b.arrow, a.arrow)
  assert.ok(b.lineDash && b.lineDash.length > 0)
})

test('第一种依赖关系保持已验证的实线 + 实心箭头外观', () => {
  const styles = resolveRelationStyles(twoDeps)
  const first = styles.get('f1')!
  assert.equal(first.lineWidth, 1.5)
  assert.equal(first.arrow, 'filled')
  assert.equal(first.lineDash, undefined)
})

test('父子关系固定灰色虚线、无箭头', () => {
  const styles = resolveRelationStyles([
    { relationId: 'fldParent', kind: 'parent', label: '父记录' },
  ])
  const parent = styles.get('fldParent')!
  assert.equal(parent.arrow, 'none')
  assert.deepEqual(parent.lineDash, [3, 3])
})

test('样式分配是确定性的，与传入顺序无关', () => {
  const a = resolveRelationStyles(twoDeps)
  const b = resolveRelationStyles([twoDeps[1], twoDeps[0]])

  assert.deepEqual(a.get('f1'), b.get('f1'))
  assert.deepEqual(a.get('f2'), b.get('f2'))
})

test('依赖关系排在父子关系之前（图例顺序）', () => {
  const styles = resolveRelationStyles([
    { relationId: 'p', kind: 'parent', label: '父记录' },
    { relationId: 'f1', kind: 'dependency', label: '前置' },
  ])
  assert.ok(styles.get('f1')!.order < styles.get('p')!.order)
})

test('三种以上依赖关系循环复用变体，但不会崩', () => {
  const styles = resolveRelationStyles([
    { relationId: 'f1', kind: 'dependency', label: 'A' },
    { relationId: 'f2', kind: 'dependency', label: 'B' },
    { relationId: 'f3', kind: 'dependency', label: 'C' },
    { relationId: 'f4', kind: 'dependency', label: 'D' },
  ])
  assert.equal(styles.size, 4)
  assert.equal(styles.get('f4')!.arrow, styles.get('f1')!.arrow)
})

test('未声明关系时按 kind 兜底', () => {
  assert.equal(fallbackStyle('parent').arrow, 'none')
  assert.equal(fallbackStyle('dependency').arrow, 'filled')
})

test('图例虚线节奏映射', () => {
  assert.equal(lineDashCss(fallbackStyle('dependency')), 'solid')
  assert.equal(lineDashCss(fallbackStyle('parent')), 'dotted')
  assert.equal(lineDashCss(resolveRelationStyles(twoDeps).get('f2')!), 'dashed')
})
