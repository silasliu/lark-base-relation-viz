/**
 * 分页读取的纯逻辑。
 *
 * 为什么单独抽出来：
 * 飞书 SDK 的类型是 `type PageToken = number`。旧代码把 token 转成字符串再回传，
 * 宿主在第二页直接判定参数非法，于是超过 200 条的表永远读到第一页就报
 * `table operation parameter exception error`。这类问题在浏览器里无法复现，
 * 只能靠一个不依赖 SDK 的分页器 + 桩测试来锁住行为。
 *
 * 本模块不引入任何宿主依赖，可以直接在 Node 里跑单测。
 */

export interface PageResult<R> {
  records: R[]
  hasMore: boolean
  /** 与 SDK 的 PageToken 一致：number。0 是合法值，不能用真值判断 */
  pageToken?: number
  /** 服务端返回的总条数（SDK 的 IPageResponse 里有） */
  total?: number
}

export interface ReadAllPagesOptions {
  /** 最大页数保护，默认 500 页（×200 = 10 万条） */
  maxPages?: number
  /** 每读一页回调一次，用于「已读 N / M 条」进度 */
  onProgress?: (loaded: number, total?: number) => void
  /** 自定义失败文案，默认带已读条数 */
  describeError?: (err: unknown, loaded: number) => string
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 串行读完所有分页。
 *
 * 串行是刻意的：SDK 没有承诺并发翻页安全，正确性优先于速度。
 * 循环保护有三层：token 重复、页数上限、hasMore 但没有 token。
 */
export async function readAllPages<R>(
  fetchPage: (pageToken: number | undefined) => Promise<PageResult<R>>,
  options: ReadAllPagesOptions = {},
): Promise<R[]> {
  const maxPages = options.maxPages ?? 500
  const out: R[] = []
  const seenTokens = new Set<number>()
  let pageToken: number | undefined
  let pages = 0

  for (;;) {
    let page: PageResult<R>
    try {
      page = await fetchPage(pageToken)
    } catch (err) {
      throw new Error(
        options.describeError?.(err, out.length) ??
          `读取记录失败（已读到 ${out.length} 条）：${reasonOf(err)}`,
      )
    }

    if (Array.isArray(page?.records) && page.records.length > 0) {
      out.push(...page.records)
    }
    pages += 1

    const total =
      typeof page?.total === 'number' && Number.isFinite(page.total) && page.total >= 0
        ? page.total
        : undefined
    options.onProgress?.(out.length, total)

    if (!page?.hasMore) return out

    const next = page.pageToken
    // 关键：0 是合法 token。用 `next &&` 判断会把 0 当假值，直接漏读整页之后的记录
    if (typeof next !== 'number' || !Number.isFinite(next)) {
      throw new Error(
        `读取记录失败（已读到 ${out.length} 条）：接口表示还有更多记录，却没有返回有效的分页标记。`,
      )
    }
    if (seenTokens.has(next)) {
      throw new Error(
        `读取记录失败（已读到 ${out.length} 条）：分页标记重复（${next}），已停止以避免死循环。`,
      )
    }
    if (pages >= maxPages) {
      throw new Error(
        `读取记录失败（已读到 ${out.length} 条）：超过 ${maxPages} 页上限，请减少记录或换个视图后再试。`,
      )
    }
    seenTokens.add(next)
    pageToken = next
  }
}
