import { useCallback, useReducer, useRef } from 'react'
import type {
  CanonResult,
  Chunk,
  ConceptRow,
  ExtractionResult,
  ExtractKind,
  Graph,
  LlmCall,
  Method,
  MetricsBundle,
  QAGeneration,
  QATripleResult,
  SchemaConcept,
  Settings,
  StepId,
  StepState,
} from './types'

export const STEP_ORDER: StepId[] = ['chunk', 'qa', 'extract', 'canon', 'graph', 'concept', 'schema', 'final']

export interface PipelineState {
  running: boolean
  error: string | null
  method: Method | null
  steps: Record<StepId, StepState>
  chunks: Chunk[]
  qa: Record<number, QAGeneration>
  qaTriples: QATripleResult[]
  extraction: Record<number, Partial<Record<ExtractKind, ExtractionResult>>>
  canon: Partial<Record<'entity' | 'relation', CanonResult>>
  baseGraph: Graph | null
  graphStats: { self_loops: number; merged_duplicates: number } | null
  metrics: MetricsBundle | null
  relations: string[]
  conceptTotal: number
  conceptSkipped: number
  concepts: ConceptRow[]
  schema: SchemaConcept[]
  relationConcepts: Record<string, string[]>
  finalGraph: Graph | null
  runId: string | null
  outputDir: string | null
  calls: LlmCall[]
}

const freshSteps = (): Record<StepId, StepState> =>
  Object.fromEntries(STEP_ORDER.map((s) => [s, { status: 'pending' }])) as Record<StepId, StepState>

export const initialState: PipelineState = {
  running: false,
  error: null,
  method: null,
  steps: freshSteps(),
  chunks: [],
  qa: {},
  qaTriples: [],
  extraction: {},
  canon: {},
  baseGraph: null,
  graphStats: null,
  metrics: null,
  relations: [],
  conceptTotal: 0,
  conceptSkipped: 0,
  concepts: [],
  schema: [],
  relationConcepts: {},
  finalGraph: null,
  runId: null,
  outputDir: null,
  calls: [],
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ev = { type: string; ts: number; [k: string]: any }
type Action = { type: 'reset' } | { type: 'event'; ev: Ev } | { type: 'stopped'; error?: string }

/** Drop the event envelope (type, ts) and keep the payload. */
function payload<T>(ev: Ev): T {
  const rest: Record<string, unknown> = { ...ev }
  delete rest.type
  delete rest.ts
  return rest as T
}

const KIND_LABEL: Record<string, string> = {
  entity_relation: 'Entity–Relation',
  event_entity: 'Event–Entity',
  event_relation: 'Event–Relation',
}

function reducer(state: PipelineState, action: Action): PipelineState {
  if (action.type === 'reset') return { ...initialState, steps: freshSteps(), running: true }
  if (action.type === 'stopped') {
    const steps = { ...state.steps }
    for (const s of STEP_ORDER) {
      if (steps[s].status === 'running') steps[s] = { ...steps[s], status: 'error', endedAt: Date.now() }
    }
    return {
      ...state,
      running: false,
      steps,
      error: action.error ?? state.error,
      calls: state.calls.map((c) => (c.status === 'running' ? { ...c, status: 'error', error: 'cancelled' } : c)),
    }
  }

  const ev = action.ev
  switch (ev.type) {
    case 'step': {
      const prev = state.steps[ev.step as StepId]
      const now = ev.ts * 1000
      return {
        ...state,
        steps: {
          ...state.steps,
          [ev.step]: {
            status: ev.status,
            summary: ev.summary ?? prev.summary,
            startedAt: ev.status === 'running' ? now : prev.startedAt ?? now,
            endedAt: ev.status === 'running' ? undefined : now,
          },
        },
      }
    }
    case 'run_info':
      return { ...state, method: ev.method }
    case 'chunks':
      return { ...state, chunks: ev.chunks }
    case 'qa':
      return {
        ...state,
        qa: { ...state.qa, [ev.chunk]: { prompt: ev.prompt, raw: ev.raw, pairs: ev.pairs, error: ev.error } },
      }
    case 'qa_triples':
      return { ...state, qaTriples: [...state.qaTriples, payload<QATripleResult>(ev)] }
    case 'canon':
      return { ...state, canon: { ...state.canon, [ev.kind]: payload<CanonResult>(ev) } }
    case 'extraction':
      return {
        ...state,
        extraction: {
          ...state.extraction,
          [ev.chunk]: {
            ...state.extraction[ev.chunk],
            [ev.kind]: { prompt: ev.prompt, raw: ev.raw, parsed: ev.parsed, dropped: ev.dropped, error: ev.error },
          },
        },
      }
    case 'base_graph':
      return { ...state, baseGraph: ev.graph, relations: ev.relations, graphStats: ev.stats, metrics: ev.metrics }
    case 'concept_plan':
      return { ...state, conceptTotal: ev.total, conceptSkipped: ev.skipped }
    case 'concept':
      return { ...state, concepts: [...state.concepts, payload<ConceptRow>(ev)] }
    case 'schema':
      return { ...state, schema: ev.concepts, relationConcepts: ev.relation_concepts }
    case 'final_graph':
      return { ...state, finalGraph: ev.graph, runId: ev.run_id, outputDir: ev.output_dir, metrics: ev.metrics }
    case 'llm_start': {
      const label =
        ev.stage === 'extract'
          ? `Chunk ${ev.chunk + 1} · ${KIND_LABEL[ev.kind] ?? ev.kind}`
          : ev.stage === 'qa'
            ? `Chunk ${ev.chunk + 1} · 5W1H QA generation`
            : ev.stage === 'qa_triple'
              ? `QA→triples: ${ev.question}`
              : ev.stage === 'canon'
                ? `Canonicalize ${ev.kind}s (${ev.size} candidates)`
                : `${ev.node_type}: ${ev.node}`
      const call: LlmCall = { id: ev.call_id, stage: ev.stage, label, status: 'running', started: ev.ts * 1000 }
      return { ...state, calls: [...state.calls, call] }
    }
    case 'llm_end':
      return {
        ...state,
        calls: state.calls.map((c) =>
          c.id === ev.call_id && c.status === 'running'
            ? { ...c, status: ev.ok ? 'ok' : 'error', seconds: ev.seconds, error: ev.error }
            : c,
        ),
      }
    case 'error':
      return { ...state, error: ev.message }
    case 'done':
      return { ...state, running: false }
    default:
      return state
  }
}

export function usePipeline() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const abortRef = useRef<AbortController | null>(null)

  const run = useCallback(async (text: string, settings: Settings) => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    dispatch({ type: 'reset' })
    try {
      const res = await fetch('/api/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, ...settings }),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) throw new Error(`Server responded ${res.status}: ${await res.text()}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (line) dispatch({ type: 'event', ev: JSON.parse(line) })
        }
      }
      dispatch({ type: 'stopped' })
    } catch (e) {
      const msg = (e as Error).name === 'AbortError' ? 'Run cancelled.' : (e as Error).message
      dispatch({ type: 'stopped', error: msg })
    }
  }, [])

  const stop = useCallback(() => abortRef.current?.abort(), [])

  return { state, run, stop }
}
