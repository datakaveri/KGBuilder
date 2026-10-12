import { useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from 'react-force-graph-2d'
import type { GEdge, GNode, Graph } from '../types'
import { CONCEPT_EDGE, EDGE, edgeSourceKey, NODE_COLORS, SOURCE_COLORS } from './graphStyle'
import * as I from './icons'

type FNode = NodeObject<GNode & { degree: number }>
type FLink = LinkObject<FNode, GEdge & { curvature: number }>

interface Props {
  graph: Graph
  highlight?: string | null
  onSelect?: (node: GNode | null) => void
  selectedId?: string | null
  showEdgeLabels?: boolean
  colorBySource?: boolean
}

export default function GraphCanvas({
  graph,
  highlight,
  onSelect,
  selectedId,
  showEdgeLabels = true,
  colorBySource = false,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const fgRef = useRef<ForceGraphMethods<FNode, FLink>>(undefined)
  const [size, setSize] = useState({ w: 600, h: 400 })
  const [hover, setHover] = useState<string | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // force-graph mutates its inputs, so hand it fresh copies whenever the graph changes.
  const data = useMemo(() => {
    const deg: Record<string, number> = {}
    for (const e of graph.edges) {
      deg[e.source] = (deg[e.source] ?? 0) + 1
      deg[e.target] = (deg[e.target] ?? 0) + 1
    }
    // Spread parallel edges between the same pair of nodes into distinct curves.
    const pairCount: Record<string, number> = {}
    const pairSeen: Record<string, number> = {}
    const pk = (e: GEdge) => [e.source, e.target].sort().join('\u0000')
    for (const e of graph.edges) pairCount[pk(e)] = (pairCount[pk(e)] ?? 0) + 1
    return {
      nodes: graph.nodes.map((n) => ({ ...n, degree: deg[n.id] ?? 0 })) as FNode[],
      links: graph.edges.map((e) => {
        const k = pk(e)
        const i = (pairSeen[k] = (pairSeen[k] ?? 0) + 1) - 1
        const n = pairCount[k]
        const dir = e.source < e.target ? 1 : -1
        const curvature = n > 1 ? dir * (i - (n - 1) / 2) * 0.35 : 0
        return { ...e, curvature }
      }) as unknown as FLink[],
    }
  }, [graph])

  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const e of graph.edges) {
      if (!m.has(e.source)) m.set(e.source, new Set())
      if (!m.has(e.target)) m.set(e.target, new Set())
      m.get(e.source)!.add(e.target)
      m.get(e.target)!.add(e.source)
    }
    return m
  }, [graph])

  const focus = hover ?? selectedId ?? null
  const q = highlight?.trim().toLowerCase() || ''

  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    fg.d3Force('charge')?.strength(graph.nodes.length > 200 ? -60 : -140)
    fg.d3Force('link')?.distance(graph.nodes.length > 200 ? 40 : 70)
    const t = setTimeout(() => fg.zoomToFit(500, 50), 1200)
    return () => clearTimeout(t)
  }, [data, graph.nodes.length])

  const isDim = (id: string) => {
    if (focus) return id !== focus && !neighbors.get(focus)?.has(id)
    return false
  }
  const matches = (n: FNode) => q !== '' && n.label.toLowerCase().includes(q)

  return (
    <div ref={wrapRef} className="graph-wrap">
      <ForceGraph2D<FNode, FLink>
        ref={fgRef}
        width={size.w}
        height={size.h}
        graphData={data}
        backgroundColor="rgba(0,0,0,0)"
        cooldownTicks={200}
        linkDirectionalArrowLength={3.5}
        linkDirectionalArrowRelPos={0.92}
        linkColor={(l) => {
          const s = (l.source as FNode).id as string
          const t = (l.target as FNode).id as string
          const dim = focus && s !== focus && t !== focus
          if (l.type === 'Concept') return dim ? CONCEPT_EDGE.dim : CONCEPT_EDGE.on
          if (dim) return EDGE.dim
          const sk = colorBySource ? edgeSourceKey(l as unknown as GEdge) : null
          return sk ? SOURCE_COLORS[sk] : EDGE.on
        }}
        linkLineDash={(l) => (l.type === 'Concept' ? [3, 3] : null)}
        linkCurvature="curvature"
        linkWidth={(l) => {
          const s = (l.source as FNode).id
          const t = (l.target as FNode).id
          const base = colorBySource && edgeSourceKey(l as unknown as GEdge) === 'both' ? 1.8 : 1
          return focus && (s === focus || t === focus) ? base + 1 : base
        }}
        nodeRelSize={4}
        nodeVal={(n) => 1 + Math.min(n.degree, 12) * 0.6}
        nodeLabel={(n) => `<b>${escapeHtml(n.label)}</b><br/><span style="opacity:.7">${n.type}</span>`}
        onNodeHover={(n) => setHover(n ? (n.id as string) : null)}
        onNodeClick={(n) => {
          onSelect?.(graph.nodes.find((g) => g.id === n.id) ?? null)
          fgRef.current?.centerAt(n.x, n.y, 400)
        }}
        onBackgroundClick={() => onSelect?.(null)}
        nodeCanvasObjectMode={() => 'replace'}
        nodeCanvasObject={(n, ctx, scale) => {
          const r = Math.sqrt(1 + Math.min(n.degree, 12) * 0.6) * 4
          const dim = isDim(n.id as string)
          const hit = matches(n)
          ctx.globalAlpha = dim ? 0.15 : 1
          ctx.beginPath()
          if (n.type === 'event') {
            ctx.rect(n.x! - r, n.y! - r * 0.75, r * 2, r * 1.5)
          } else if (n.type === 'concept') {
            ctx.moveTo(n.x!, n.y! - r)
            ctx.lineTo(n.x! + r, n.y!)
            ctx.lineTo(n.x!, n.y! + r)
            ctx.lineTo(n.x! - r, n.y!)
            ctx.closePath()
          } else {
            ctx.arc(n.x!, n.y!, r, 0, 2 * Math.PI)
          }
          const color = NODE_COLORS[n.type]
          const lit = hit || n.id === selectedId || n.id === focus
          ctx.shadowColor = color
          ctx.shadowBlur = lit ? 18 : dim ? 0 : 6
          ctx.fillStyle = color
          ctx.fill()
          ctx.shadowBlur = 0
          ctx.lineWidth = 1 / scale
          ctx.strokeStyle = 'rgba(255,255,255,0.35)'
          ctx.stroke()
          if (hit || n.id === selectedId) {
            ctx.lineWidth = 2.2 / scale
            ctx.strokeStyle = hit ? '#facc15' : '#ffffff'
            ctx.stroke()
          }
          const showLabel = graph.nodes.length <= 60 || scale > 1.6 || n.id === focus || hit || (!dim && focus !== null) || n.degree > 6
          if (showLabel) {
            const fontSize = Math.max(10 / scale, 2)
            ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`
            const text = n.label.length > 48 ? n.label.slice(0, 46) + '…' : n.label
            ctx.textAlign = 'center'
            ctx.textBaseline = 'top'
            ctx.fillStyle = 'rgba(232,236,244,0.9)'
            ctx.fillText(text, n.x!, n.y! + r + 2 / scale)
          }
          ctx.globalAlpha = 1
        }}
        nodePointerAreaPaint={(n, color, ctx) => {
          const r = Math.sqrt(1 + Math.min(n.degree, 12) * 0.6) * 4 + 2
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(n.x!, n.y!, r, 0, 2 * Math.PI)
          ctx.fill()
        }}
        linkCanvasObjectMode={() => 'after'}
        linkCanvasObject={(l, ctx, scale) => {
          if (!showEdgeLabels || l.type === 'Concept') return
          const s = l.source as FNode
          const t = l.target as FNode
          const touches = focus && (s.id === focus || t.id === focus)
          if (!(touches || scale > 2.4)) return
          const fontSize = Math.max(9 / scale, 1.5)
          ctx.font = `${fontSize}px Inter, system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          let x = (s.x! + t.x!) / 2
          let y = (s.y! + t.y!) / 2
          if (l.curvature) {
            // force-graph draws a quadratic curve; its midpoint sits at half the control offset.
            const dx = t.x! - s.x!
            const dy = t.y! - s.y!
            x += (dy * l.curvature) / 2
            y += (-dx * l.curvature) / 2
          }
          const w = ctx.measureText(l.relation).width
          ctx.fillStyle = 'rgba(10,12,18,0.88)'
          ctx.fillRect(x - w / 2 - 2, y - fontSize / 2 - 1, w + 4, fontSize + 2)
          ctx.fillStyle = '#5eead4'
          ctx.fillText(l.relation, x, y)
        }}
      />
      <div className="graph-tools">
        <button aria-label="Zoom in" onClick={() => fgRef.current?.zoom(fgRef.current.zoom() * 1.4, 250)}>
          <I.Plus size={15} />
        </button>
        <button aria-label="Zoom out" onClick={() => fgRef.current?.zoom(fgRef.current.zoom() / 1.4, 250)}>
          <I.Minus size={15} />
        </button>
        <button aria-label="Fit to view" onClick={() => fgRef.current?.zoomToFit(400, 50)}>
          <I.Expand size={14} />
        </button>
      </div>
    </div>
  )
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
