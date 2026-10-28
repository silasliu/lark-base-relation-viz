import test from 'node:test'
import assert from 'node:assert/strict'
import { readAllPages } from '../src/services/pagination.ts'

test('超过 200 条时按 number 令牌翻页，第二页不再传字符串', async () => {
  const seen: Array<number | undefined> = []
  let call = 0
  const all = await readAllPages(async (token) => {
    seen.push(token)
    call += 1
    if (call === 1) {
      return {
        records: Array.from({ length: 200 }, (_, i) => ({ id: i })),
        hasMore: true,
        pageToken: 1,
        total: 250,
      }
    }
    return {
      records: Array.from({ length: 50 }, (_, i) => ({ id: 200 + i })),
      hasMore: false,
      total: 250,
    }
  })

  assert.equal(all.length, 250)
  assert.deepEqual(seen, [undefined, 1])
  // 这条断言就是这次 bug 的核心：token 必须是 number，不能是 '1'
  assert.equal(typeof seen[1], 'number')
})

test('pageToken 为 0 时仍然继续翻页（0 是合法令牌）', async () => {
  const calls: Array<number | undefined> = []
  let call = 0
  const all = await readAllPages(async (token) => {
    calls.push(token)
    call += 1
    if (call === 1) return { records: [{ id: 'a' }], hasMore: true, pageToken: 0 }
    return { records: [{ id: 'b' }], hasMore: false }
  })

  assert.equal(all.length, 2)
  assert.deepEqual(calls, [undefined, 0])
})

test('分页标记重复时报错，不会死循环', async () => {
  await assert.rejects(
    () => readAllPages(async () => ({ records: [{ id: 1 }], hasMore: true, pageToken: 7 })),
    /分页标记重复/,
  )
})

test('hasMore 却没有令牌时报错，而不是静默截断', async () => {
  await assert.rejects(
    () => readAllPages(async () => ({ records: [{ id: 1 }], hasMore: true })),
    /没有返回有效的分页标记/,
  )
})

test('单页取数失败时错误信息包含已读条数', async () => {
  let call = 0
  await assert.rejects(
    () =>
      readAllPages(async () => {
        call += 1
        if (call === 1) return { records: [{ id: 1 }], hasMore: true, pageToken: 3 }
        throw new Error('table operation parameter exception error')
      }),
    (err: Error) => {
      assert.match(err.message, /已读到 1 条/)
      assert.match(err.message, /table operation parameter exception error/)
      return true
    },
  )
})

test('页数上限保护', async () => {
  await assert.rejects(
    () =>
      readAllPages(
        async (token) => ({
          records: [{ id: token ?? 0 }],
          hasMore: true,
          pageToken: (token ?? 0) + 1,
        }),
        { maxPages: 3 },
      ),
    /页上限/,
  )
})

test('进度回调给出已读条数与总数', async () => {
  const progress: Array<[number, number | undefined]> = []
  let call = 0
  await readAllPages(
    async () => {
      call += 1
      if (call === 1) {
        return {
          records: Array.from({ length: 200 }, (_, i) => ({ id: i })),
          hasMore: true,
          pageToken: 1,
          total: 250,
        }
      }
      return { records: Array.from({ length: 50 }, (_, i) => ({ id: 200 + i })), hasMore: false, total: 250 }
    },
    { onProgress: (loaded, total) => progress.push([loaded, total]) },
  )

  assert.deepEqual(progress, [
    [200, 250],
    [250, 250],
  ])
})

test('空表返回空数组，不会卡住', async () => {
  const all = await readAllPages(async () => ({ records: [], hasMore: false, total: 0 }))
  assert.deepEqual(all, [])
})
