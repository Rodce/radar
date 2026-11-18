import { describe, expect, it } from 'vitest'

import { buildCauseByRef, buildFlowGraph, flowingSources, getSubtitle, inFlightNodeIDs, nodeCause, nodeInFlight, nodeTone } from './GitOpsTreeGraph'
import { inFlightKind, inFlightNote, inFlightSince, inFlightTimeoutMs, nodeAwaiting, nodeRolloutHold, treeMotion, treePollInterval, TREE_MOTION_BUDGET } from './tree-helpers'
import { formatElapsed, parseGoDuration } from '../../../utils/format'
import type { GitOpsIssue, GitOpsTreeNode } from '../../../types'

function node(extras: Partial<GitOpsTreeNode> = {}): GitOpsTreeNode {
  return {
    id: 'node-1',
    ref: { kind: 'Service', name: 'podinfo', namespace: 'demo-flux' },
    role: 'declared',
    tool: 'fluxcd',
    ...extras,
  }
}

describe('getSubtitle', () => {
  it('shows confirmed absence even when controller health is unknown or stale', () => {
    expect(getSubtitle(node({ tool: 'argocd', missing: true, sync: 'OutOfSync', health: 'Healthy' }))).toBe('OutOfSync • Not found in cluster')
  })
  it('shows what a healthy resource exposes, not that it is healthy', () => {
    // The status dot and the left border stripe already paint a healthy node
    // green, so the word adds nothing and the ports are the only thing here the
    // rest of the card can't say.
    expect(getSubtitle(node({
      sync: 'Synced',
      health: 'Healthy',
      info: [{ name: 'Service', value: 'ClusterIP :9898 +1 more' }],
    }))).toBe('Synced • ClusterIP :9898 +1 more')

    expect(getSubtitle(node({
      ref: { kind: 'Pod', name: 'podinfo-6b4f8c9d7-xk2mv', namespace: 'demo-flux' },
      role: 'generated',
      health: 'Healthy',
      info: [{ name: 'Phase', value: 'Running' }],
    }))).toBe('Running')

    expect(getSubtitle(node({
      ref: { kind: 'Ingress', name: 'podinfo', namespace: 'demo-flux' },
      sync: 'Synced',
      health: 'Healthy',
      info: [{ name: 'Host', value: 'podinfo.example.com' }],
    }))).toBe('Synced • podinfo.example.com')
  })

  it('keeps every health value the stripe colour cannot identify on its own', () => {
    // Progressing and Suspended are both yellow, Degraded and Missing both red.
    // Drop the word and the two become indistinguishable.
    expect(getSubtitle(node({
      sync: 'Synced',
      health: 'Progressing',
      info: [{ name: 'Service', value: 'LoadBalancer :80' }],
    }))).toBe('Synced • Progressing • LoadBalancer :80')

    expect(getSubtitle(node({
      ref: { kind: 'Deployment', name: 'podinfo', namespace: 'demo-flux' },
      sync: 'OutOfSync',
      health: 'Degraded',
      info: [{ name: 'Ready', value: '2/3' }],
    }))).toBe('OutOfSync • Degraded • 2/3')

    expect(getSubtitle(node({
      health: 'Unknown',
      info: [{ name: 'Service', value: 'ClusterIP :80' }],
    }))).toBe('Unknown • ClusterIP :80')
  })

  it('still reads as Healthy when there is nothing to say instead', () => {
    // Kinds infoFromTopology doesn't cover, and remote Argo destinations, reach
    // the tree with no info line at all. Those must not lose their status line.
    expect(getSubtitle(node({ sync: 'Synced', health: 'Healthy' }))).toBe('Synced • Healthy')
    expect(getSubtitle(node({ health: 'Healthy' }))).toBe('Healthy')
    expect(getSubtitle(node({ sync: 'OutOfSync', health: 'Missing' }))).toBe('OutOfSync • Missing')
  })

  it('lets lifecycle and grouping own the line outright', () => {
    expect(getSubtitle(node({
      role: 'group',
      sync: 'Synced',
      health: 'Healthy',
      info: [{ name: 'Phase', value: 'Running' }],
    }))).toBe('Click to expand')

    expect(getSubtitle(node({
      sync: 'Synced',
      health: 'Healthy',
      info: [{ name: 'Service', value: 'ClusterIP :9898 +1 more' }],
      data: { deletionTimestamp: '2026-09-11T13:09:43Z' },
    }))).toBe('Pending deletion')
  })

  it('falls back to the namespace only when the node states nothing else', () => {
    expect(getSubtitle(node())).toBe('demo-flux')
    expect(getSubtitle(node({ ref: { kind: 'ClusterRole', name: 'podinfo', namespace: '' } }))).toBe('')
  })
})

