import { useMemo, useState } from 'react'
import type { GraphNode, GraphData } from '../types'
import { buildChecklist } from '../services/graphBuilder'

export interface ChecklistFilter {
  list?: string
  tag?: string
}

interface ChecklistPanelProps {
  data: GraphData
  selectedId?: string | null
  onLocate: (node: GraphNode) => void
  filter: ChecklistFilter
  onFilterChange: (f: ChecklistFilter) => void
  /**
   * 是否配置了「完成状态」字段。
   * 没有状态信息时，「可动手 / 被阻塞 / 已完成」三类根本分不出来，
   * 所以只保留「全部」，免得给出假的分类。
   */
  hasStatus?: boolean
}

type Section = 'ready' | 'blocked' | 'done' | 'all'

const SECTION_LABELS: Record<Section, string> = {
  ready: '✅ 可动手',
  blocked: '⛔ 被阻塞',
  done: '✔ 已完成',
  all: '全部',
}

const EMPTY_TEXT: Record<Section, string> = {
  ready: '没有可以立刻开始的任务',
  blocked: '没有被阻塞的任务 🎉',
  done: '还没有完成的任务',
  all: '没有任务',
}

export function ChecklistPanel({
  data,
  selectedId,
  onLocate,
  filter,
  onFilterChange,
  hasStatus = true,
}: ChecklistPanelProps) {
  const sections: Section[] = hasStatus ? ['ready', 'blocked', 'done', 'all'] : ['all']
  const [rawSection, setSection] = useState<Section>('ready')
  // 没有状态信息时退回「全部」
  const section: Section = sections.includes(rawSection) ? rawSection : 'all'
  const [query, setQuery] = useState('')

  const checklist = useMemo(() => buildChecklist(data), [data])

  const items = useMemo(() => {
    let list
    switch (section) {
      case 'ready':
        list = checklist.ready
        break
      case 'blocked':
        list = checklist.blocked
        break
      case 'done':
        list = checklist.done
        break
      default:
        list = [...checklist.ready, ...checklist.blocked, ...checklist.done]
    }

    if (filter.list) list = list.filter((i) => i.node.listName === filter.list)
    if (filter.tag) list = list.filter((i) => i.node.tags.includes(filter.tag!))

    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (i) =>
          i.node.label.toLowerCase().includes(q) ||
          (i.node.listName ?? '').toLowerCase().includes(q) ||
          i.node.tags.some((t) => t.toLowerCase().includes(q)),
      )
    }
    return list
  }, [checklist, section, query, filter])

  const hasFilter = Boolean(filter.list || filter.tag)

  return (
    <div className="checklist">
      <div className="checklist-search">
        <input
          className="checklist-input"
          type="text"
          placeholder="搜索任务 / 清单 / 标签…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="search-clear" title="清空" onClick={() => setQuery('')}>
            ×
          </button>
        )}
      </div>

      {hasFilter && (
        <div className="filter-chips">
          <span className="filter-label">筛选：</span>
          {filter.list && (
            <button className="filter-chip" onClick={() => onFilterChange({ ...filter, list: undefined })}>
              清单 {filter.list} <span className="chip-x">×</span>
            </button>
          )}
          {filter.tag && (
            <button className="filter-chip" onClick={() => onFilterChange({ ...filter, tag: undefined })}>
              标签 {filter.tag} <span className="chip-x">×</span>
            </button>
          )}
        </div>
      )}

      <div className="checklist-tabs">
        {sections.map((s) => (
          <button
            key={s}
            className={`checklist-tab ${section === s ? 'active' : ''}`}
            onClick={() => setSection(s)}
          >
            {SECTION_LABELS[s]}
            <span className="checklist-count">
              {s === 'ready' && checklist.ready.length}
              {s === 'blocked' && checklist.blocked.length}
              {s === 'done' && checklist.done.length}
              {s === 'all' && data.nodes.length}
            </span>
          </button>
        ))}
      </div>

      <div className="checklist-list">
        {items.length === 0 && (
          <div className="checklist-empty">
            {query ? `没找到包含「${query}」的任务` : hasFilter ? '当前筛选下没有任务' : EMPTY_TEXT[section]}
          </div>
        )}
        {items.map(({ node }) => (
          <button
            key={node.id}
            className={`checklist-item ${selectedId === node.id ? 'active' : ''} ${
              node.state === 'done' ? 'done' : ''
            }`}
            onClick={() => onLocate(node)}
            title={node.rawTitle}
          >
            <span className="checklist-item-title">
              {node.emoji} {node.label}
            </span>
            <span className="checklist-item-meta">
              {node.listName && <span className="meta-list">{node.listName}</span>}
              {node.dueDate && (
                <span className={node.overdueDays ? 'overdue' : ''}>
                  📅 {node.dueDate.slice(5)}
                  {node.overdueDays ? ` 逾期${node.overdueDays}天` : ''}
                </span>
              )}
              {node.state !== 'unknown' && node.blocksCount > 0 && (
                <span className="blocked-badge">
                  {node.state === 'done' ? '解锁' : '阻塞'} {node.blocksCount}
                </span>
              )}
              {node.prerequisiteCount > 0 && node.blockingCount === 0 && (
                <span className="prereq-badge">{node.prerequisiteCount} 前置</span>
              )}
              {node.childRefs.length > 0 && <span>{node.childRefs.length} 个子任务</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
