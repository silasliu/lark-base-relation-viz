import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateConfig, DEFAULT_CONFIG } from '../src/services/configSchema.ts'

test('v1 配置迁移到 v2：单字段变成数组', () => {
  const migrated = migrateConfig({
    version: 1,
    tableId: 'tbl1',
    dependencyFieldId: 'fldDep',
    dependencyRole: 'fieldIsSuccessor',
    parentFieldId: 'fldParent',
    parentRole: 'fieldIsParent',
    layout: 'force',
    confirmed: true,
    schemeNoticeDismissed: false,
    showParent: false,
    sidebarCollapsed: true,
  })

  assert.equal(migrated.version, 2)
  assert.deepEqual(migrated.dependencyFieldIds, ['fldDep'])
  assert.equal(migrated.tableId, 'tbl1')
  assert.equal(migrated.dependencyRole, 'fieldIsSuccessor')
  assert.equal(migrated.parentFieldId, 'fldParent')
  assert.equal(migrated.layout, 'force')
  assert.equal(migrated.showParent, false)
  assert.equal(migrated.sidebarCollapsed, true)
})

test('v2 配置原样读取', () => {
  const migrated = migrateConfig({
    version: 2,
    tableId: 'tbl1',
    dependencyFieldIds: ['f1', 'f2'],
    layout: 'radial',
  })
  assert.deepEqual(migrated.dependencyFieldIds, ['f1', 'f2'])
  assert.equal(migrated.layout, 'radial')
})

test('v2 里只有旧的单字段时也能读出来', () => {
  const migrated = migrateConfig({ version: 2, dependencyFieldId: 'legacy' })
  assert.deepEqual(migrated.dependencyFieldIds, ['legacy'])
})

test('字段 id 去重、去空', () => {
  const migrated = migrateConfig({
    version: 2,
    dependencyFieldIds: ['f1', 'f1', '', '   ', 'f2'],
  })
  assert.deepEqual(migrated.dependencyFieldIds, ['f1', 'f2'])
})

test('未知版本回落到默认值', () => {
  assert.deepEqual(migrateConfig({ version: 99, dependencyFieldIds: ['x'] }), DEFAULT_CONFIG)
  assert.deepEqual(migrateConfig(null), DEFAULT_CONFIG)
  assert.deepEqual(migrateConfig('nope'), DEFAULT_CONFIG)
})

test('非法布局名回落到默认布局，而不是让图打不开', () => {
  const migrated = migrateConfig({ version: 2, layout: '不存在的布局' })
  assert.equal(migrated.layout, DEFAULT_CONFIG.layout)
})

test('布尔字段类型不对时用默认值', () => {
  const migrated = migrateConfig({ version: 2, showParent: 'yes', sidebarCollapsed: 1 })
  assert.equal(migrated.showParent, true)
  assert.equal(migrated.sidebarCollapsed, false)
})

test('迁移不会修改传入对象', () => {
  const raw = { version: 1, dependencyFieldId: 'fldDep' }
  migrateConfig(raw)
  assert.deepEqual(raw, { version: 1, dependencyFieldId: 'fldDep' })
})
