/**
 * 一条任务记录（已从 Base 单元格归一化）
 */
export interface BaseTask {
  /** Base 记录 id，作为节点唯一标识 */
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
  /** 前置任务的 recordId 列表（依赖字段） */
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
  /** 节点 id，等于 recordId */
  id: string;
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
 * 图边。kind 区分两类关系：
 * - dependency：任务 → 前置，箭头指向前置
 *   红=前置未完成（正在阻塞）、绿=前置已完成（通畅）、灰=当前任务已完成（关系已无行动意义）
 * - parent：父任务 → 子任务（滴答父子关系），灰色虚线
 */
export interface GraphEdge {
  source: string;
  target: string;
  kind: 'dependency' | 'parent';
  /** 仅依赖边：前置是否已完成 */
  prerequisiteComplete?: boolean;
  /** 仅依赖边：任务自身是否已完成（已完成则整条边弱化成灰） */
  sourceComplete?: boolean;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
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

/** 构建图时的语义选项 */
export interface BuildOptions {
  dependencyRole?: DependencyRole
  parentRole?: ParentRole
};

/** 图对外暴露的控制接口 */
export interface GraphApi {
  /** 定位到某个节点（居中） */
  focus(nodeId: string): void;
  /** 显示全部 */
  fit(): void;
}
