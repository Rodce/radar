import type { TopologyEdge, TopologyNode } from '../../types'
import { awaitingAction, rolloutHold, type AwaitingAction, type RolloutHold } from '../../utils/awaiting-action'
import { foldHash } from '../../utils/structure-hash'
import { rolloutIsMoving } from '../../utils/workload-rollout'

// Change in flight on the topology graph: the same rules the GitOps tree and
// the workload page spin for, read from the node data the backend sets
// (rollout, starting, inProgress). Lives apart from the graph so it can be
// tested and shared.

type NodeData = Record<string, unknown> | undefined

function rolling(data: NodeData): boolean {
  return rolloutIsMoving(data?.rollout as Parameters<typeof rolloutIsMoving>[0])
}

// inProgressUntil is when the backend's reading of a controller still at work
// lapses (pkg/topology AnnotateResourceProgress); undefined when it sets none.
// The graph is rebuilt only when something in the cluster changes, so on a
// quiet cluster the frontend lets the reading go on time itself.
export function inProgressUntil(data: NodeData): number | undefined {
  const until = typeof data?.inProgressUntil === 'string' ? Date.parse(data.inProgressUntil) : NaN
  return Number.isFinite(until) ? until : undefined
}

function working(data: NodeData, now: number): boolean {
  if (typeof data?.inProgress !== 'string') return false
  const until = inProgressUntil(data)
  return until === undefined || now < until
}

// topologyNodeChanging reports a node whose controller is changing it now: a
// workload rollout applying or progressing, a workload whose Pods are still
// starting, a GitOps object with a pass in flight or a reconcile requested, or
// a custom resource whose controller says it is still working (a certificate
// being issued, a Crossplane resource being created), until that reading
// lapses.
export function topologyNodeChanging(data: NodeData, now: number = Date.now()): boolean {
  if (!data) return false
  return data.starting === true || working(data, now) || rolling(data)
}

// topologyNodeAwaiting says what a node is waiting on a person for, if
// anything: a rollout parked until it is promoted. Never while its controller
// is at work.
export function topologyNodeAwaiting(data: NodeData, now: number = Date.now()): AwaitingAction | undefined {
  return topologyNodeChanging(data, now) ? undefined : awaitingAction(data)
}

// topologyNodeHold says a node's rollout is under way but neither moving nor
// waiting to be promoted (rolloutHold): a canary on a timed pause, a workload
// someone paused mid-rollout.
export function topologyNodeHold(data: NodeData, now: number = Date.now()): RolloutHold | undefined {
  return topologyNodeChanging(data, now) ? undefined : rolloutHold(data)
}

// nextChangeDeadline is the earliest moment, after now, at which a node's
// in-progress reading lapses: when the graph has to look again without being
// told.
export function nextChangeDeadline(nodes: TopologyNode[], now: number): number | undefined {
  let next: number | undefined
  for (const node of nodes) {
    const data = node.data as NodeData
    if (typeof data?.inProgress !== 'string') continue
    const until = inProgressUntil(data)
    if (until !== undefined && until > now && (next === undefined || until < next)) next = until
  }
  return next
}

// changingSources is the set of nodes whose outgoing "manages" edges carry a
// change: every changing node, and below a workload mid-rollout the whole
// chain it manages (ReplicaSets, Pods), since the rollout runs through all of
// it.
export function changingSources(nodes: TopologyNode[], edges: TopologyEdge[], now: number = Date.now()): Set<string> {
  const sources = new Set<string>()
  const queue: string[] = []
  for (const node of nodes) {
    const data = node.data as NodeData
    if (!topologyNodeChanging(data, now)) continue
    sources.add(node.id)
    if (rolling(data)) queue.push(node.id)
  }
  if (queue.length === 0) return sources
  const managed = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.type !== 'manages') continue
    const targets = managed.get(edge.source)
    if (targets) targets.push(edge.target)
    else managed.set(edge.source, [edge.target])
  }
  while (queue.length > 0) {
    for (const target of managed.get(queue.pop()!) ?? []) {
      if (sources.has(target)) continue
      sources.add(target)
      queue.push(target)
    }
  }
  return sources
}

// topologyChangeKey changes exactly when the answer of changingSources can
// change without the graph's structure changing: which nodes are changing, and
// which of those are rolling. Empty while nothing is.
export function topologyChangeKey(nodes: TopologyNode[], now: number = Date.now()): string {
  const changing = nodes.filter((node) => topologyNodeChanging(node.data as NodeData, now))
  if (changing.length === 0) return ''
  return `${changing.length}:${foldHash(changing, (node) => `${node.id}:${rolling(node.data as NodeData) ? 'r' : ''}`)}`
}