describe('nodeCause', () => {
  // Shapes as the tree API sends them: the Go side maps Argo's Degraded and
  // Missing to topologyStatus 'unhealthy', Progressing and Suspended to
  // 'degraded' (pkg/gitops/tree healthToTopology).
  const FAILURE = { text: 'Back-off restarting failed container main', lead: false }
  const LEAD = { text: 'Elasticsearch cluster health degraded', lead: true }

  it('shows the cause on a node the controller calls Degraded', () => {
    expect(nodeCause(node({ health: 'Degraded', healthSource: 'controller', topologyStatus: 'unhealthy' }), FAILURE)).toBe(FAILURE.text)
  })

  it('hides a failure verdict on a Progressing node, even when an issue matched it', () => {
    // A rollout in flight is not broken; a cause tooltip on it says it is.
    expect(nodeCause(node({ health: 'Progressing', healthSource: 'controller', topologyStatus: 'degraded' }), FAILURE)).toBeUndefined()
    expect(nodeCause(node({ health: 'Progressing', healthSource: 'radar', topologyStatus: 'degraded' }), FAILURE)).toBeUndefined()
  })

  it('hides it on a Suspended node, even when an issue matched it', () => {
    expect(nodeCause(node({ health: 'Suspended', healthSource: 'controller', topologyStatus: 'degraded' }), FAILURE)).toBeUndefined()
    expect(nodeCause(node({ health: 'Suspended', healthSource: 'controller', topologyStatus: 'degraded' }), LEAD)).toBeUndefined()
  })

  it('never shows it on a healthy node', () => {
    expect(nodeCause(node({ health: 'Healthy', healthSource: 'controller', topologyStatus: 'healthy' }), FAILURE)).toBeUndefined()
    expect(nodeCause(node({ health: 'Healthy', healthSource: 'radar', topologyStatus: 'healthy' }), LEAD)).toBeUndefined()
  })

  it('shows a lead on a node that is not failing, framed as possible', () => {
    // Argo CD 3 does not persist per-resource health, so an Argo-Degraded app
    // can have every node read Progressing or unknown by Radar. The events
    // lead is then the only pointer, and it lands on one of those nodes.
    expect(nodeCause(node({ health: 'Progressing', healthSource: 'radar', topologyStatus: 'degraded' }), LEAD))
      .toBe('Possible cause: Elasticsearch cluster health degraded')
    expect(nodeCause(node({ ref: { group: 'elasticsearch.k8s.elastic.co', kind: 'Elasticsearch', name: 'logs', namespace: 'search' }, topologyStatus: 'unknown' }), LEAD))
      .toBe('Possible cause: Elasticsearch cluster health degraded')
  })

  it('shows a Flux source fetch error on the source while Flux retries it', () => {
    const source = node({
      ref: { group: 'source.toolkit.fluxcd.io', kind: 'GitRepository', name: 'podinfo', namespace: 'flux-system' },
      health: 'Progressing',
      topologyStatus: 'degraded',
    })
    // Keyed like the tree's own nodes, so the issue's ref finds this node.
    const cause = buildCauseByRef([{
      severity: 'warning',
      scope: 'tree',
      reason: 'SourceNotReady',
      message: 'GitRepository flux-system/podinfo can\'t fetch updates.',
      cause: 'authentication required',
      refs: [{ group: 'source.toolkit.fluxcd.io', kind: 'GitRepository', namespace: 'flux-system', name: 'podinfo' }],
    }]).get('source.toolkit.fluxcd.io/GitRepository/flux-system/podinfo')
    expect(nodeCause(source, cause)).toBe('Possible cause: authentication required')
  })

  it('shows a lead as is on a failing node', () => {
    expect(nodeCause(node({ health: 'Degraded', topologyStatus: 'unhealthy' }), LEAD)).toBe(LEAD.text)
  })
})

