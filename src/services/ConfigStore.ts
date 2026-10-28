import { bitable } from '@lark-base-open/js-sdk'
import { DEFAULT_CONFIG, migrateConfig, type PersistedConfig } from './configSchema'

export type { PersistedConfig, DependencyRole, ParentRole } from './configSchema'
export { DEFAULT_CONFIG }

/**
 * 存储 key 保持 v1 不变：这样旧数据能被读到并迁移到 v2，
 * 换 key 等于把用户已有的设置全部丢掉。
 */
const KEY = 'dependency-graph/config/v1'
/** 非宿主环境下 bridge 可能永不 resolve，必须自己兜底 */
const BRIDGE_TIMEOUT_MS = 3000

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), BRIDGE_TIMEOUT_MS)),
  ])
}

/**
 * 配置持久化到飞书 Bridge（同一文档的同一插件共享）。
 * 任何读写失败都静默降级——受限环境下不能让图打不开。
 */
export async function loadConfig(): Promise<PersistedConfig> {
  const data = await withTimeout(
    bitable.bridge.getData<unknown>(KEY),
    null as unknown,
  )
  return migrateConfig(data)
}

export async function saveConfig(config: PersistedConfig): Promise<void> {
  // 静默降级：无痕模式/权限受限/非宿主环境时无法持久化，不影响本次使用
  await withTimeout(bitable.bridge.setData(KEY, config), undefined)
}
