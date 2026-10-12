import type { GEdge, NodeType } from '../types'

// Keep in sync with --entity / --event / --concept / --relation in index.css.
export const NODE_COLORS: Record<NodeType, string> = {
  entity: '#60a5fa',
  event: '#fbbf24',
  concept: '#c084fc',
}

export const SOURCE_COLORS = {
  autoschema: 'rgba(96,165,250,0.75)',
  socratic: 'rgba(45,212,191,0.8)',
  both: 'rgba(250,204,21,0.9)',
}

export const CONCEPT_EDGE = { on: 'rgba(192,132,252,0.35)', dim: 'rgba(192,132,252,0.05)' }
export const EDGE = { on: 'rgba(148,163,184,0.38)', dim: 'rgba(148,163,184,0.05)' }

export function edgeSourceKey(e: GEdge): keyof typeof SOURCE_COLORS | null {
  if (!e.sources?.length) return null
  return e.sources.length > 1 ? 'both' : e.sources[0]
}
