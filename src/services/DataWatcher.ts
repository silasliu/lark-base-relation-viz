import { bitable } from '@lark-base-open/js-sdk'

export interface WatchOptions {
  tableId: string
  /** 参与绘图的字段 id，只有这些字段变化才需要重画 */
  relevantFieldIds: string[]
}

/**
 * 监听表格变更。
 *
 * 事件是「快车道」：宿主推送 onRecordModify 等，
 * 轮询是「兜底」：官方未承诺跨客户端编辑一定推送事件，所以用轻量的
 * getRecordIdList 比对做保底（8 秒可见时 / 60 秒隐藏时）。
 *
 * 返回 stop()，必须在 effect cleanup 里调用。
 */
export function watchTable(opts: WatchOptions, onChange: () => void): () => void {
  const relevant = new Set(opts.relevantFieldIds)
  const stops: Array<() => void> = []
  let stopped = false

  const fire = () => {
    if (!stopped) onChange()
  }

  // ── 1. 事件订阅（表级 API） ──
  void (async () => {
    try {
      const table = await bitable.base.getTableById(opts.tableId)
      if (stopped) return
      const t = table as unknown as {
        onRecordModify?: (cb: (ev: { data?: { fieldIds?: string[] } }) => void) => () => void
        onRecordAdd?: (cb: () => void) => () => void
        onRecordDelete?: (cb: () => void) => () => void
        onFieldAdd?: (cb: () => void) => () => void
        onFieldModify?: (cb: () => void) => () => void
        onFieldDelete?: (cb: () => void) => () => void
      }

      if (t.onRecordModify) {
        stops.push(
          t.onRecordModify((ev) => {
            const changed = ev?.data?.fieldIds ?? []
            // 空数组代表结构级变更（增删记录），必须放行
            if (changed.length && !changed.some((id) => relevant.has(id))) return
            fire()
          }),
        )
      }
      for (const name of ['onRecordAdd', 'onRecordDelete', 'onFieldAdd', 'onFieldModify', 'onFieldDelete'] as const) {
        const fn = t[name]
        if (typeof fn === 'function') {
          stops.push(fn.call(t, fire))
        }
      }
    } catch {
      // 事件订阅失败不致命，轮询兜底
    }
  })()

  // ── 2. 轮询兜底：只比 ID 列表，轻量 ──
  let timer: number | undefined
  let knownIds: string | null = null
  let polling = false

  const pollOnce = async () => {
    if (stopped || polling) return
    polling = true
    try {
      const table = await bitable.base.getTableById(opts.tableId)
      const ids = ((await table.getRecordIdList()) || []).filter(Boolean).join(',')
      if (knownIds === null) knownIds = ids
      else if (knownIds !== ids) {
        knownIds = ids
        fire()
      }
    } catch {
      // 宿主抖动，静默等下一轮
    } finally {
      polling = false
    }
  }

  const schedule = () => {
    window.clearTimeout(timer)
    const delay = document.visibilityState === 'hidden' ? 60_000 : 8_000
    timer = window.setTimeout(async () => {
      await pollOnce()
      if (!stopped) schedule()
    }, delay)
  }
  schedule()

  const onVisible = () => {
    if (document.visibilityState === 'visible') void pollOnce()
  }
  document.addEventListener('visibilitychange', onVisible)

  return () => {
    stopped = true
    window.clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisible)
    for (const stop of stops) {
      try {
        stop()
      } catch {
        // 已注销
      }
    }
  }
}
