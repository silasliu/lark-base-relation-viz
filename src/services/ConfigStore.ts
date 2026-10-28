import { bitable } from '@lark-base-open/js-sdk'
import type { LayoutMode } from '../types'

const KEY = 'dependency-graph/config/v1'
/** 非宿主环境下 bridge 可能永不 resolve，必须自己兜底 */
const BRIDGE_TIMEOUT_MS = 3000

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), BRIDGE_TIMEOUT_MS)),
  ])
}

/** 依赖字段里装的是「前置」还是「后续」（单向关联语义方向不确定，必须由用户确认） */
export type DependencyRole = 'fieldIsPrereq' | 'fieldIsSuccessor'
/** 父子字段里装的是「父」还是「子」 */
export type ParentRole = 'fieldIsParent' | 'fieldIsChild'

export interface PersistedConfig {
  version: 1
  tableId?: string
  dependencyFieldId?: string
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
  version: 1,
  dependencyRole: 'fieldIsPrereq',
  parentRole: 'fieldIsParent',
  layout: 'dagre-tb',
  confirmed: false,
  schemeNoticeDismissed: false,
  showParent: true,
  sidebarCollapsed: false,
}

/**
 * 配置持久化到飞书 Bridge（同一文档的同一插件共享）。
 * 任何读写失败都静默降级——受限环境下不能让图打不开。
 */
export async function loadConfig(): Promise<PersistedConfig> {
  const data = await withTimeout(
    bitable.bridge.getData<PersistedConfig>(KEY),
    null as PersistedConfig | null,
  )
  if (!data || data.version !== 1) return { ...DEFAULT_CONFIG }
  return { ...DEFAULT_CONFIG, ...data }
}

export async function saveConfig(config: PersistedConfig): Promise<void> {
  // 静默降级：无痕模式/权限受限/非宿主环境时无法持久化，不影响本次使用
  await withTimeout(bitable.bridge.setData(KEY, config), undefined)
}
