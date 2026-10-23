import { useMemo, useState } from 'react';
import type { KnowledgeHit, KnowledgeSource } from '@shared/types';
import { api } from '../lib/bridge';
import { formatRelative } from '../lib/format';
import { useStore } from '../state/store';
import { Confirm } from './Modal';
import { EmptyState } from './ui';

const STATUS: Record<KnowledgeSource['status'], { text: string; cls: string }> = {
  pending: { text: '等待索引', cls: '' },
  indexing: { text: '索引中', cls: 'info' },
  ready: { text: '已就绪', cls: 'ok' },
  error: { text: '索引失败', cls: 'err' },
};

export function KnowledgePanel() {
  const { state, actions } = useStore();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [removing, setRemoving] = useState<KnowledgeSource | null>(null);
  const [reindexing, setReindexing] = useState<string | null>(null);

  const stats = useMemo(() => {
    return {
      sources: state.knowledge.length,
      documents: state.knowledge.reduce((n, k) => n + k.files, 0),
      chunks: state.knowledge.reduce((n, k) => n + k.chunks, 0),
      updated: Math.max(0, ...state.knowledge.map((k) => k.updatedAt)),
    };
  }, [state.knowledge]);

  const addFolder = async () => {
    const dir = await api.app.pickDirectory();
    if (dir) await actions.addKnowledge(dir, true);
  };

  const addFiles = async () => {
    const files = await api.app.pickFiles({ multiple: true });
    for (const f of files) await actions.addKnowledge(f.path, false);
  };

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    const res = await actions.searchKnowledge(query.trim());
    setHits(res);
    setSearching(false);
  };

  return (
    <div className="main">
      <div className="page">
        <div className="page-scroll">
          <div className="page-inner">
            <div className="page-head">
              <div className="lead">
                <h2 className="page-title">
                  知识库
                  <span className="badge ok">本地向量索引</span>
                </h2>
                <p className="page-sub">
                  把文档、笔记和项目资料加入索引，Agent 回答时会先检索这些内容并给出可点开的引用来源。
                  文件只在本地解析，不会上传。
                </p>
              </div>
              <div className="page-actions">
                <button type="button" className="btn" onClick={() => void addFiles()}>
                  添加文件
                </button>
                <button type="button" className="btn primary" onClick={() => void addFolder()}>
                  ＋ 添加文件夹
                </button>
              </div>
            </div>

            <div className="stat-grid">
              <div className="stat-card">
                <div className="k">来源</div>
                <div className="n">{stats.sources}</div>
                <div className="s">文件夹与单文件合计</div>
              </div>
              <div className="stat-card">
                <div className="k">文档</div>
                <div className="n">{stats.documents}</div>
                <div className="s">已解析的文本文件</div>
              </div>
              <div className="stat-card">
                <div className="k">分块</div>
                <div className="n">{stats.chunks}</div>
                <div className="s">{stats.updated ? `最近更新 ${formatRelative(stats.updated)}` : '尚未建立索引'}</div>
              </div>
            </div>

            <div className="section-title">
              来源列表
              <span className="hint">支持 .md .txt .pdf .docx .csv 等文本格式</span>
            </div>

            {state.knowledge.length === 0 ? (
              <div className="empty-hint">还没有知识库来源。添加一个文件夹，例如你的项目文档或笔记目录。</div>
            ) : (
              <div className="source-list">
                {state.knowledge.map((src) => {
                  const st = STATUS[src.status];
                  return (
                    <div className="source-row" key={src.id}>
                      <span className="source-icon">{src.kind === 'dir' ? '▤' : '▥'}</span>
                      <div className="source-main">
                        <div className="source-name">
                          {src.name}
                          <span className={`badge ${st.cls}`}>{st.text}</span>
                          {src.watch ? (
                            <span className="badge" title="目录变更会自动重建该来源索引">
                              监听中
                            </span>
                          ) : null}
                        </div>
                        <div className="source-path" title={src.path}>
                          {src.path}
                        </div>
                        {src.status === 'indexing' ? <div className="progress-line" style={{ marginTop: 6 }} /> : null}
                        {src.message ? (
                          <div className="field-hint" style={{ marginTop: 3 }}>
                            {src.message}
                          </div>
                        ) : null}
                      </div>
                      <div className="source-stats">
                        <span>
                          <span className="k">文件</span>
                          {src.files}
                        </span>
                        <span>
                          <span className="k">分块</span>
                          {src.chunks}
                        </span>
                      </div>
                      <div className="source-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          title="重建索引"
                          disabled={reindexing === src.id}
                          onClick={async () => {
                            setReindexing(src.id);
                            await actions.reindexKnowledge(src.id);
                            setReindexing(null);
                          }}
                        >
                          {reindexing === src.id ? <span className="spin" /> : '↻'}
                        </button>
                        <button type="button" className="icon-btn" title="移除来源" onClick={() => setRemoving(src)}>
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="section-title" style={{ marginTop: 24 }}>
              检索测试
              <span className="hint">验证分块质量与相似度</span>
            </div>
            <div className="search-test">
              <div className="field-row">
                <input
                  className="input"
                  value={query}
                  placeholder="输入一句话，例如：工具调用成功率"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void search();
                  }}
                />
                <button type="button" className="btn primary" onClick={() => void search()} disabled={searching || !query.trim()}>
                  {searching ? <span className="spin" /> : null}
                  检索
                </button>
              </div>

              {hits === null ? (
                <div className="empty-hint" style={{ marginTop: 10 }}>
                  检索结果会显示命中片段、来源路径与相似度分数，用于判断是否需要重建索引。
                </div>
              ) : hits.length === 0 ? (
                <EmptyState icon="❖" title="没有命中片段" desc="换个更具体的说法，或确认来源已完成索引。" />
              ) : (
                <div className="hit-list">
                  {hits.map((hit) => (
                    <button
                      type="button"
                      className="hit"
                      key={hit.id}
                      style={{ textAlign: 'left', width: '100%' }}
                      onClick={() => void api.app.openPath(hit.path)}
                    >
                      <div className="h-top">
                        <span className="h-title">{hit.title}</span>
                        <span className="h-score">{hit.score.toFixed(2)}</span>
                        <span className="score-bar">
                          <i style={{ width: `${Math.round(hit.score * 100)}%` }} />
                        </span>
                      </div>
                      <div className="h-snippet">{hit.snippet}</div>
                      <div className="h-path">{hit.path}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="note-card" style={{ marginTop: 22 }}>
              <span className="ni">◈</span>
              <span>
                开启监听的文件夹会在文件新增或修改后自动重建索引（最多 3 秒延迟）。重建期间旧索引仍可检索，
                不会中断正在进行的对话。向量模型不可用时会自动退回词法检索。
              </span>
            </div>
          </div>
        </div>
      </div>

      {removing ? (
        <Confirm
          title="移除知识库来源"
          text={`「${removing.name}」的索引会被删除，原始文件不受影响。`}
          confirmLabel="移除来源"
          onClose={() => setRemoving(null)}
          onConfirm={() => void actions.removeKnowledge(removing.id)}
        />
      ) : null}
    </div>
  );
}
