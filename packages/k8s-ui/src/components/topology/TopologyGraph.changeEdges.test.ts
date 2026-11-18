import { describe, expect, it } from 'vitest'
import { buildEdges } from './TopologyGraph'
import type { TopologyEdge, TopologyNode } from '../../types'

// A change in flight keeps its cyan dashes on a graph of any size, and marches
// only on a graph small enough to animate.
describe('topology change edges', () => {
  const nodes = [
    { id: 'deploy', kind: 'Deployment', name: 'web', status: 'degraded', data: { rollout: { phase: 'progressing', active: true, label: 'Rolling out' } } },
    { id: 'rs', kind: 'ReplicaSet', name: 'web-2', status: 'healthy', data: {} },
  ] as unknown as TopologyNode[]
  const edges = [{ id: 'deploy-rs', source: 'deploy', target: 'rs', type: 'manages' }] as unknown as TopologyEdge[]
  const build = (nodeCount: number) => buildEdges(edges, new Set(), new Map(), 'none' as never, false, undefined, nodeCount, undefined, false, nodes)

  it('marches on a small graph', () => {
    const [edge] = build(10)
    expect(edge.data).toEqual({ change: true })
    expect(edge.animated).toBe(true)
  })

  it('holds still on a graph too large to animate, and stays a change edge', () => {
    const [edge] = build(500)
    expect(edge.data).toEqual({ change: true })
    expect(edge.animated).toBe(false)
    expect(edge.style?.strokeDasharray).toBeTruthy()
  })
})