describe('getSubtitle for work with no state of its own', () => {
  it("says what the controller says, not the namespace", () => {
    expect(getSubtitle(node({ ref: { group: 'flagger.app', kind: 'Canary', name: 'web', namespace: 'apps' }, data: { inProgress: 'reconciling', inProgressMessage: 'Flagger: Progressing' } }))).toBe('Flagger: Progressing')
    expect(getSubtitle(node({ ref: { group: 'flagger.app', kind: 'Canary', name: 'web', namespace: 'apps' } }))).toBe('apps')
  })
})

describe('buildCauseByRef', () => {
  const ref = { group: 'apps', kind: 'Deployment', namespace: 'demo', name: 'web' }
  function issue(extras: Partial<GitOpsIssue>): GitOpsIssue {
    return { severity: 'critical', scope: 'resource', reason: 'Degraded', message: 'Deployment web is Degraded', cause: 'crashloop', refs: [ref], ...extras }
  }

  it('marks the Warning-event lead and the Flux blockers as leads, and nothing else', () => {
    const lead = (reason: string) => [...buildCauseByRef([issue({ reason })]).values()][0]?.lead
    expect(lead('PossibleCause')).toBe(true)
    expect(lead('SourceNotReady')).toBe(true)
    expect(lead('ArtifactFailed')).toBe(true)
    expect(lead('DependencyNotReady')).toBe(true)
    expect(lead('Degraded')).toBe(false)
    expect(lead('Failed')).toBe(false)
  })

  it('keeps the first, most severe cause for a node', () => {
    const map = buildCauseByRef([issue({ cause: 'crashloop' }), issue({ severity: 'warning', reason: 'PossibleCause', cause: 'probe failed' })])
    expect([...map.values()]).toEqual([{ text: 'crashloop', lead: false }])
  })

  it('skips issues without a cause or a ref', () => {
    expect(buildCauseByRef([issue({ cause: undefined }), issue({ refs: [] })]).size).toBe(0)
  })
})

describe('nodeTone', () => {
  const base: GitOpsTreeNode = { id: 'n', ref: { kind: 'HelmRelease', namespace: 'apps', name: 'web' }, role: 'declared', tool: 'fluxcd' }

  it('paints a paused node neutral, not like a rollout', () => {
    expect(nodeTone({ ...base, health: 'Suspended', topologyStatus: 'neutral' })).toBe('neutral')
    expect(nodeTone({ ...base, health: 'Progressing', topologyStatus: 'degraded' })).toBe('degraded')
  })

  it('reads Suspended as neutral from a backend that still sends it as degraded', () => {
    expect(nodeTone({ ...base, health: 'Suspended', topologyStatus: 'degraded' })).toBe('neutral')
  })

  it('keeps a confirmed absence red whatever the health says', () => {
    expect(nodeTone({ ...base, missing: true, health: 'Suspended' })).toBe('unhealthy')
  })
})

