/**
 * 持久化配置的 schema 与迁移（纯逻辑，可单测）。
 *
 * v1 → v2 的变化：
 * - 单个 `dependencyFieldId` 变成 `dependencyFieldIds: string[]`，
 *   以支持「同一张表里同时显示多种依赖关系」。
 * - 多表共同显示本轮不暴露 UI，但配置结构已经按列表设计，
 *   以后只是把数组从「字段」扩到「数据源」，不需要再改版本号。
 *
 * 迁移原则：宁可回落到默认值，也不让旧配置把图打不开。
 */

import type { LayoutMode, DependencyRole, ParentRole } from '../types'

export type { DependencyRole, ParentRole }

export const LAYOUT_MODES: LayoutMode[] = ['dagre-tb', 'dagre-lr', 'force', 'circular', 'radial']

export interface PersistedConfig {
  version: 2
  tableId?: string
  /** 参与绘制的依赖字段，第一个为主字段 */
  dependencyFieldIds: string[]
  dependencyRole: DependencyRole
  parentFieldId?: string
  parentRole: ParentRole
  layout: LayoutMode
  /** 用户确认过字段方向，不再弹确认条 */
  confirmed: boolean
  /** 用户已知晓 scheme 会弹一次系统确认 */
  schemeNoticeDismissed: boolean
  /** 是否在图中显示父子关系 */
  showParent?: boolean
  /** 侧栏是否收起 */
  sidebarCollapsed?: boolean
}

export const DEFAULT_CONFIG: PersistedConfig = {
  version: 2,
  dependencyFieldIds: [],
  dependencyRole: 'fieldIsPrereq',
  parentRole: 'fieldIsParent',
  layout: 'dagre-tb',
  confirmed: false,
  schemeNoticeDismissed: false,
  showParent: true,
  sidebarCollapsed: false,
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asLayout(value: unknown): LayoutMode {
  return LAYOUT_MODES.includes(value as LayoutMode) ? (value as LayoutMode) : DEFAULT_CONFIG.layout
}

function asDependencyRole(value: unknown): DependencyRole {
  return value === 'fieldIsSuccessor' ? 'fieldIsSuccessor' : 'fieldIsPrereq'
}

function asParentRole(value: unknown): ParentRole {
  return value === 'fieldIsChild' ? 'fieldIsChild' : 'fieldIsParent'
}

/** 去重、去空、保序 */
function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const text = asString(item)
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

/**
 * 把任意来源的数据迁移成当前版本。
 * - v2：原样读取，字段逐个校验
 * - v1：`dependencyFieldId` → `dependencyFieldIds: [id]`
 * - 其它：返回默认值
 */
export function migrateConfig(raw: unknown): PersistedConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG }
  const data = raw as Record<string, unknown>
  const version = data.version

  if (version !== 1 && version !== 2) return { ...DEFAULT_CONFIG }

  let dependencyFieldIds: string[]
  if (version === 2) {
    dependencyFieldIds = asStringList(data.dependencyFieldIds)
    // v2 里也可能只有旧的单字段（例如手工写入），兜一层
    if (dependencyFieldIds.length === 0) {
      const single = asString(data.dependencyFieldId)
      if (single) dependencyFieldIds = [single]
    }
  } else {
    const single = asString(data.dependencyFieldId)
    dependencyFieldIds = single ? [single] : []
  }

  return {
    version: 2,
    tableId: asString(data.tableId),
    dependencyFieldIds,
    dependencyRole: asDependencyRole(data.dependencyRole),
    parentFieldId: asString(data.parentFieldId),
    parentRole: asParentRole(data.parentRole),
    layout: asLayout(data.layout),
    confirmed: asBoolean(data.confirmed, DEFAULT_CONFIG.confirmed),
    schemeNoticeDismissed: asBoolean(
      data.schemeNoticeDismissed,
      DEFAULT_CONFIG.schemeNoticeDismissed,
    ),
    showParent: asBoolean(data.showParent, true),
    sidebarCollapsed: asBoolean(data.sidebarCollapsed, false),
  }
}
