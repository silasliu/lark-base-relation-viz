/**
 * 选哪张表来画图（纯逻辑，可单测）。
 *
 * 顺序：**正在看的表 → 上次选的表 → 第一张**。
 *
 * 为什么「正在看的表」优先：用户是照着 Base 界面里（URL 的 `?table=`）那张表
 * 打开插件的。以前盲选「第一张表」，多表 Base 里会直接打开另一张表，
 * 那张表很可能没有自关联字段，表现就是「什么都显示不出来」。
 */

export interface TableChoiceInput {
  /** 当前 Base 里所有表的 id */
  available: string[]
  /** Base 界面里正在打开的表（拿不到时为 undefined） */
  activeId?: string
  /** 上次持久化的选择 */
  savedId?: string
}

export function chooseTableId({ available, activeId, savedId }: TableChoiceInput): string | undefined {
  if (available.length === 0) return undefined
  const usable = (id?: string) => (id && available.includes(id) ? id : undefined)
  return usable(activeId) ?? usable(savedId) ?? available[0]
}