describe('nodeInFlight', () => {
  const base: GitOpsTreeNode = { id: 'n', ref: { kind: 'HelmRelease', namespace: 'apps', name: 'web' }, role: 'declared', tool: 'fluxcd' }

  it('spins for a pass the controller reports', () => {
    expect(nodeInFlight({ ...base, sync: 'Reconciling', health: 'Progressing', healthSource: 'controller' })).toBe(true)
    expect(nodeInFlight({ ...base, sync: 'Synced', health: 'Healthy', data: { reconciling: true } })).toBe(true)
    expect(nodeInFlight({ ...base, tool: 'argocd', ref: { kind: 'Application', namespace: 'argocd', name: 'child' }, data: { operationInProgress: true } })).toBe(true)
    expect(nodeInFlight({ ...base, tool: 'argocd', ref: { kind: 'Deployment', namespace: 'apps', name: 'web' }, health: 'Progressing', healthSource: 'controllerApi' })).toBe(true)
  })

  it("trusts the root's health without a stated source", () => {
    expect(nodeInFlight({ ...base, role: 'root', health: 'Progressing' })).toBe(true)
  })

  it("doesn't spin for Radar's own replica-count Progressing", () => {
    expect(nodeInFlight({ ...base, ref: { kind: 'Deployment', namespace: 'apps', name: 'web' }, health: 'Progressing', healthSource: 'radar' })).toBe(false)
    expect(nodeInFlight({ ...base, role: 'generated', ref: { kind: 'ReplicaSet', namespace: 'apps', name: 'web-1' }, health: 'Progressing', healthSource: 'radar' })).toBe(false)
  })

  it("doesn't spin for a pause, a deletion, a missing object or a group", () => {
    expect(nodeInFlight({ ...base, health: 'Suspended', data: { reconciling: true } })).toBe(false)
    expect(nodeInFlight({ ...base, sync: 'Reconciling', data: { deletionTimestamp: '2026-11-17T10:00:00Z' } })).toBe(false)
    expect(nodeInFlight({ ...base, sync: 'Reconciling', missing: true })).toBe(false)
    expect(nodeInFlight({ ...base, role: 'group', sync: 'Reconciling' })).toBe(false)
  })

  it("spins for a workload rollout the way the workload page does, and not for a stall or a wait", () => {
    const deploy = { ...base, ref: { kind: 'Deployment', namespace: 'apps', name: 'web' }, health: 'Progressing' as const, healthSource: 'radar' }
    expect(nodeInFlight({ ...deploy, data: { rollout: { phase: 'progressing', active: true } } })).toBe(true)
    expect(nodeInFlight({ ...deploy, data: { rollout: { phase: 'applying', active: true } } })).toBe(true)
    expect(nodeInFlight({ ...deploy, data: { rollout: { phase: 'stalled', active: false } } })).toBe(false)
    expect(nodeInFlight({ ...deploy, data: { rollout: { phase: 'waiting', active: true } } })).toBe(false)
  })

  it('stays still on a settled node', () => {
    expect(nodeInFlight({ ...base, sync: 'Synced', health: 'Healthy', healthSource: 'controller' })).toBe(false)
  })
})

describe('inFlightNodeIDs', () => {
  it('collects the nodes whose edges march and that the header counts', () => {
    const hr: GitOpsTreeNode = { id: 'hr', ref: { kind: 'HelmRelease', namespace: 'apps', name: 'web' }, role: 'declared', tool: 'fluxcd', sync: 'Reconciling', health: 'Progressing', healthSource: 'controller' }
    const deploy: GitOpsTreeNode = { id: 'deploy', ref: { kind: 'Deployment', namespace: 'apps', name: 'web' }, role: 'generated', tool: 'fluxcd', health: 'Healthy', healthSource: 'radar', data: { rollout: { phase: 'progressing', active: true } } }
    const svc: GitOpsTreeNode = { id: 'svc', ref: { kind: 'Service', namespace: 'apps', name: 'web' }, role: 'generated', tool: 'fluxcd', health: 'Healthy', healthSource: 'radar' }
    expect([...inFlightNodeIDs([hr, deploy, svc])].sort()).toEqual(['deploy', 'hr'])
  })
})

describe('flowingSources', () => {
  const node = (id: string, kind: string, extra: Partial<GitOpsTreeNode> = {}): GitOpsTreeNode =>
    ({ id, ref: { kind, namespace: 'apps', name: id }, role: 'generated', tool: 'fluxcd', ...extra })
  const edges = [
    { source: 'hr', target: 'deploy', type: 'owns' as const },
    { source: 'hr', target: 'svc', type: 'owns' as const },
    { source: 'deploy', target: 'rs', type: 'owns' as const },
    { source: 'rs', target: 'pod', type: 'owns' as const },
  ]
  const hr = node('hr', 'HelmRelease', { role: 'root', sync: 'Reconciling', health: 'Progressing' })
  const marching = (sources: Set<string>) => edges.filter(e => sources.has(e.source)).map(e => `${e.source}->${e.target}`).sort()

  it('runs through the chain a rollout owns, down to its Pods', () => {
    const deploy = node('deploy', 'Deployment', { data: { rollout: { phase: 'progressing', active: true } } })
    const got = flowingSources([hr, deploy, node('svc', 'Service'), node('rs', 'ReplicaSet'), node('pod', 'Pod')], edges)
    expect(marching(got)).toEqual(['deploy->rs', 'hr->deploy', 'hr->svc', 'rs->pod'])
  })

  it("stops at a controller's direct children when nothing below them is rolling", () => {
    const got = flowingSources([hr, node('deploy', 'Deployment'), node('svc', 'Service'), node('rs', 'ReplicaSet'), node('pod', 'Pod')], edges)
    expect(marching(got)).toEqual(['hr->deploy', 'hr->svc'])
  })
})

