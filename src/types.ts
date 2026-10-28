import type { GraphRelation } from './services/relationStyles'

export type { GraphRelation } from './services/relationStyles'

/**
 * 一条任务记录（已从 Base 单元格归一化）
 */
export interface BaseTask {
  /** Base 记录 id（表内唯一，跨表不唯一） */
  recordId: string;
  /** 滴答任务 id，仅用于标识，可能为空 */
  didaId?: string;
  /** 原始标题（含 emoji，用于滴答搜索跳转） */
  title: string;
  /** 状态，可能为空 */
  status: string[];
  /** 标签 */
  tags: string[];
  /** 所属清单（分组字段） */
  listName?: string;
  /** 任务内容（多行文本） */
  description?: string;
  /** 截止时间（YYYY-MM-DD，Asia/Shanghai） */
  dueDate?: string;
  /**
   * 依赖字段 id → 该字段引用的 recordId 列表。
   * 支持同一张表里的多个关联字段同时作为依赖关系。
   */
  prerequisitesByField?: Record<string, string[]>;
  /** 所有依赖字段合并后的前置 recordId 列表（用于计数与遍历） */
  prerequisites: string[];
  /** 父任务的 recordId（父子字段，可空） */
  parentRecordId?: string;
  /** 滴答项目 id */
  projectId?: string;
}

/**
 * 图节点
 */
export interface GraphNode {
  /**
   * 节点 id。
   * 单表时等于 recordId；有多表命名空间时是 `${tableId}:${recordId}`，
   * 避免两张表里出现同名 recordId 时互相覆盖。
   */
  id: string;
  /** 表命名空间（tableId）；未启用多表时为空 */
  namespace?: string;
  /** 表内原始记录 id */
  recordId: string;
  /** 去掉 emoji 的纯净标题 */
  label: string;
  emoji: string;
  title: string;
  /** 原始标题（含 emoji），滴答搜索用 */
  rawTitle: string;
  dueDate?: string;
  /** 已逾期天数（正数 = 已逾期，仅未完成时计算） */
  overdueDays?: number;
  tags: string[];
  /** 所属清单 */
  listName?: string;
  /** 任务内容（多行文本） */
  description?: string;
  /** 状态文本（多个值以逗号连接） */
  status: string;
  /** 是否未完成 */
  isIncomplete: boolean;
  /** 是否依赖链末端（没有任务依赖它，仅按依赖边算） */
  isTerminal: boolean;
  /** 前置任务数量（依赖边） */
  prerequisiteCount: number;
  /** 后继任务数量（依赖边） */
  successorCount: number;
  /** 未完成的前置数量（阻塞程度：我被卡住多少） */
  blockingCount: number;
  /** 被本任务传递阻塞的后续数量（关键性：我卡住了多少下游未完成任务） */
  blocksCount: number;
  didaId?: string;
  projectId?: string;
  /** 关联任务标题（详情面板展示） */
  prerequisiteTitles: string[];
  successorTitles: string[];
  parentTitle?: string;
  childTitles: string[];
  /** 可点击跳转的关联任务引用 */
  prerequisiteRefs: LinkedTaskRef[];
  successorRefs: LinkedTaskRef[];
  parentRef?: LinkedTaskRef;
  childRefs: LinkedTaskRef[];
}

/**
 * 图边。
 *
 * 两个维度必须分开：
 * - `kind`：关系大类，决定语义（依赖 / 父子）
 * - `relationId`：具体是哪一条关系（通常是来源关联字段 id），
 *   样式（线型、箭头、线宽）由它从注册表里取，而不是写死在绘制代码里
 *
 * 颜色只表达状态，不表达关系：
 * - dependency：红 = 前置未完成（阻塞中）、绿 = 前置已完成（可推进）、
 *   灰 = 当前任务已完成（关系已无行动意义）
 * - parent：灰色虚线、无箭头
 */
export interface GraphEdge {
  source: string;
  target: string;
  kind: 'dependency' | 'parent';
  /** 关系 id（关联字段 id）。同一对记录只保留一条边，先到先得 */
  relationId: string;
  /** 仅依赖边：前置是否已完成 */
  prerequisiteComplete?: boolean;
  /** 仅依赖边：任务自身是否已完成（已完成则整条边弱化成灰） */
  sourceComplete?: boolean;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 图里实际用到的关系（图例与样式解析都读它） */
  relations: GraphRelation[];
}

/** 可选的数据表 */
export interface TableOption {
  id: string;
  name: string;
}

/** 可选的自关联字段 */
export interface LinkFieldOption {
  id: string;
  name: string;
  /** 关联目标表的 tableId */
  targetTableId: string;
}

/** 关联任务引用（带 id，可点击跳转） */
export interface LinkedTaskRef {
  id: string
  title: string
  emoji: string
  isIncomplete: boolean
}

/** 图布局模式 */
export type LayoutMode = 'dagre-tb' | 'dagre-lr' | 'force' | 'circular' | 'radial'

/** 依赖字段的方向语义：字段里装的是「前置」还是「后续」 */
export type DependencyRole = 'fieldIsPrereq' | 'fieldIsSuccessor'
/** 父子字段的方向语义：字段里装的是「父」还是「子」 */
export type ParentRole = 'fieldIsParent' | 'fieldIsChild'

/** 一条依赖关系的声明（每个关联字段一条） */
export interface DependencyRelationSpec {
  /** 通常是字段 id */
  relationId: string
  /** 展示名，通常是字段名 */
  label: string
  role: DependencyRole
}

/** 构建图时的语义选项 */
export interface BuildOptions {
  /** 节点 id 前缀（表 id）。为空时不加前缀，保持旧行为 */
  namespace?: string
  /** 参与绘制的依赖关系，可多条 */
  dependencyRelations?: DependencyRelationSpec[]
  /** 兼容旧调用：单依赖字段 + 方向 */
  dependencyFieldId?: string
  dependencyRole?: DependencyRole
  /** 兼容旧调用：单个依赖关系的展示名 */
  dependencyLabel?: string
  /** 父子关系字段 id；提供时才生成父子边 */
  parentFieldId?: string
  parentRole?: ParentRole
  /** 父子关系的展示名 */
  parentLabel?: string
}

/** 图对外暴露的控制接口 */
export interface GraphApi {
  /** 定位到某个节点（居中） */
  focus(nodeId: string): void;
  /** 显示全部：只适配视口，不改布局、不改折叠 */
  fit(): void;
  /** 整理：重新布局 + 消除重叠 + 适配全图 */
  arrange(): void;
  /** 导出整图为 PNG dataURL（不受当前视口限制） */
  captureFullImage(): Promise<string>;
}
