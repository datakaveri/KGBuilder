import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { PipelineState } from '../usePipeline'
import type {
  ConceptRow,
  EventEntity,
  ExtractKind,
  GEdge,
  GNode,
  Graph,
  GraphMetrics,
  MetricsBundle,
  QATripleResult,
  Triple,
  WhType,
} from '../types'
import GraphCanvas from './GraphCanvas'
import { edgeSourceKey, NODE_COLORS, SOURCE_COLORS } from './graphStyle'
import * as I from './icons'

const WH_ORDER: WhType[] = ['who', 'what', 'when', 'where', 'why', 'how', 'other']
const SOURCE_LABEL = { autoschema: 'AutoSchemaKG', socratic: 'SocraticKG', both: 'Both' } as const

const KINDS: { id: ExtractKind; label: string; hint: string }[] = [
  { id: 'entity_relation', label: 'Entity → Entity', hint: 'Head entity, relation, tail entity' },
  { id: 'event_entity', label: 'Event → Entities', hint: 'Events and the entities that participate in them' },
  { id: 'event_relation', label: 'Event → Event', hint: 'Temporal / causal links between events' },
]

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-glyph">
        <I.Graph size={22} />
      </span>
      <div className="empty-text">{children}</div>
    </div>
  )
}

/** Titles are written "N · Name"; the number becomes a small eyebrow above the heading. */
function StepIntro({ title, children }: { title: string; children: React.ReactNode }) {
  const [num, name] = title.includes(' · ') ? title.split(' · ', 2) : ['', title]
  return (
    <div className="step-intro">
      {num && <span className="step-eyebrow">Step {num} of 8</span>}
      <h2>{name}</h2>
      <p>{children}</p>
    </div>
  )
}