describe('in-flight details', () => {
  const hr: GitOpsTreeNode = { id: 'hr', ref: { kind: 'HelmRelease', namespace: 'apps', name: 'web' }, role: 'declared', tool: 'fluxcd', sync: 'Synced', health: 'Healthy', healthSource: 'controller' }

  it('spins for a requested reconcile the controller has not picked up, and says so', () => {
    const pending = { ...hr, data: { reconcileRequested: true } }
    expect(nodeInFlight(pending)).toBe(true)
    expect(inFlightNote(pending)).toBe('Reconcile requested; waiting for the controller to pick it up')
  })

  it('spins for a workload whose Pods are still starting', () => {
    expect(nodeInFlight({ ...hr, ref: { kind: 'ReplicaSet', namespace: 'apps', name: 'web-1' }, health: 'Progressing', healthSource: 'radar', data: { starting: true } })).toBe(true)
  })

  it("quotes the controller's own message while it works", () => {
    const upgrading = { ...hr, sync: 'Reconciling' as const, health: 'Progressing' as const, data: { readyStatus: 'Unknown', readyMessage: "Running 'upgrade' action with timeout of 10m0s", reconcilingSince: '2026-11-17T21:00:00Z', timeout: '10m' } }
    expect(inFlightNote(upgrading)).toBe("Running 'upgrade' action with timeout of 10m0s")
    expect(inFlightSince(upgrading)).toBe('2026-11-17T21:00:00Z')
    expect(inFlightTimeoutMs(upgrading)).toBe(600_000)
  })

  it('reads Kubernetes durations and formats elapsed time', () => {
    expect(parseGoDuration('5m0s')).toBe(300_000)
    expect(parseGoDuration('1h30m')).toBe(5_400_000)
    expect(parseGoDuration('soon')).toBeUndefined()
    expect(formatElapsed(18_000)).toBe('18s')
    expect(formatElapsed(125_000)).toBe('2m 05s')
    expect(formatElapsed(3_840_000)).toBe('1h 04m')
  })
})

describe('treePollInterval', () => {
  const node = (extra: Partial<GitOpsTreeNode>): GitOpsTreeNode => ({ id: 'n', ref: { kind: 'HelmRelease', namespace: 'apps', name: 'web' }, role: 'declared', tool: 'fluxcd', ...extra })
  const now = Date.parse('2026-11-18T01:00:00Z')

  it('polls fast while work is fresh, and not at all once the tree settles', () => {
    expect(treePollInterval([node({ sync: 'Reconciling', data: { reconcilingSince: '2026-11-18T00:59:40Z' } })], now)).toBe(2000)
    expect(treePollInterval([node({ sync: 'Synced', health: 'Healthy', healthSource: 'controller', data: { reconcileRequested: true } })], now)).toBe(2000)
    expect(treePollInterval([node({ sync: 'Synced', health: 'Healthy', healthSource: 'controller' })], now)).toBe(false)
    expect(treePollInterval(undefined, now)).toBe(false)
  })

  it('backs off for work that has run for minutes or has no end in sight', () => {
    expect(treePollInterval([node({ sync: 'Reconciling', data: { reconcilingSince: '2026-11-17T22:00:00Z' } })], now)).toBe(10_000)
    expect(treePollInterval([node({ tool: 'argocd', ref: { kind: 'Service', namespace: 'apps', name: 'lb' }, health: 'Progressing', healthSource: 'controller' })], now)).toBe(10_000)
  })

  // Nothing says when such work began, so nothing says when it stops being
  // fresh: a rollout of a StatefulSet can run for an hour, and a Flux spec a
  // dead controller never picks up reads as Reconciling for as long as the
  // controller stays down.
  it('backs off for work whose start the tree does not carry', () => {
    expect(treePollInterval([node({ data: { rollout: { phase: 'progressing', active: true } } })], now)).toBe(10_000)
    expect(treePollInterval([node({ data: { starting: true } })], now)).toBe(10_000)
    expect(treePollInterval([node({ sync: 'Reconciling', health: 'Progressing', healthSource: 'controller' })], now)).toBe(10_000)
  })
})

