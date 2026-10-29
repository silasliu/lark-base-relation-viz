import { useState } from 'react'
import type { GraphNode, GraphData } from '../types'
import { config } from '../config'

interface DetailsPanelProps {
  node: GraphNode | null
  data: GraphData | null
  onOpenInDida: (node: GraphNode) => void
  onJumpToNode: (nodeId: string) => void
  onFilterBy: (filter: { list?: string; tag?: string }) => void
  onToast: (text: string) => void
}

/** 复制：优先异步 API，失败回退 execCommand（沙箱 iframe 里后者常是唯一可用路径） */
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* 落到 execCommand */
    }
  }
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', '')
    el.style.position = 'fixed'
    el.style.top = '-1000px'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.select()
    el.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}

export function DetailsPanel({
  node,
  data,
  onOpenInDida,
  onJumpToNode,
  onFilterBy,
  onToast,
}: DetailsPanelProps) {
  const [copied, setCopied] = useState<string | null>(null)
  const [descExpanded, setDescExpanded] = useState(false)

  if (!node || !data) {
    return (
      <div className="details-empty">
        <p>点击节点或在清单里选择任务</p>
        <p className="details-empty-sub">双击节点可在滴答中打开</p>
      </div>
    )
  }

  const webUrl =
    node.projectId && node.didaId ? config.didaWebTaskUrl(node.projectId, node.didaId) : null
  const schemeUrl = config.didaSearchScheme(node.rawTitle)

  const handleCopy = async (kind: string, text: string, label: string) => {
    const ok = await copyText(text)
    if (ok) {
      setCopied(kind)
      window.setTimeout(() => setCopied(null), 1500)
    } else {
      onToast(`复制失败，请手动选中${label}复制`)
    }
  }

  /** 关联任务行：可点击跳转 */
  const relatedRow = (id: string, label: string, dim = false) => (
    <li key={id}>
      <button
        className={`related-item ${dim ? 'done-text' : ''}`}
        onClick={() => onJumpToNode(id)}
        title={label}
      >
        <span className="related-label">{label}</span>
        <span className="related-arrow">›</span>
      </button>
    </li>
  )

  const prereqNodes = node.prerequisiteRefs ?? []
  const succNodes = node.successorRefs ?? []
  const parentNode = node.parentRef
  const childNodes = node.childRefs ?? []

  return (
    <div className="details">
      <div className="details-head">
        <span className="details-emoji">{node.emoji}</span>
        <span className={`details-title-text ${node.state === 'done' ? 'done-text' : ''}`}>
          {node.label}
        </span>
      </div>

      <div className="details-badges">
        <span
          className={`pill ${
            node.state === 'done' ? 'pill-done' : node.state === 'todo' ? 'pill-todo' : 'pill-neutral'
          }`}
        >
          {node.status ||
            (node.state === 'done' ? '已完成' : node.state === 'todo' ? '未完成' : '状态未知')}
        </span>
        {node.overdueDays ? <span className="pill pill-danger">逾期 {node.overdueDays} 天</span> : null}
        {node.listName && (
          <button
            className="pill pill-list"
            title="只看这个清单"
            onClick={() => onFilterBy({ list: node.listName })}
          >
            {node.listName}
          </button>
        )}
      </div>

      {/* 任务内容 */}
      {node.description ? (
        <div className="details-section">
          <h4>任务内容</h4>
          <div className={`details-desc ${descExpanded ? 'expanded' : ''}`}>
            {node.description}
          </div>
          {node.description.length > 120 && (
            <button className="link-more" onClick={() => setDescExpanded((v) => !v)}>
              {descExpanded ? '收起' : '展开全文'}
            </button>
          )}
        </div>
      ) : (
        <div className="details-section">
          <h4>任务内容</h4>
          <p className="details-muted">（表里没有填写内容）</p>
        </div>
      )}

      {prereqNodes.length > 0 && (
        <div className="details-section">
          <h4>
            在等这些做完
            <span className="section-count">
              {node.blockingCount > 0 ? `${node.blockingCount} 项未完成` : '全部已完成'}
            </span>
          </h4>
          <ul className="related-list">
            {prereqNodes.map((r) =>
              relatedRow(r.id, `${r.emoji} ${r.title}`, r.state === 'done'),
            )}
          </ul>
        </div>
      )}

      {succNodes.length > 0 && (
        <div className="details-section">
          <h4>这些在等它</h4>
          <ul className="related-list">
            {succNodes.map((r) => relatedRow(r.id, `${r.emoji} ${r.title}`, r.state === 'done'))}
          </ul>
        </div>
      )}

      {(parentNode || childNodes.length > 0) && (
        <div className="details-section">
          <h4>父子</h4>
          <ul className="related-list">
            {parentNode && relatedRow(parentNode.id, `👪 ${parentNode.title}`)}
            {childNodes.map((r) => relatedRow(r.id, `　${r.emoji} ${r.title}`))}
          </ul>
        </div>
      )}

      {node.tags.length > 0 && (
        <div className="details-section">
          <h4>标签</h4>
          <div className="tag-row">
            {node.tags.map((t) => (
              <button
                key={t}
                className="tag tag-clickable"
                title="只看这个标签"
                onClick={() => onFilterBy({ tag: t })}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      )}

      {node.dueDate && (
        <div className="details-section">
          <h4>截止</h4>
          <p className={node.overdueDays ? 'overdue' : ''}>
            {node.dueDate}
            {node.overdueDays ? `（逾期 ${node.overdueDays} 天）` : ''}
          </p>
        </div>
      )}

      <div className="link-section">
        <h4>打开方式</h4>

        {webUrl ? (
          <>
            <div className="link-row">
              <a className="link-main" href={webUrl} target="_blank" rel="noreferrer" title={webUrl}>
                🌐 网页版任务
              </a>
              <button
                className="link-copy"
                title="复制网页链接"
                onClick={() => handleCopy('web', webUrl, '链接')}
              >
                {copied === 'web' ? '已复制' : '复制'}
              </button>
            </div>
            <div className="link-url">{webUrl}</div>
          </>
        ) : (
          <div className="link-row muted">缺少 projectId 或 didaId，无法生成网页链接</div>
        )}

        {/* 真 <a href>：飞书沙箱可能会拦截，但不拦截时这是最可靠的唤起方式 */}
        <div className="link-row">
          <a
            className="link-main secondary"
            href={schemeUrl}
            title={schemeUrl}
            onClick={() => onOpenInDida(node)}
          >
            🔗 唤起客户端
          </a>
          <button
            className="link-copy"
            title="复制任务标题（可直接粘进滴答搜索框）"
            onClick={() => handleCopy('keyword', node.label, '标题')}
          >
            {copied === 'keyword' ? '已复制' : '复制标题'}
          </button>
        </div>
        <p className="dida-hint">
          唤起失败是飞书沙箱的限制；用「复制标题」后在滴答里粘贴搜索即可。
        </p>
      </div>
    </div>
  )
}
