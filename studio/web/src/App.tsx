import { useEffect, useRef, useState } from 'react'
import { STEP_ORDER, usePipeline } from './usePipeline'
import type { Method, Settings, StepId } from './types'
import {
  CanonView,
  ChunkView,
  ConceptView,
  ExtractView,
  FinalView,
  GraphStepView,
  QAView,
  SchemaView,
} from './components/StepViews'
import * as I from './components/icons'

// `short` fits the pipeline rail; `title` is used on the welcome screen.
const STEP_META: Record<StepId, { title: string; short: string; sub: string; blurb: string }> = {
  chunk: { title: 'Chunk', short: 'Chunk', sub: 'Split text', blurb: 'Split the document into model-sized pieces.' },
  qa: { title: '5W1H QA', short: 'Q&A', sub: 'Ask questions', blurb: 'Rewrite each chunk as self-contained Q&A pairs.' },
  extract: { title: 'Extract', short: 'Extract', sub: 'Find triples', blurb: 'Pull (head, relation, tail) facts from text and Q&A.' },
  canon: { title: 'Canonicalize', short: 'Merge', sub: 'Merge synonyms', blurb: 'Unify “FDA” and “Food and Drug Administration”.' },
  graph: { title: 'Integrate', short: 'Integrate', sub: 'Build graph', blurb: 'Merge everything into one graph with evidence.' },
  concept: { title: 'Conceptualize', short: 'Concepts', sub: 'Abstract nodes', blurb: 'Give every node abstract concept labels.' },
  schema: { title: 'Schema', short: 'Schema', sub: 'Induce types', blurb: 'Shared concepts become the schema’s types.' },
  final: { title: 'Final KG', short: 'Final KG', sub: 'Explore', blurb: 'Explore, search and export the finished graph.' },
}

const SAMPLE = `Metformin is a first-line medication for the treatment of type 2 diabetes. It was approved by the FDA in 1994 and is manufactured by several generic drug companies. Metformin works by decreasing glucose production in the liver and increasing insulin sensitivity in muscle tissue.

In 2019, a clinical trial at Johns Hopkins University found that patients who took metformin had a lower risk of cardiovascular disease. Because of these results, the American Diabetes Association updated its guidelines to recommend metformin for patients with early-stage diabetes. Dr. Sarah Chen, who led the trial, presented the findings at the European Association for the Study of Diabetes conference in Barcelona.

Common side effects of metformin include nausea and diarrhea. After patients reported gastrointestinal issues, doctors began prescribing an extended-release formulation, which reduced these symptoms.`

const METHODS: { id: Method; label: string; tag?: string; hint: string }[] = [
  {
    id: 'hybrid',
    label: 'Hybrid',
    tag: 'Recommended',
    hint: 'Both extractors, canonicalized into one graph with per-edge evidence.',
  },
  { id: 'autoschema', label: 'AutoSchemaKG', hint: 'Three direct extraction passes per chunk. Fastest.' },
  { id: 'socratic', label: 'SocraticKG', hint: '5W1H question–answer pairs first, then triples from each.' },
]

const DEFAULT_SETTINGS: Settings = {
  method: 'hybrid',
  canonicalize: true,
  qa_batch_size: 1,
  lang: 'en',
  chunk_size: 4000,
  chunk_overlap: 0,
  max_concept_nodes: 150,
  conceptualize: true,
}