describe("a custom resource's own progress", () => {
  const issuing = node({
    ref: { group: 'cert-manager.io', kind: 'Certificate', name: 'web', namespace: 'apps' },
    health: 'Progressing',
    healthSource: 'radar',
    data: { inProgress: 'reconciling', inProgressSince: '2026-11-18T10:00:00Z', inProgressMessage: 'Issuing certificate as Secret does not exist' },
  })

  it('spins for a resource whose controller says it is still working, in its words and from its clock', () => {
    expect(inFlightKind(issuing)).toBe('pass')
    expect(inFlightSince(issuing)).toBe('2026-11-18T10:00:00Z')
    expect(inFlightNote(issuing)).toBe('Issuing certificate as Secret does not exist')
  })

  it('still does not spin for a Progressing that is only Radar counting replicas', () => {
    expect(inFlightKind(node({ health: 'Progressing', healthSource: 'radar' }))).toBeUndefined()
  })

  it('polls fast while that work is fresh and backs off once it has run for minutes', () => {
    const started = Date.parse('2026-11-18T10:00:00Z')
    expect(treePollInterval([issuing], started + 30_000)).toBe(2000)
    expect(treePollInterval([issuing], started + 6 * 60_000)).toBe(10_000)
  })
})

describe('nodeAwaiting', () => {
  const parked = node({
    ref: { group: 'argoproj.io', kind: 'Rollout', name: 'web', namespace: 'apps' },
    data: {
      awaiting: { label: 'Waiting for promotion', detail: 'Step 2 (Pause: until promoted) · 1/4 updated' },
      rollout: { phase: 'paused', active: true, manual: true, label: 'Waiting for promotion' },
    },
  })

  it('marks a rollout parked until someone promotes it, and never spins for it', () => {
    expect(nodeAwaiting(parked)).toEqual({ label: 'Waiting for promotion', detail: 'Step 2 (Pause: until promoted) · 1/4 updated' })
    expect(nodeInFlight(parked)).toBe(false)
    expect(treePollInterval([parked], Date.now())).toBe(false)
  })

  it('yields to work in flight: a node its controller is changing is not waiting on anyone', () => {
    expect(nodeAwaiting(node({ data: { ...parked.data, rollout: { phase: 'progressing', active: true } } }))).toBeUndefined()
  })

  it('is never a node that is gone, going, or a group', () => {
    expect(nodeAwaiting({ ...parked, missing: true })).toBeUndefined()
    expect(nodeAwaiting(node({ data: { ...parked.data, deletionTimestamp: '2026-11-18T10:00:00Z' } }))).toBeUndefined()
    expect(nodeAwaiting({ ...parked, role: 'group' })).toBeUndefined()
    expect(nodeAwaiting(node())).toBeUndefined()
  })

  it("is the request, not work, when a controller calls the gate itself Progressing", () => {
    // Argo CD reads a Flagger Canary on its confirmation gate as Progressing.
    const gate = node({
      ref: { group: 'flagger.app', kind: 'Canary', name: 'web', namespace: 'apps' },
      tool: 'argocd',
      health: 'Progressing',
      healthSource: 'controller',
      data: { awaiting: { label: 'Waiting for promotion', detail: 'Flagger is waiting for a confirmation hook to approve' } },
    })
    expect(nodeInFlight(gate)).toBe(false)
    expect(nodeAwaiting(gate)?.label).toBe('Waiting for promotion')
    expect(treePollInterval([gate], Date.now())).toBe(false)
  })
})

