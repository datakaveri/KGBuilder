export type StepId = 'chunk' | 'qa' | 'extract' | 'canon' | 'graph' | 'concept' | 'schema' | 'final'
export type Method = 'autoschema' | 'socratic' | 'hybrid'
export type Source = 'autoschema' | 'socratic'
export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error'

export interface StepState {
  status: StepStatus
  summary?: string
  startedAt?: number
  endedAt?: number
}

export interface Chunk {
  id: number
  text: string
  chars: number
}

export type ExtractKind = 'entity_relation' | 'event_entity' | 'event_relation'

export interface Triple {
  Head: string
  Relation: string
  Tail: string
}
export interface EventEntity {
  Event: string
  Entity: string[]
}

export interface ExtractionResult {
  prompt: string
  raw: string
  parsed: (Triple | EventEntity)[]
  dropped?: number
  error: string | null
}

export type WhType = 'who' | 'what' | 'when' | 'where' | 'why' | 'how' | 'other'

export interface QAPair {
  id: string
  question: string
  answer: string
  wh: WhType
}

export interface QAGeneration {
  prompt: string
  raw: string
  pairs: QAPair[]
  error: string | null
}

export interface QATripleResult {
  chunk: number
  qa_ids: string[]
  prompt: string
  raw: string
  parsed: (Triple & { qa_id: string })[]
  dropped: { item: Triple; reason: string }[]
  error: string | null
}

export interface CanonMerge {
  canonical: string
  members: string[]
}

export interface CanonResult {
  kind: 'entity' | 'relation'
  before: number
  after: number
  merges: CanonMerge[]
  groups: { candidates: string[]; merges: CanonMerge[]; raw: string; error: string | null }[]
  info: { items: number; clusters: number; embedder: string | null; embedder_error?: string }
}

export interface GraphMetrics {
  nodes: number
  triples: number
  avg_degree: number
  components: number
  nfi: number
  largest_component: number
}

export interface MetricsBundle {
  after: Record<string, GraphMetrics>
  before?: Record<string, GraphMetrics>
  with_concepts?: GraphMetrics
}

export interface Evidence {
  source: Source
  kind: string
  chunk: number
  question?: string
  answer?: string
  qa_id?: string
  original: string
}

export type NodeType = 'entity' | 'event' | 'concept'

export interface GNode {
  id: string
  label: string
  type: NodeType
  chunks: number[]
  concepts: string[]
  sources: Source[]
  aliases: string[]
}
export interface GEdge {
  source: string
  target: string
  relation: string
  type: 'Relation' | 'Concept'
  concepts?: string[]
  sources: Source[]
  count: number
  evidence: Evidence[]
}
export interface Graph {
  nodes: GNode[]
  edges: GEdge[]
}

export interface ConceptRow {
  node: string
  label: string
  node_type: 'entity' | 'event' | 'relation'
  concepts: string[]
  prompt: string
  raw: string
  error: string | null
}

export interface SchemaConcept {
  name: string
  count: number
  types: Partial<Record<'entity' | 'event' | 'relation', number>>
  instances: string[]
}

export interface LlmCall {
  id: string
  stage: 'qa' | 'extract' | 'qa_triple' | 'canon' | 'concept'
  label: string
  status: 'running' | 'ok' | 'error'
  started: number
  seconds?: number
  error?: string
}

export interface Settings {
  method: Method
  canonicalize: boolean
  qa_batch_size: number
  lang: string
  chunk_size: number
  chunk_overlap: number
  max_concept_nodes: number
  conceptualize: boolean
}