function fmtElapsed(ms: number) {
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`
}

function useTick(live: boolean) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => tick((x) => x + 1), 500)
    return () => clearInterval(t)
  }, [live])
}

function StepNode({
  id,
  idx,
  active,
  onClick,
  status,
  summary,
  startedAt,
  endedAt,
}: {
  id: StepId
  idx: number
  active: boolean
  onClick: () => void
  status: string
  summary?: string
  startedAt?: number
  endedAt?: number
}) {
  useTick(status === 'running')
  const elapsed = startedAt ? fmtElapsed((endedAt ?? Date.now()) - startedAt) : ''
  const sub =
    status === 'running'
      ? elapsed
      : status === 'skipped'
        ? 'Skipped'
        : status === 'error'
          ? 'Stopped'
          : summary ?? STEP_META[id].sub
  return (
    <button className={`rail-step ${status} ${active ? 'active' : ''}`} onClick={onClick} title={`${STEP_META[id].title}: ${summary ?? STEP_META[id].blurb}`}>
      <span className="rail-dot">
        {status === 'done' ? <I.Check size={13} /> : status === 'error' ? '!' : status === 'running' ? <span className="ring" /> : idx + 1}
      </span>
      <span className="rail-text">
        <span className="rail-title">{STEP_META[id].short}</span>
        <span className="rail-sub">{sub}</span>
      </span>
    </button>
  )
}

function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className="switch-row">
      <span className="switch-text">
        <span>{label}</span>
        <span className="hint">{hint}</span>
      </span>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

function NumField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <span className="num-input">
        <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} />
        {suffix && <span className="suffix">{suffix}</span>}
      </span>
    </label>
  )
}

function Welcome({ onSample, canRun, onRun }: { onSample: () => void; canRun: boolean; onRun: () => void }) {
  return (
    <div className="welcome">
      <div className="hero">
        <span className="eyebrow">
          <I.Sparkle size={13} /> AutoSchemaKG × SocraticKG
        </span>
        <h2>
          Turn any document into a <span className="grad">knowledge graph</span>.
        </h2>
        <p>
          Paste text or drop in a PDF, pick a method, and watch every stage happen live, from the prompts sent to the
          model to the schema it discovers. Nothing is hidden: every edge keeps the evidence it came from.
        </p>
        <div className="hero-cta">
          <button className="btn-primary" onClick={onRun} disabled={!canRun}>
            <I.Play size={14} /> Build knowledge graph
          </button>
          <button className="btn-ghost" onClick={onSample}>
            <I.Doc size={15} /> Load sample text
          </button>
        </div>
      </div>
      <ol className="pipeline-preview">
        {STEP_ORDER.map((id, i) => (
          <li key={id} style={{ animationDelay: `${i * 45}ms` }}>
            <span className="pp-num">{String(i + 1).padStart(2, '0')}</span>
            <b>{STEP_META[id].title}</b>
            <span>{STEP_META[id].blurb}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

export default function App() {
  const { state, run, stop } = usePipeline()
  const [text, setText] = useState(SAMPLE)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [languages, setLanguages] = useState<string[]>(['en'])
  const [online, setOnline] = useState<boolean | null>(null)
  const [active, setActive] = useState<StepId | null>(null)
  const [follow, setFollow] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings((s) => ({ ...s, [k]: v }))

  // Poll the backend so the header can say whether it's reachable (it takes a few seconds to import atlas_rag).
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    let gotConfig = false
    const poll = async () => {
      try {
        const r = await fetch('/api/healthz')
        if (!r.ok) throw new Error()
        if (!gotConfig) {
          const c = await (await fetch('/api/config')).json()
          if (!cancelled && c.languages?.length) setLanguages(c.languages)
          gotConfig = true
        }
        if (!cancelled) setOnline(true)
        timer = setTimeout(poll, 15000)
      } catch {
        if (!cancelled) setOnline(false)
        timer = setTimeout(poll, 2500)
      }
    }
    poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  // Auto-follow the step that's currently running.
  useEffect(() => {
    if (!follow) return
    const running = STEP_ORDER.find((s) => state.steps[s].status === 'running')
    if (running) setActive(running)
    else if (state.steps.final.status === 'done') setActive('final')
  }, [state.steps, follow])

  const onFile = async (f: File) => {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', f)
      const r = await fetch('/api/upload', { method: 'POST', body: fd })
      if (!r.ok) throw new Error((await r.json()).detail ?? r.statusText)
      const j = await r.json()
      setText(j.text)
      setFileName(j.filename)
    } catch (e) {
      alert(`Could not read file: ${(e as Error).message}`)
    } finally {
      setUploading(false)
    }
  }

  const start = () => {
    setFollow(true)
    setActive('chunk')
    run(text, settings)
  }

  const started = state.running || state.chunks.length > 0 || state.error !== null
  const view = active ?? (started ? 'chunk' : null)
  const runStart = state.steps.chunk.startedAt
  const finished = state.steps.final.status === 'done'
  useTick(state.running)
  const totalElapsed = runStart ? fmtElapsed((finished ? state.steps.final.endedAt! : Date.now()) - runStart) : ''
  const settled = STEP_ORDER.filter((s) => ['done', 'skipped'].includes(state.steps[s].status)).length
  const progress = (settled / STEP_ORDER.length) * 100

  const callsRunning = state.calls.filter((c) => c.status === 'running').length
  const callsDone = state.calls.filter((c) => c.status !== 'running').length
  const callsFailed = state.calls.filter((c) => c.status === 'error').length
  const words = text.trim() ? text.trim().split(/\s+/).length : 0

  return (
    <div className="app">
      <div className="aurora" aria-hidden />
      <header className="topbar">
        <div className="brand">
          <I.Logo />
          <div>
            <h1>KG Studio</h1>
            <span className="tagline">Knowledge graphs you can watch being built</span>
          </div>
        </div>
        <div className="topbar-right">
          {started && (
            <span className={`run-pill ${state.running ? 'live' : finished ? 'ok' : state.error ? 'err' : ''}`}>
              {state.running ? <span className="pulse-dot" /> : finished ? <I.Check size={13} /> : null}
              {state.running ? 'Building' : finished ? 'Complete' : state.error ? 'Stopped' : 'Idle'}
              {totalElapsed && <span className="pill-time">{totalElapsed}</span>}
            </span>
          )}
          <span className={`server-pill ${online === null ? '' : online ? 'ok' : 'off'}`}>
            <span className="sdot" />
            {online === null ? 'Connecting…' : online ? 'Server online' : 'Server offline'}
          </span>
        </div>
      </header>

      <div className="main">
        <aside className="sidebar">
          <div className="sidebar-scroll">
            <section
              className={`panel source ${dragging ? 'dragging' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragging(false)
                const f = e.dataTransfer.files?.[0]
                if (f) onFile(f)
              }}
            >
              <div className="panel-head">
                <span className="panel-title">
                  <I.Doc size={15} /> Source
                </span>
                <span className="meta">
                  {words.toLocaleString()} words · {text.length.toLocaleString()} chars
                </span>
              </div>
              {fileName && (
                <div className="file-chip">
                  <I.Doc size={13} /> <span>{fileName}</span>
                  <button aria-label="Clear file" onClick={() => setFileName(null)}>
                    <I.X size={12} />
                  </button>
                </div>
              )}
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                spellCheck={false}
                placeholder="Paste text here, or drop a PDF / TXT / MD / JSON file…"
              />
              <div className="drop-hint">
                <I.Upload size={18} /> Drop to load file
              </div>
              <div className="btn-row">
                <button className="btn-soft" onClick={() => fileRef.current?.click()} disabled={uploading}>
                  {uploading ? <span className="spinner tiny" /> : <I.Upload size={14} />}
                  {uploading ? 'Reading…' : 'Upload file'}
                </button>
                <button
                  className="btn-soft"
                  onClick={() => {
                    setText(SAMPLE)
                    setFileName(null)
                  }}
                >
                  Sample
                </button>
                <button
                  className="btn-soft subtle"
                  onClick={() => {
                    setText('')
                    setFileName(null)
                  }}
                  disabled={!text}
                >
                  Clear
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  hidden
                  accept=".pdf,.txt,.md,.json"
                  onChange={(e) => {
                    if (e.target.files?.[0]) onFile(e.target.files[0])
                    e.target.value = ''
                  }}
                />
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <span className="panel-title">
                  <I.Layers size={15} /> Method
                </span>
              </div>
              <div className="methods" role="radiogroup">
                {METHODS.map((m) => (
                  <button
                    key={m.id}
                    role="radio"
                    aria-checked={settings.method === m.id}
                    className={`method ${m.id} ${settings.method === m.id ? 'on' : ''}`}
                    onClick={() => set('method', m.id)}
                  >
                    <span className="radio" />
                    <span className="method-body">
                      <span className="method-title">
                        {m.label}
                        {m.tag && <span className="tag">{m.tag}</span>}
                      </span>
                      <span className="hint">{m.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section className="panel">
              <Switch
                label="Canonicalize"
                hint="Merge synonyms and abbreviations across extractors"
                checked={settings.canonicalize}
                onChange={(v) => set('canonicalize', v)}
              />
              <div className="divider" />
              <Switch
                label="Conceptualize"
                hint="Induce a schema by abstracting every node"
                checked={settings.conceptualize}
                onChange={(v) => set('conceptualize', v)}
              />
            </section>

            <details className="panel advanced">
              <summary>
                <span className="panel-title">
                  <I.Sliders size={15} /> Advanced
                </span>
                <I.Chevron size={14} className="chev" />
              </summary>
              <div className="fields">
                <label className="field">
                  <span>Prompt language</span>
                  <select value={settings.lang} onChange={(e) => set('lang', e.target.value)}>
                    {languages.map((l) => (
                      <option key={l}>{l}</option>
                    ))}
                  </select>
                </label>
                <NumField label="Chunk size" suffix="chars" min={200} step={100} value={settings.chunk_size} onChange={(v) => set('chunk_size', v)} />
                <NumField label="Chunk overlap" suffix="chars" min={0} step={50} value={settings.chunk_overlap} onChange={(v) => set('chunk_overlap', v)} />
                {settings.method !== 'autoschema' && (
                  <NumField label="QA pairs per call" min={1} max={20} value={settings.qa_batch_size} onChange={(v) => set('qa_batch_size', v)} />
                )}
                {settings.conceptualize && (
                  <NumField label="Max nodes to conceptualize" min={1} value={settings.max_concept_nodes} onChange={(v) => set('max_concept_nodes', v)} />
                )}
              </div>
            </details>

            <section className={`panel activity ${showLog ? 'open' : ''}`}>
              <button className="panel-head clickable" onClick={() => setShowLog(!showLog)}>
                <span className="panel-title">
                  <I.Activity size={15} /> Activity
                </span>
                <span className="meta">
                  {callsRunning > 0 && <span className="spinner tiny" />}
                  {callsDone} done{callsRunning ? ` · ${callsRunning} active` : ''}
                  {callsFailed ? <span className="err-text"> · {callsFailed} failed</span> : null}
                  <I.Chevron size={14} className="chev" />
                </span>
              </button>
              {showLog && (
                <ul className="call-list">
                  {state.calls
                    .slice(-150)
                    .reverse()
                    .map((c) => (
                      <li key={c.id} className={c.status} title={c.error}>
                        <span className="call-status">
                          {c.status === 'running' ? <span className="spinner tiny" /> : c.status === 'ok' ? <I.Check size={12} /> : <I.X size={12} />}
                        </span>
                        <span className="call-label">{c.label}</span>
                        <span className="call-time">{c.seconds != null ? `${c.seconds}s` : ''}</span>
                      </li>
                    ))}
                  {state.calls.length === 0 && <li className="call-empty">Model requests will stream in here.</li>}
                </ul>
              )}
            </section>
          </div>

          <div className="sidebar-foot">
            {state.error && <div className="error-box">{state.error}</div>}
            {state.running ? (
              <button className="btn-stop" onClick={stop}>
                <I.Stop size={13} /> Stop run
              </button>
            ) : (
              <button className="btn-primary wide" onClick={start} disabled={!text.trim()}>
                <I.Play size={14} /> {finished ? 'Rebuild graph' : 'Build knowledge graph'}
              </button>
            )}
          </div>
        </aside>

        <main className="content">
          <nav className="rail">
            <div className="rail-steps">
              {STEP_ORDER.map((id, i) => (
                <StepNode
                  key={id}
                  id={id}
                  idx={i}
                  active={view === id}
                  onClick={() => {
                    setFollow(false)
                    setActive(id)
                  }}
                  {...state.steps[id]}
                />
              ))}
            </div>
            {!follow && state.running && (
              <button className="follow" onClick={() => setFollow(true)}>
                <span className="pulse-dot" /> Follow live
              </button>
            )}
            <div className="rail-progress" style={{ width: `${progress}%` }} />
          </nav>
          <div className="stage" key={view ?? 'welcome'}>
            {view === null && (
              <Welcome
                canRun={!!text.trim()}
                onRun={start}
                onSample={() => {
                  setText(SAMPLE)
                  setFileName(null)
                }}
              />
            )}
            {view === 'chunk' && <ChunkView s={state} />}
            {view === 'qa' && <QAView s={state} />}
            {view === 'extract' && <ExtractView s={state} />}
            {view === 'canon' && <CanonView s={state} />}
            {view === 'graph' && <GraphStepView s={state} />}
            {view === 'concept' && <ConceptView s={state} />}
            {view === 'schema' && <SchemaView s={state} />}
            {view === 'final' && <FinalView s={state} />}
          </div>
        </main>
      </div>
    </div>
  )
}
