import { describe, expect, it } from 'vitest'
import { changingSources, nextChangeDeadline, topologyChangeKey, topologyNodeAwaiting, topologyNodeChanging, topologyNodeHold } from './topology-motion'
import type { TopologyEdge, TopologyNode } from '../../types'

const node = (id: string, kind: string, data: Record<string, unknown> = {}) => ({ id, kind, name: id, status: 'healthy', data }) as unknown as TopologyNode
const edge = (source: string, target: string, type = 'manages') => ({ id: `${source}-${target}`, source, target, type }) as unknown as TopologyEdge
const rollingOut = { rollout: { phase: 'progressing', active: true } }

describe('topology change in flight', () => {
  it('marks a moving rollout, a starting workload and a GitOps pass, not a stall or a settled node', () => {
    expect(topologyNodeChanging(rollingOut)).toBe(true)
    expect(topologyNodeChanging({ starting: true })).toBe(true)
    expect(topologyNodeChanging({ inProgress: 'reconciling' })).toBe(true)
    expect(topologyNodeChanging({ inProgress: 'requested' })).toBe(true)
    expect(topologyNodeChanging({ rollout: { phase: 'stalled', active: false } })).toBe(false)
    expect(topologyNodeChanging({})).toBe(false)
  })

  it('runs down the chain a rollout manages, and only that chain', () => {
    const nodes = [node('deploy', 'Deployment', rollingOut), node('rs', 'ReplicaSet'), node('pod', 'Pod'), node('svc', 'Service')]
    const edges = [edge('deploy', 'rs'), edge('rs', 'pod'), edge('svc', 'deploy', 'exposes')]
    const marching = edges.filter((e) => e.type === 'manages' && changingSources(nodes, edges).has(e.source)).map((e) => e.id)
    expect(marching).toEqual(['deploy-rs', 'rs-pod'])
  })

  it('keys the change so edges are redrawn when work starts or ends with the structure unchanged', () => {
    const settled = [node('deploy', 'Deployment'), node('hr', 'HelmRelease')]
    const rollingNodes = [node('deploy', 'Deployment', rollingOut), node('hr', 'HelmRelease')]
    const reconciling = [node('deploy', 'Deployment'), node('hr', 'HelmRelease', { inProgress: 'reconciling' })]
    expect(topologyChangeKey(settled)).toBe('')
    expect(topologyChangeKey(rollingNodes)).not.toBe('')
    expect(topologyChangeKey(rollingNodes)).not.toBe(topologyChangeKey(reconciling))
    expect(topologyChangeKey(rollingNodes)).toBe(topologyChangeKey([...rollingNodes].reverse()))
  })
})

describe('topology nodes waiting on a person', () => {
  const awaiting = { label: 'Waiting for promotion', detail: 'Step 2 of 6' }

  it('marks a rollout parked until it is promoted', () => {
    expect(topologyNodeAwaiting({ awaiting, rollout: { phase: 'paused', active: true, manual: true } })).toEqual(awaiting)
    expect(topologyNodeChanging({ awaiting, rollout: { phase: 'paused', active: true, manual: true } })).toBe(false)
  })

  it('yields to a change in flight, and is nothing on a settled node', () => {
    expect(topologyNodeAwaiting({ awaiting, rollout: { phase: 'progressing', active: true } })).toBeUndefined()
    expect(topologyNodeAwaiting({ awaiting, inProgress: 'reconciling' })).toBeUndefined()
    expect(topologyNodeAwaiting({})).toBeUndefined()
    expect(topologyNodeAwaiting(undefined)).toBeUndefined()
  })

  it('marks a custom resource whose controller is still working as changing', () => {
    expect(topologyNodeChanging({ inProgress: 'reconciling', inProgressMessage: 'Issuing certificate as Secret does not exist' })).toBe(true)
  })
})

describe('topology nodes holding between two rollout steps', () => {
  it('says so for a timed pause, and for nothing that moves, waits on a person or is settled', () => {
    expect(topologyNodeHold({ rollout: { phase: 'paused', active: true, manual: false, label: 'Rollout paused', detail: 'Step 4 (Pause: 30s)' } })).toEqual({ label: 'Rollout paused', detail: 'Step 4 (Pause: 30s)', phase: 'paused' })
    expect(topologyNodeHold({ rollout: { phase: 'progressing', active: true, label: 'Rolling out' } })).toBeUndefined()
    expect(topologyNodeHold({ awaiting: { label: 'Waiting for promotion' }, rollout: { phase: 'paused', active: true, manual: true, label: 'Waiting for promotion' } })).toBeUndefined()
    expect(topologyNodeHold({ rollout: { phase: 'idle', active: false, label: 'Stable' } })).toBeUndefined()
    expect(topologyNodeHold({})).toBeUndefined()
  })
})

describe("a controller's reading that lapses", () => {
  const now = Date.parse('2026-11-18T10:05:00Z')
  const issuing = { inProgress: 'reconciling', inProgressSince: '2026-11-18T10:01:00Z', inProgressUntil: '2026-11-18T10:11:00Z' }

  it('counts as change until the backend says it lapses, and not after', () => {
    expect(topologyNodeChanging(issuing, now)).toBe(true)
    expect(topologyNodeChanging(issuing, Date.parse('2026-11-18T10:11:01Z'))).toBe(false)
    // A reading without a lapse (a Flux pass, which has its own timeout) keeps counting.
    expect(topologyNodeChanging({ inProgress: 'reconciling' }, Date.parse('2030-01-01T00:00:00Z'))).toBe(true)
  })

  it('names the next lapse, so the graph can look again without being told', () => {
    const nodes = [node('cert', 'Certificate', issuing), node('other', 'Certificate', { ...issuing, inProgressUntil: '2026-11-18T10:08:00Z' }), node('svc', 'Service')]
    expect(nextChangeDeadline(nodes, now)).toBe(Date.parse('2026-11-18T10:08:00Z'))
    expect(nextChangeDeadline(nodes, Date.parse('2026-11-18T10:09:00Z'))).toBe(Date.parse('2026-11-18T10:11:00Z'))
    expect(nextChangeDeadline(nodes, Date.parse('2026-11-18T10:12:00Z'))).toBeUndefined()
  })

  it('changes the redraw key when a reading lapses', () => {
    const nodes = [node('cert', 'Certificate', issuing)]
    expect(topologyChangeKey(nodes, now)).not.toBe('')
    expect(topologyChangeKey(nodes, Date.parse('2026-11-18T10:12:00Z'))).toBe('')
  })
})
