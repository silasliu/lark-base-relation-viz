/**
 * 关联字段单元格 → recordId 列表（纯逻辑，可单测）。
 *
 * 为什么单独抽出来：飞书不同版本 / 不同关联字段类型（单向关联、双向关联）
 * 返回的单元格结构并不完全一样。这里把所有见过的形状都收一遍，
 * 否则「字段里有值，但插件认为没有关系」这种问题只能靠线上猜。
 */

/** 飞书记录 id 形如 recXXXXXXXXXXXX */
const RECORD_ID_RE = /^rec[A-Za-z0-9_-]{6,}$/

function pushId(target: string[], id: unknown): void {
  if (typeof id !== 'string') return
  const text = id.trim()
  if (!text || target.includes(text)) return
  target.push(text)
}

/** 关联字段 → recordId 列表（兼容 recordIds / record_ids / recordId / id / 纯字符串） */
export function cellToRecordIds(value: unknown): string[] {
  if (value == null) return []
  const items = Array.isArray(value) ? value : [value]
  const ids: string[] = []

  for (const item of items) {
    if (item == null) continue

    // 少数版本直接给 recordId 数组
    if (typeof item === 'string') {
      if (RECORD_ID_RE.test(item)) pushId(ids, item)
      continue
    }
    if (typeof item !== 'object') continue

    const link = item as {
      recordIds?: unknown
      record_ids?: unknown
      recordId?: unknown
      id?: unknown
    }

    if (Array.isArray(link.recordIds)) {
      for (const id of link.recordIds) pushId(ids, id)
    }
    if (Array.isArray(link.record_ids)) {
      for (const id of link.record_ids) pushId(ids, id)
    }
    pushId(ids, link.recordId)
    // 只在形状像记录 id 时才认 `id`，避免把别的标量当成关联
    if (typeof link.id === 'string' && RECORD_ID_RE.test(link.id)) pushId(ids, link.id)
  }

  return ids
}

/** 单元格看起来是不是「关联记录引用」（mock 扫描字段用） */
export function looksLikeLinkCell(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false
  const first = value[0]
  if (!first || typeof first !== 'object') return false
  const link = first as { recordIds?: unknown; record_ids?: unknown; recordId?: unknown; id?: unknown }
  return (
    Array.isArray(link.recordIds) ||
    Array.isArray(link.record_ids) ||
    typeof link.recordId === 'string' ||
    (typeof link.id === 'string' && RECORD_ID_RE.test(link.id))
  )
}

/**
 * 单选 / 多选单元格 → 选项 key（选项 id 与名称的并集）。
 *
 * 不同版本返回 `{ id, text }`、`{ id, name }` 或纯字符串，
 * 这里全部收下来，完成判定时再用「id 或名称」任一命中即可。
 */
export function cellToOptionKeys(value: unknown): string[] {
  if (value == null) return []
  const items = Array.isArray(value) ? value : [value]
  const keys: string[] = []
  const push = (raw: unknown) => {
    if (typeof raw !== 'string') return
    const text = raw.trim()
    if (text && !keys.includes(text)) keys.push(text)
  }

  for (const item of items) {
    if (item == null) continue
    if (typeof item === 'string') {
      push(item)
      continue
    }
    if (typeof item !== 'object') continue
    const option = item as { id?: unknown; text?: unknown; name?: unknown }
    push(option.id)
    push(option.text)
    push(option.name)
  }
  return keys
}
