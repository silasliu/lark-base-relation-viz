import test from 'node:test'
import assert from 'node:assert/strict'
import { computeExportSize, exportFileName, EXPORT_MAX_EDGE } from '../src/services/exportImage.ts'

test('小图不放大，原样导出', () => {
  const size = computeExportSize(800, 600)
  assert.equal(size.width, 800)
  assert.equal(size.height, 600)
  assert.equal(size.scaled, false)
})

test('大图按最长边压到 4096', () => {
  const size = computeExportSize(12000, 5000)
  assert.equal(size.width, EXPORT_MAX_EDGE)
  assert.equal(size.height, 1707)
  assert.equal(size.scaled, true)
})

test('超高图按高度压，宽高比保持', () => {
  const size = computeExportSize(1000, 20000)
  assert.equal(size.height, EXPORT_MAX_EDGE)
  assert.equal(size.width, 205)
})

test('面积超限时进一步压缩（防 Safari canvas 空白）', () => {
  const size = computeExportSize(4096, 4096)
  assert.ok(size.width * size.height <= 16_000_000)
  assert.ok(size.width <= 4096 && size.height <= 4096)
  // 等比：正方形压完还是正方形
  assert.equal(size.width, size.height)
})

test('非法尺寸回落到 1×1 而不是 NaN', () => {
  for (const [w, h] of [
    [0, 100],
    [100, 0],
    [Number.NaN, 100],
    [-5, -5],
  ]) {
    const size = computeExportSize(w as number, h as number)
    assert.equal(size.width, 1)
    assert.equal(size.height, 1)
  }
})

test('导出文件名带时间戳，不含非法字符', () => {
  const name = exportFileName(new Date(2026, 9, 29, 10, 30))
  assert.equal(name, '依赖图-20261029-1030.png')
  assert.doesNotMatch(name, /[:\\/*?"<>|]/)
})