/* ---------------------------------------------------------------- 1. Chunk */
export function ChunkView({ s }: { s: PipelineState }) {
  return (
    <div className="view">
      <StepIntro title="1 · Chunking">
        The input is split on word boundaries into chunks no longer than <code>chunk_size</code> characters (with
        optional overlap). Each chunk is sent to the LLM separately, using AutoSchemaKG's own <code>TextChunker</code>.
      </StepIntro>
      {s.chunks.length === 0 ? (
        <Empty>Chunks will appear here once a run starts.</Empty>
      ) : (
        <div className="chunk-list">
          {s.chunks.map((c) => (
            <div key={c.id} className="card chunk">
              <div className="card-head">
                <span className="badge">Chunk {c.id + 1}</span>
                <span className="muted">{c.chars.toLocaleString()} chars</span>
              </div>
              <p className="chunk-text">{c.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------- 3. Extract */
type ExtractTab = ExtractKind | 'socratic'

export function ExtractView({ s }: { s: PipelineState }) {
  const [chunk, setChunk] = useState(0)
  const [tab, setTab] = useState<ExtractTab>('entity_relation')
  const [showRaw, setShowRaw] = useState(false)
  const hasAuto = s.method !== 'socratic'
  const hasSoc = s.method === 'socratic' || s.method === 'hybrid'
  const kind: ExtractTab = !hasAuto ? 'socratic' : tab === 'socratic' && !hasSoc ? 'entity_relation' : tab
  const res = kind === 'socratic' ? undefined : s.extraction[chunk]?.[kind]
  const socForChunk = s.qaTriples.filter((r) => r.chunk === chunk)
  const socCount = socForChunk.reduce((n, r) => n + r.parsed.length, 0)

  return (
    <div className="view">
      <StepIntro title="3 · Triple extraction">
        {hasAuto && (
          <>
            <b>AutoSchemaKG</b> runs three direct extraction passes per chunk: entity–entity relations, event–entity
            participation, and event–event (temporal or causal) relations.{' '}
          </>
        )}
        {hasSoc && (
          <>
            <b>SocraticKG</b> treats every QA pair from step 2 as its own extraction unit and breaks it into atomic
            triples (paper, Appendix C.1). Triples with pronouns or clause-like entities are discarded.
          </>
        )}
      </StepIntro>
      {s.chunks.length === 0 ? (
        <Empty>Waiting for chunks…</Empty>
      ) : (
        <>
          <div className="toolbar">
            <div className="chips">
              {s.chunks.map((c) => {
                const done = Object.keys(s.extraction[c.id] ?? {}).length
                const soc = s.qaTriples.filter((r) => r.chunk === c.id).length
                return (
                  <button key={c.id} className={`chip ${chunk === c.id ? 'active' : ''}`} onClick={() => setChunk(c.id)}>
                    Chunk {c.id + 1}
                    <span className="chip-meta">
                      {hasAuto ? `${done}/3` : ''}
                      {hasAuto && hasSoc ? ' · ' : ''}
                      {hasSoc ? `${soc} QA` : ''}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="tabs">
            {hasAuto &&
              KINDS.map((k) => {
                const r = s.extraction[chunk]?.[k.id]
                return (
                  <button key={k.id} className={`tab ${kind === k.id ? 'active' : ''}`} onClick={() => setTab(k.id)}>
                    <span className="src-dot autoschema" />
                    {k.label}
                    <span className="count">{r ? r.parsed.length : '…'}</span>
                  </button>
                )
              })}
            {hasSoc && (
              <button className={`tab ${kind === 'socratic' ? 'active' : ''}`} onClick={() => setTab('socratic')}>
                <span className="src-dot socratic" />
                From QA pairs
                <span className="count">{socCount}</span>
              </button>
            )}
            <label className="toggle">
              <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} /> Show prompts
            </label>
          </div>
          {kind === 'socratic' ? (
            <SocraticTriples s={s} results={socForChunk} showRaw={showRaw} chunk={chunk} />
          ) : (
          <>
          <p className="muted small">
            {KINDS.find((k) => k.id === kind)!.hint}
            {res?.dropped ? ` · ${res.dropped} malformed item(s) dropped` : ''}
          </p>
          {!res ? (
            <Empty>
              <span className="spinner" /> Waiting for the model…
            </Empty>
          ) : (
            <>
              {res.error && <div className="error-box">{res.error}</div>}
              {showRaw && (
                <div className="raw-grid">
                  <div>
                    <div className="label">Prompt</div>
                    <pre className="code">{res.prompt}</pre>
                  </div>
                  <div>
                    <div className="label">Raw LLM reply</div>
                    <pre className="code">{res.raw || '(empty)'}</pre>
                  </div>
                </div>
              )}
              {res.parsed.length === 0 ? (
                <Empty>No valid items were parsed from this reply.</Empty>
              ) : kind === 'event_entity' ? (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Event</th>
                      <th>Participating entities</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(res.parsed as EventEntity[]).map((t, i) => (
                      <tr key={i}>
                        <td>
                          <span className="pill event">{t.Event}</span>
                        </td>
                        <td>
                          {t.Entity.map((e) => (
                            <span key={e} className="pill entity">
                              {e}
                            </span>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Head</th>
                      <th>Relation</th>
                      <th>Tail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(res.parsed as Triple[]).map((t, i) => {
                      const cls = kind === 'event_relation' ? 'event' : 'entity'
                      return (
                        <tr key={i}>
                          <td>
                            <span className={`pill ${cls}`}>{t.Head}</span>
                          </td>
                          <td className="rel">{t.Relation} →</td>
                          <td>
                            <span className={`pill ${cls}`}>{t.Tail}</span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </>
          )}
          </>
          )}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------- 2. QA (SocraticKG) */
export function QAView({ s }: { s: PipelineState }) {
  const [chunk, setChunk] = useState(0)
  const [wh, setWh] = useState<WhType | 'all'>('all')
  const [showRaw, setShowRaw] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const gen = s.qa[chunk]
  const pairs = (gen?.pairs ?? []).filter((p) => wh === 'all' || p.wh === wh)
  const allPairs = Object.values(s.qa).flatMap((g) => g.pairs)
  const triplesByQa = useMemo(() => {
    const m: Record<string, QATripleResult['parsed']> = {}
    for (const r of s.qaTriples) for (const t of r.parsed) (m[t.qa_id] ??= []).push(t)
    return m
  }, [s.qaTriples])
  const whCounts = WH_ORDER.map((w) => [w, allPairs.filter((p) => p.wh === w).length] as const)
  const maxWh = Math.max(1, ...whCounts.map(([, n]) => n))

  return (
    <div className="view">
      <StepIntro title="2 · 5W1H-guided QA generation (SocraticKG)">
        Before any triples are extracted, the LLM rewrites each chunk as self-contained question–answer pairs. It uses
        Who / What / When / Where / Why / How as lenses, and replaces pronouns with explicit entity names (paper,
        Appendix B.1). These QA pairs are an intermediate step that makes implicit links explicit, especially causal
        (<i>why</i>) and procedural (<i>how</i>) ones, before the triples are built.
      </StepIntro>
      {s.steps.qa.status === 'skipped' ? (
        <Empty>QA generation only runs when the method is SocraticKG or Hybrid.</Empty>
      ) : s.chunks.length === 0 ? (
        <Empty>Waiting for chunks…</Empty>
      ) : (
        <>
          <div className="wh-bars card">
            {whCounts.map(([w, n]) => (
              <button key={w} className={`wh-bar ${wh === w ? 'active' : ''}`} onClick={() => setWh(wh === w ? 'all' : w)}>
                <span className={`wh-tag ${w}`}>{w}</span>
                <span className="wh-track">
                  <span className={`wh-fill ${w}`} style={{ width: `${(n / maxWh) * 100}%` }} />
                </span>
                <span className="cb-count">{n}</span>
              </button>
            ))}
          </div>
          <div className="toolbar">
            <div className="chips">
              {s.chunks.map((c) => (
                <button key={c.id} className={`chip ${chunk === c.id ? 'active' : ''}`} onClick={() => setChunk(c.id)}>
                  Chunk {c.id + 1}
                  <span className="chip-meta">{s.qa[c.id] ? s.qa[c.id].pairs.length : '…'}</span>
                </button>
              ))}
            </div>
            <div className="spacer" />
            {wh !== 'all' && (
              <button className="ghost sm" onClick={() => setWh('all')}>
                Clear “{wh}” filter
              </button>
            )}
            <label className="toggle">
              <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} /> Show prompts
            </label>
          </div>
          {!gen ? (
            <Empty>
              <span className="spinner" /> Waiting for the model…
            </Empty>
          ) : (
            <>
              {gen.error && <div className="error-box">{gen.error}</div>}
              {showRaw && (
                <div className="raw-grid">
                  <div>
                    <div className="label">Prompt</div>
                    <pre className="code">{gen.prompt}</pre>
                  </div>
                  <div>
                    <div className="label">Raw LLM reply</div>
                    <pre className="code">{gen.raw || '(empty)'}</pre>
                  </div>
                </div>
              )}
              {pairs.length === 0 ? (
                <Empty>No QA pairs parsed for this chunk{wh !== 'all' ? ` with “${wh}”` : ''}.</Empty>
              ) : (
                <div className="qa-list">
                  {pairs.map((p) => {
                    const ts = triplesByQa[p.id]
                    return (
                      <div key={p.id} className="qa-card" onClick={() => setOpen(open === p.id ? null : p.id)}>
                        <div className="qa-q">
                          <span className={`wh-tag ${p.wh}`}>{p.wh}</span>
                          <span>{p.question}</span>
                          <span className="muted small qa-meta">{ts ? `${ts.length} triple(s)` : ''}</span>
                        </div>
                        <div className="qa-a">{p.answer}</div>
                        {open === p.id && ts && (
                          <div className="qa-triples">
                            {ts.map((t, i) => (
                              <div key={i} className="triple-line">
                                <span className="pill entity small">{t.Head}</span>
                                <span className="rel">{t.Relation} →</span>
                                <span className="pill entity small">{t.Tail}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

function SocraticTriples({
  s,
  results,
  showRaw,
  chunk,
}: {
  s: PipelineState
  results: QATripleResult[]
  showRaw: boolean
  chunk: number
}) {
  const [showDropped, setShowDropped] = useState(false)
  const pairs = useMemo(() => new Map((s.qa[chunk]?.pairs ?? []).map((p) => [p.id, p])), [s.qa, chunk])
  const expected = s.qa[chunk]?.pairs.length ?? 0
  const done = results.reduce((n, r) => n + r.qa_ids.length, 0)
  const dropped = results.flatMap((r) => r.dropped)
  if (!results.length)
    return (
      <Empty>
        <span className="spinner" /> Waiting for QA→triple calls…
      </Empty>
    )
  return (
    <>
      <p className="muted small">
        {done}/{expected} QA pairs processed · {results.reduce((n, r) => n + r.parsed.length, 0)} triples kept ·{' '}
        <button className="linkish inline" onClick={() => setShowDropped(!showDropped)}>
          {dropped.length} discarded by the paper's rules {showDropped ? '▾' : '▸'}
        </button>
      </p>
      {showDropped && dropped.length > 0 && (
        <table className="table compact">
          <tbody>
            {dropped.map((d, i) => (
              <tr key={i}>
                <td className="muted">
                  {d.item.Head} | {d.item.Relation} | {d.item.Tail}
                </td>
                <td>
                  <span className="err-text">{d.reason}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: '34%' }}>Source QA pair</th>
            <th>Head</th>
            <th>Relation</th>
            <th>Tail</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) =>
            r.parsed.length === 0 ? (
              <tr key={r.qa_ids.join()}>
                <td className="muted small">{pairs.get(r.qa_ids[0])?.question}</td>
                <td colSpan={3} className="muted small">
                  {r.error ?? 'no valid triples'}
                </td>
              </tr>
            ) : (
              r.parsed.map((t, i) => {
                const p = pairs.get(t.qa_id)
                return (
                  <tr key={r.qa_ids.join() + i}>
                    <td className="small">
                      {i === 0 || r.parsed[i - 1].qa_id !== t.qa_id ? (
                        <>
                          <span className={`wh-tag ${p?.wh ?? 'other'}`}>{p?.wh}</span> {p?.question}
                        </>
                      ) : null}
                    </td>
                    <td>
                      <span className="pill entity">{t.Head}</span>
                    </td>
                    <td className="rel">{t.Relation} →</td>
                    <td>
                      <span className="pill entity">{t.Tail}</span>
                    </td>
                  </tr>
                )
              })
            ),
          )}
        </tbody>
      </table>
      {showRaw &&
        results.slice(0, 20).map((r) => (
          <div key={r.qa_ids.join()} className="raw-grid">
            <div>
              <div className="label">Prompt ({r.qa_ids.join(', ')})</div>
              <pre className="code">{r.prompt}</pre>
            </div>
            <div>
              <div className="label">Raw LLM reply</div>
              <pre className="code">{r.raw || '(empty)'}</pre>
            </div>
          </div>
        ))}
    </>
  )
}

/* -------------------------------------------------------- 4. Canonicalization */
export function CanonView({ s }: { s: PipelineState }) {
  const [showCandidates, setShowCandidates] = useState(false)
  return (
    <div className="view">
      <StepIntro title="4 · Canonicalization">
        Several extractors and many independent QA units name the same thing in different ways ("FDA" vs "Food and
        Drug Administration", "produces" vs "manufactures"). Following SocraticKG §3.3 (KGGen's cluster-then-refine),
        every unique entity and relation is embedded and grouped with K-means. Within each cluster, the top-k
        candidates for each name are found using dense similarity plus BM25, and the LLM decides which candidates are
        true synonyms and picks the canonical name. This is where the AutoSchemaKG and SocraticKG graphs get stitched
        together.
      </StepIntro>
      {s.steps.canon.status === 'skipped' ? (
        <Empty>Canonicalization is turned off for this run.</Empty>
      ) : !s.canon.entity && !s.canon.relation ? (
        <Empty>
          {s.steps.canon.status === 'running' ? (
            <>
              <span className="spinner" /> Embedding, clustering and asking the LLM…
            </>
          ) : (
            'Waiting for extraction…'
          )}
        </Empty>
      ) : (
        <>
          <div className="toolbar">
            {(['entity', 'relation'] as const).map((k) => {
              const c = s.canon[k]
              return c ? (
                <div key={k} className="stat-card">
                  <span className="label">{k === 'entity' ? 'Entities' : 'Relations'}</span>
                  <b>
                    {c.before} → {c.after}
                  </b>
                  <span className="muted small">
                    {c.merges.length} merge(s) · {c.groups.length} candidate group(s) · {c.info.clusters} cluster(s)
                  </span>
                </div>
              ) : null
            })}
            <div className="spacer" />
            <span className="muted small">
              Embeddings: <code>{s.canon.entity?.info.embedder ?? s.canon.relation?.info.embedder ?? '—'}</code>
            </span>
            <label className="toggle">
              <input type="checkbox" checked={showCandidates} onChange={(e) => setShowCandidates(e.target.checked)} />{' '}
              Show rejected candidates
            </label>
          </div>
          {s.canon.entity?.info.embedder_error && (
            <p className="muted small">
              Sentence-transformer unavailable ({s.canon.entity.info.embedder_error}), so TF-IDF was used instead.
            </p>
          )}
          <div className="schema-grid">
            {(['entity', 'relation'] as const).map((k) => {
              const c = s.canon[k]
              if (!c) return <div key={k} />
              return (
                <div key={k} className="card">
                  <div className="card-head">
                    <b>{k === 'entity' ? 'Entity merges' : 'Relation merges'}</b>
                  </div>
                  {c.merges.length === 0 && <p className="muted small">No synonyms found.</p>}
                  <div className="rel-list">
                    {c.merges.map((m) => (
                      <div key={m.canonical} className="rel-item">
                        <span className={k === 'entity' ? 'pill entity' : 'rel'}>{m.canonical}</span>
                        <span className="muted">⟵</span>
                        <span>
                          {m.members
                            .filter((x) => x !== m.canonical)
                            .map((x) => (
                              <span key={x} className="pill small">
                                {x}
                              </span>
                            ))}
                        </span>
                      </div>
                    ))}
                    {showCandidates &&
                      c.groups
                        .filter((g) => g.merges.length === 0)
                        .map((g, i) => (
                          <div key={i} className="rel-item rejected">
                            <span className="muted small">kept separate</span>
                            <span>
                              {g.candidates.map((x) => (
                                <span key={x} className="pill small">
                                  {x}
                                </span>
                              ))}
                            </span>
                          </div>
                        ))}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------ metrics panel */
const METRIC_DEFS: { key: keyof GraphMetrics; label: string; hint: string; better: 'up' | 'down' | 'neutral' }[] = [
  { key: 'triples', label: '#Triples', hint: 'Facts externalized in the graph (merging duplicates lowers it)', better: 'neutral' },
  { key: 'nodes', label: 'Nodes', hint: 'Entities + events (merging synonyms lowers it)', better: 'neutral' },
  { key: 'avg_degree', label: 'Avg degree', hint: '2E/N over unique neighbours (connectivity)', better: 'up' },
  { key: 'components', label: 'Components', hint: 'Disconnected pieces', better: 'down' },
  { key: 'nfi', label: 'NFI', hint: '(C−1)/(N−1): 0 = fully connected, 1 = fully fragmented', better: 'down' },
  { key: 'largest_component', label: 'Largest comp.', hint: 'Share of nodes in the biggest component', better: 'up' },
]

export function MetricsPanel({ metrics }: { metrics: MetricsBundle }) {
  const cols = Object.keys(metrics.after).filter((k) => k !== 'overall')
  const fmt = (k: keyof GraphMetrics, v?: number) =>
    v == null ? '—' : k === 'largest_component' ? `${Math.round(v * 100)}%` : k === 'nfi' ? v.toFixed(3) : String(v)
  return (
    <div className="card metrics">
      <div className="card-head">
        <b>Structure metrics (SocraticKG §4.1)</b>
        <span className="muted small">instance graph, before concepts are added</span>
      </div>
      <div className="table-scroll">
        <table className="table compact">
          <thead>
            <tr>
              <th>Metric</th>
              {metrics.before && <th>Before canon.</th>}
              <th>Integrated graph</th>
              {cols.map((c) => (
                <th key={c}>
                  <span className="src-dot" style={{ background: SOURCE_COLORS[c as keyof typeof SOURCE_COLORS] }} />
                  {c === 'both' ? 'Edges found by both' : `${SOURCE_LABEL[c as 'autoschema' | 'socratic']} edges only`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {METRIC_DEFS.map((m) => {
              const before = metrics.before?.overall[m.key]
              const after = metrics.after.overall[m.key]
              const delta = before != null && after !== before ? after - before : null
              const tone =
                delta == null || m.better === 'neutral'
                  ? 'neutral'
                  : (m.better === 'up' ? delta > 0 : delta < 0)
                    ? 'good'
                    : 'bad'
              return (
                <tr key={m.key} title={m.hint}>
                  <td>
                    {m.label} <span className="muted small">{m.better === 'up' ? '↑' : m.better === 'down' ? '↓' : ''}</span>
                  </td>
                  {metrics.before && <td className="num">{fmt(m.key, before)}</td>}
                  <td className="num">
                    <b>{fmt(m.key, after)}</b>
                    {delta != null && (
                      <span className={`delta ${tone}`}>
                        {delta > 0 ? '+' : ''}
                        {m.key === 'largest_component' ? `${Math.round(delta * 100)}pt` : +delta.toFixed(3)}
                      </span>
                    )}
                  </td>
                  {cols.map((c) => (
                    <td key={c} className="num">
                      {fmt(m.key, metrics.after[c]?.[m.key])}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SourceLegend() {
  return (
    <span className="stats">
      {(Object.keys(SOURCE_COLORS) as (keyof typeof SOURCE_COLORS)[]).map((k) => (
        <span key={k} className="stat small">
          <span className="src-line" style={{ background: SOURCE_COLORS[k] }} /> {SOURCE_LABEL[k]}
        </span>
      ))}
    </span>
  )
}

/* ---------------------------------------------------------------- 5. Graph */
export function GraphStepView({ s }: { s: PipelineState }) {
  const [sel, setSel] = useState<GNode | null>(null)
  const [bySource, setBySource] = useState(true)
  const g = s.baseGraph
  const multi = s.method === 'hybrid'
  const counts = useMemo(() => {
    const c = { autoschema: 0, socratic: 0, both: 0 }
    for (const e of g?.edges ?? []) {
      const k = edgeSourceKey(e)
      if (k) c[k]++
    }
    return c
  }, [g])
  return (
    <div className="view fill">
      <StepIntro title="5 · Graph integration">
        All triples from every extractor and chunk are merged into one directed multigraph, using the canonical names
        from step 4. A fact found by more than one extractor becomes a single edge that keeps <b>every source and its
        evidence</b> (the chunk, plus the QA pair for SocraticKG). Different relations between the same two nodes stay
        as separate edges. Event–entity pairs are linked by <code>is participated by</code>. This is the graph before a
        schema is induced.
      </StepIntro>
      {!g ? (
        <Empty>The graph will be assembled once extraction finishes.</Empty>
      ) : (
        <>
          <div className="toolbar">
            <GraphStats graph={g} extra={`${s.relations.length} distinct relation types`} />
            <div className="spacer" />
            {multi && (
              <span className="stats small">
                {(['autoschema', 'socratic', 'both'] as const).map((k) => (
                  <span key={k} className="stat">
                    <span className="src-line" style={{ background: SOURCE_COLORS[k] }} />
                    <b>{counts[k]}</b> {SOURCE_LABEL[k]}
                  </span>
                ))}
              </span>
            )}
            {multi && (
              <label className="toggle">
                <input type="checkbox" checked={bySource} onChange={(e) => setBySource(e.target.checked)} /> colour
                edges by source
              </label>
            )}
          </div>
          {s.graphStats && (
            <p className="muted small">
              {s.graphStats.merged_duplicates} duplicate fact(s) merged into existing edges ·{' '}
              {s.graphStats.self_loops} self-loop(s) dropped
            </p>
          )}
          {s.metrics && <MetricsPanel metrics={s.metrics} />}
          <div className="graph-area">
            <GraphCanvas graph={g} onSelect={setSel} selectedId={sel?.id} colorBySource={multi && bySource} />
            {sel && <NodeDetails node={sel} graph={g} onClose={() => setSel(null)} onPick={setSel} />}
          </div>
        </>
      )}
    </div>
  )
}

/* -------------------------------------------------------------- 6. Concept */
export function ConceptView({ s }: { s: PipelineState }) {
  const [filter, setFilter] = useState<'all' | ConceptRow['node_type']>('all')
  const [open, setOpen] = useState<string | null>(null)
  const rows = s.concepts.filter((r) => filter === 'all' || r.node_type === filter)
  const pct = s.conceptTotal ? Math.round((s.concepts.length / s.conceptTotal) * 100) : 0
  return (
    <div className="view">
      <StepIntro title="6 · Conceptualization">
        AutoSchemaKG's schema-free typing, applied to the integrated graph (so SocraticKG entities get typed too). Each
        entity, event and relation is sent back to the LLM, which returns abstract phrases for it at different levels
        of abstraction. Entities are sent with one neighbouring triple as context. This is the step that lets
        AutoSchemaKG induce a schema without one being defined up front.
      </StepIntro>
      {s.steps.concept.status === 'skipped' ? (
        <Empty>Conceptualization was turned off for this run.</Empty>
      ) : s.conceptTotal === 0 ? (
        <Empty>Waiting for the graph…</Empty>
      ) : (
        <>
          <div className="progress-row">
            <div className="progress">
              <div className="progress-bar" style={{ width: `${pct}%` }} />
            </div>
            <span className="muted small">
              {s.concepts.length}/{s.conceptTotal} nodes
              {s.conceptSkipped > 0 && ` · ${s.conceptSkipped} low-degree nodes skipped (raise the limit under Advanced)`}
            </span>
          </div>
          <div className="chips">
            {(['all', 'entity', 'event', 'relation'] as const).map((f) => (
              <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
                {f}
                <span className="chip-meta">
                  {f === 'all' ? s.concepts.length : s.concepts.filter((r) => r.node_type === f).length}
                </span>
              </button>
            ))}
          </div>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>Type</th>
                <th>Node</th>
                <th>Induced concepts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const key = r.node_type + r.node
                return (
                  <Fragment key={key}>
                    <tr className="clickable" onClick={() => setOpen(open === key ? null : key)}>
                      <td>
                        <span className={`type-tag ${r.node_type}`}>{r.node_type}</span>
                      </td>
                      <td>{r.label}</td>
                      <td>
                        {r.error ? (
                          <span className="err-text">{r.error}</span>
                        ) : r.concepts.length ? (
                          r.concepts.map((c) => (
                            <span key={c} className="pill concept">
                              {c}
                            </span>
                          ))
                        ) : (
                          <span className="muted">none parsed</span>
                        )}
                      </td>
                    </tr>
                    {open === key && (
                      <tr className="raw-row">
                        <td colSpan={3}>
                          <div className="raw-grid">
                            <div>
                              <div className="label">Prompt</div>
                              <pre className="code">{r.prompt}</pre>
                            </div>
                            <div>
                              <div className="label">Raw LLM reply</div>
                              <pre className="code">{r.raw || '(empty)'}</pre>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- 7. Schema */
export function SchemaView({ s }: { s: PipelineState }) {
  const [q, setQ] = useState('')
  const list = s.schema.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()))
  const max = s.schema[0]?.count ?? 1
  const relEntries = Object.entries(s.relationConcepts)
  return (
    <div className="view">
      <StepIntro title="7 · Schema induction">
        Concepts are deduplicated and turned into <b>Concept</b> nodes. Each instance links to its concepts through a{' '}
        <code>has_concept</code> edge. Concepts that many instances share become the schema's types; nothing here was
        defined in advance.
      </StepIntro>
      {s.schema.length === 0 ? (
        <Empty>The schema will be built once conceptualization finishes.</Empty>
      ) : (
        <div className="schema-grid">
          <div className="card">
            <div className="card-head">
              <b>Concept types</b>
              <label className="search-box">
                <I.Search size={14} />
                <input className="search" placeholder="Filter concepts…" value={q} onChange={(e) => setQ(e.target.value)} />
              </label>
            </div>
            <div className="concept-bars">
              {list.slice(0, 300).map((c) => (
                <details key={c.name} className="concept-bar">
                  <summary>
                    <span className="cb-name">{c.name}</span>
                    <span className="cb-track">
                      {(['entity', 'event', 'relation'] as const).map((t) =>
                        c.types[t] ? (
                          <span
                            key={t}
                            className={`cb-seg ${t}`}
                            style={{ width: `${(c.types[t]! / max) * 100}%` }}
                            title={`${t}: ${c.types[t]}`}
                          />
                        ) : null,
                      )}
                    </span>
                    <span className="cb-count">{c.count}</span>
                  </summary>
                  <div className="cb-instances">
                    {c.instances.map((i) => (
                      <span key={i} className="pill small">
                        {i}
                      </span>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <b>Relation schema</b>
              <span className="muted small">{relEntries.length} relations</span>
            </div>
            <div className="rel-list">
              {relEntries.map(([rel, cs]) => (
                <div key={rel} className="rel-item">
                  <span className="rel">{rel}</span>
                  <span>
                    {cs.map((c) => (
                      <span key={c} className="pill concept small">
                        {c}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- 8. Final */
export function FinalView({ s }: { s: PipelineState }) {
  const [sel, setSel] = useState<GNode | null>(null)
  const [q, setQ] = useState('')
  const [show, setShow] = useState({ entity: true, event: true, concept: true })
  const [labels, setLabels] = useState(true)
  const [bySource, setBySource] = useState(false)
  const [showMetrics, setShowMetrics] = useState(false)
  const exportRef = useRef<HTMLDetailsElement>(null)
  const multi = s.method === 'hybrid'

  // <details> menus don't close on outside clicks by themselves.
  useEffect(() => {
    const close = (e: MouseEvent) => {
      const el = exportRef.current
      if (el?.open && !el.contains(e.target as Node)) el.open = false
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const filtered: Graph | null = useMemo(() => {
    const g = s.finalGraph
    if (!g) return null
    const keep = new Set(g.nodes.filter((n) => show[n.type]).map((n) => n.id))
    return {
      nodes: g.nodes.filter((n) => keep.has(n.id)),
      edges: g.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    }
  }, [s.finalGraph, show])

  return (
    <div className="view fill">
      <StepIntro title="8 · Final knowledge graph">
        The integrated instance graph combined with the induced concept layer. Click a node to see its aliases,
        concepts and edges, including the evidence (source chunk or QA pair) behind each edge. Hover to highlight
        neighbours, and use the controls to filter, search, or colour edges by the extractor that found them.
      </StepIntro>
      {!filtered || !s.finalGraph ? (
        <Empty>The finished KG will appear here.</Empty>
      ) : (
        <>
          <div className="toolbar">
            <GraphStats graph={s.finalGraph} />
            <div className="spacer" />
            <label className="search-box">
              <I.Search size={14} />
              <input className="search" placeholder="Search nodes…" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            {s.metrics && (
              <button className={`ghost sm ${showMetrics ? 'on' : ''}`} onClick={() => setShowMetrics(!showMetrics)}>
                Metrics
              </button>
            )}
            {s.runId && (
              <details className="menu" ref={exportRef}>
                <summary className="btn-accent sm">
                  <I.Download size={14} /> Export
                </summary>
                <div className="menu-list">
                  {(['graph.jsonld', 'graph.json', 'graph.graphml', 'extraction.json', 'concepts.json', 'metrics.json'] as const).map((f) => (
                    <a key={f} href={`/api/download/${s.runId}/${f}`}>
                      <I.Download size={13} /> {f}
                    </a>
                  ))}
                  {s.outputDir && (
                    <span className="menu-foot">
                      Also saved to <code>{s.outputDir}/</code>
                    </span>
                  )}
                </div>
              </details>
            )}
          </div>
          <div className="toolbar filters">
            {(['entity', 'event', 'concept'] as const).map((t) => (
              <button key={t} className={`chip ${show[t] ? 'active' : 'off'}`} onClick={() => setShow({ ...show, [t]: !show[t] })}>
                <span className="dot" style={{ background: NODE_COLORS[t] }} /> {t === 'entity' ? 'Entities' : t + 's'}
              </button>
            ))}
            <span className="sep" />
            <label className="toggle">
              <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> Edge labels
            </label>
            {multi && (
              <label className="toggle">
                <input type="checkbox" checked={bySource} onChange={(e) => setBySource(e.target.checked)} /> Colour by
                source
              </label>
            )}
            {multi && bySource && <SourceLegend />}
          </div>
          {showMetrics && s.metrics && <MetricsPanel metrics={s.metrics} />}
          <div className="graph-area">
            <GraphCanvas
              graph={filtered}
              highlight={q}
              onSelect={setSel}
              selectedId={sel?.id}
              showEdgeLabels={labels}
              colorBySource={multi && bySource}
            />
            {sel && <NodeDetails node={sel} graph={s.finalGraph} onClose={() => setSel(null)} onPick={setSel} />}
          </div>
        </>
      )}
    </div>
  )
}

/* -------------------------------------------------------------- shared bits */
function GraphStats({ graph, extra }: { graph: Graph; extra?: string }) {
  const counts = { entity: 0, event: 0, concept: 0 }
  for (const n of graph.nodes) counts[n.type]++
  return (
    <div className="stats">
      {(['entity', 'event', 'concept'] as const).map((t) =>
        counts[t] ? (
          <span key={t} className="stat">
            <span className="dot" style={{ background: NODE_COLORS[t] }} />
            <b>{counts[t]}</b> {t === 'entity' ? 'entities' : t + 's'}
          </span>
        ) : null,
      )}
      <span className="stat">
        <b>{graph.edges.length}</b> edges
      </span>
      {extra && <span className="stat muted">{extra}</span>}
    </div>
  )
}

function NodeDetails({
  node,
  graph,
  onClose,
  onPick,
}: {
  node: GNode
  graph: Graph
  onClose: () => void
  onPick?: (n: GNode) => void
}) {
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph])
  const out = graph.edges.filter((e) => e.source === node.id)
  const inc = graph.edges.filter((e) => e.target === node.id)
  const Link = ({ id }: { id: string }) => {
    const n = byId.get(id)
    if (!n) return <span>{id}</span>
    return (
      <button className={`pill ${n.type} linkish`} onClick={() => onPick?.(n)}>
        {n.label}
      </button>
    )
  }
  return (
    <aside className="details">
      <div className="card-head">
        <span className={`type-tag ${node.type}`}>{node.type}</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <I.X size={14} />
        </button>
      </div>
      <h3>{node.label}</h3>
      {node.chunks.length > 0 && <p className="muted small">From chunk(s): {node.chunks.map((c) => c + 1).join(', ')}</p>}
      {node.sources?.length > 0 && (
        <div className="src-badges">
          {node.sources.map((src) => (
            <span key={src} className={`src-badge ${src}`}>
              {SOURCE_LABEL[src]}
            </span>
          ))}
        </div>
      )}
      {node.aliases?.length > 0 && (
        <>
          <div className="label">Also written as (canonicalized)</div>
          <div>
            {node.aliases.map((a) => (
              <span key={a} className="pill small">
                {a}
              </span>
            ))}
          </div>
        </>
      )}
      {node.concepts.length > 0 && (
        <>
          <div className="label">Concepts</div>
          <div>
            {node.concepts.map((c) => (
              <span key={c} className="pill concept small">
                {c}
              </span>
            ))}
          </div>
        </>
      )}
      {out.length > 0 && (
        <>
          <div className="label">Outgoing ({out.length})</div>
          <ul className="edge-list">
            {out.slice(0, 60).map((e, i) => (
              <EdgeItem key={i} e={e}>
                <span className="rel">{e.relation}</span> → <Link id={e.target} />
              </EdgeItem>
            ))}
          </ul>
        </>
      )}
      {inc.length > 0 && (
        <>
          <div className="label">Incoming ({inc.length})</div>
          <ul className="edge-list">
            {inc.slice(0, 60).map((e, i) => (
              <EdgeItem key={i} e={e}>
                <Link id={e.source} /> → <span className="rel">{e.relation}</span>
              </EdgeItem>
            ))}
          </ul>
        </>
      )}
    </aside>
  )
}

function EdgeItem({ e, children }: { e: GEdge; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const sk = edgeSourceKey(e)
  const hasEvidence = e.evidence?.length > 0
  return (
    <li className="edge-item">
      <div className="edge-row">
        <span className="edge-main">{children}</span>
        {sk && (
          <button
            className={`src-badge ${sk} linkish`}
            title={hasEvidence ? 'Show evidence' : undefined}
            onClick={() => hasEvidence && setOpen(!open)}
          >
            {sk === 'both' ? 'both' : sk === 'autoschema' ? 'AS' : 'SoKG'}
            {e.count > 1 ? ` ×${e.count}` : ''}
          </button>
        )}
      </div>
      {open && (
        <div className="evidence">
          {e.evidence.map((ev, i) => (
            <div key={i} className="ev">
              <span className="muted small">
                {SOURCE_LABEL[ev.source]} · chunk {ev.chunk + 1}
                {ev.kind !== 'qa' ? ` · ${ev.kind.replace('_', '–')}` : ''}
              </span>
              {ev.question && (
                <div className="ev-qa">
                  <b>Q:</b> {ev.question}
                  <br />
                  <b>A:</b> {ev.answer}
                </div>
              )}
              <div className="muted small">as extracted: {ev.original}</div>
            </div>
          ))}
        </div>
      )}
    </li>
  )
}