describe('treeMotion', () => {
  it('keeps full motion on a tree with a few changes in flight', () => {
    expect(treeMotion(0, 0, 30)).toBe('full')
    expect(treeMotion(1, 25, 30)).toBe('full')
    expect(treeMotion(TREE_MOTION_BUDGET.cards, 36, 300)).toBe('full')
  })

  it('goes calm when more cards are at work than a picture can carry', () => {
    expect(treeMotion(TREE_MOTION_BUDGET.cards + 1, 0, 30)).toBe('calm')
  })

  it('goes calm when the marching edges are too many for the size of the tree', () => {
    // The same pass over a hundred children is affordable on a small tree and
    // not on one several times its size.
    expect(treeMotion(1, 100, 101)).toBe('full')
    expect(treeMotion(1, 100, 400)).toBe('calm')
    // On a very large tree a handful of marching edges is already the limit.
    expect(treeMotion(4, 12, 1600)).toBe('full')
    expect(treeMotion(6, 18, 1600)).toBe('calm')
  })
})

describe('nodeRolloutHold', () => {
  const timedPause = node({
    ref: { group: 'argoproj.io', kind: 'Rollout', name: 'web', namespace: 'apps' },
    data: { rollout: { phase: 'paused', active: true, manual: false, label: 'Rollout paused', detail: 'Step 4 (Pause: 30s) · 2/4 updated' } },
  })

  it('says a rollout is standing still between two steps, so the card never reads as settled', () => {
    expect(nodeRolloutHold(timedPause)).toEqual({ label: 'Rollout paused', detail: 'Step 4 (Pause: 30s) · 2/4 updated', phase: 'paused' })
    expect(nodeInFlight(timedPause)).toBe(false)
    expect(nodeAwaiting(timedPause)).toBeUndefined()
  })

  it('does not poll for it: the change that ends the hold reaches the page as a cluster change', () => {
    expect(treePollInterval([timedPause], Date.now())).toBe(false)
  })

  it('is not a rollout that is moving, one waiting to be promoted, or a settled workload', () => {
    expect(nodeRolloutHold(node({ data: { rollout: { phase: 'progressing', active: true, label: 'Rolling out' } } }))).toBeUndefined()
    expect(nodeRolloutHold(node({ data: { awaiting: { label: 'Waiting for promotion' }, rollout: { phase: 'paused', active: true, manual: true, label: 'Waiting for promotion' } } }))).toBeUndefined()
    expect(nodeRolloutHold(node({ data: { rollout: { phase: 'idle', active: false, label: 'Stable' } } }))).toBeUndefined()
    expect(nodeRolloutHold(node())).toBeUndefined()
  })
})

describe('buildFlowGraph motion budget', () => {
  // A root with n Deployments under it, the first `rolling` of them mid-rollout.
  function tree(n: number, rolling: number) {
    const nodes: GitOpsTreeNode[] = [{ id: 'root', ref: { kind: 'Kustomization', name: 'apps', namespace: 'flux-system' }, role: 'root', tool: 'fluxcd', sync: 'Synced', health: 'Healthy' }]
    const edges: { source: string; target: string; type: 'owns' }[] = []
    for (let i = 0; i < n; i++) {
      nodes.push({
        id: `d${i}`,
        ref: { group: 'apps', kind: 'Deployment', name: `web-${i}`, namespace: 'apps' },
        role: 'declared',
        tool: 'fluxcd',
        health: 'Healthy',
        data: i < rolling ? { rollout: { phase: 'progressing', active: true, manual: false, label: 'Rolling out' } } : {},
      })
      edges.push({ source: 'root', target: `d${i}`, type: 'owns' })
    }
    return { root: nodes[0].ref, nodes, edges } as never
  }

  it('marches the edges of a few changes in flight', () => {
    const graph = buildFlowGraph(tree(4, 2), 'full', '')
    expect(graph.calm).toBe(false)
    expect(graph.nodes.every((n) => n.data.calm === false)).toBe(true)
  })

  it('goes calm past the budget: cards are told, edges keep their dashes and stop', () => {
    const graph = buildFlowGraph(tree(20, TREE_MOTION_BUDGET.cards + 1), 'full', '')
    expect(graph.calm).toBe(true)
    expect(graph.nodes.every((n) => n.data.calm === true)).toBe(true)
    expect(graph.edges.some((e) => e.animated)).toBe(false)
  })
})
