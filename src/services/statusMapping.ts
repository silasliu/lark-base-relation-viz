import type { TaskState } from '../types'

/**
 * 状态选项 → 完成判定（纯逻辑，可单测）。
 *
 * 为什么不用「代码里写死哪些词算完成」：
 * 每张表的状态选项都是自己定的（待评审 / 已归档 / 阻塞中…），
 * 猜词一定会猜错。这里改成由用户在界面上勾选，代码只负责套用映射。
 *
 * 匹配用「选项 id 与名称的并集」：不同 SDK 版本返回的单元格有时是
 * `{ id, text }`，有时只有名称，两边都放进去就不会因为形状不同而漏判。
 */

/** 一条记录的完成状态：命中任一勾选选项就算已完成 */
export function stateFromKeys(keys: string[], doneKeys: Set<string>): Exclude<TaskState, 'unknown'> {
  if (keys.length === 0) return 'todo'
  return keys.some((k) => doneKeys.has(k)) ? 'done' : 'todo'
}

/** 名字里带「未完成 / 未开始」这类否定语义的，不要误判成完成 */
const NOT_DONE = /未完成|未开始|未办|未做|not\s*done|todo|pending|打开|进行中/i
/** 名字里带完成语义的，默认勾上 */
const DONE = /完成|done|closed|finish(ed)?|complete(d)?|已归档|归档/i

/**
 * 第一次选中某个状态字段时，按选项名称给一个初始猜测。
 * 用户改一次就持久化，之后不再猜。
 */
export function guessDoneKeys(options: Array<{ id: string; name: string }>): string[] {
  const out: string[] = []
  for (const option of options) {
    if (NOT_DONE.test(option.name)) continue
    if (!DONE.test(option.name)) continue
    // id 和名称都放进去，单元格返回哪种形状都能命中
    out.push(option.id, option.name)
  }
  return out
}
