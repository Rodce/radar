import type { GitOpsResourceTree, GitOpsTreeNode } from '../types'
import { awaitingAction, rolloutHold, type AwaitingAction, type RolloutHold } from './awaiting-action'
import { parseGoDuration } from './format'
import { rolloutIsMoving } from './workload-rollout'

// Work in flight on a GitOps resource tree: which nodes have a controller at
// work right now, why, since when, and how often that is worth re-reading.
// One set of rules for the graph, the page header and the API client's poll.

// isNodeTerminating returns true when the backend tagged the node with
// metadata.deletionTimestamp (see enrichNodeFromObject in pkg/gitops/tree).
// The check tolerates older payloads that don't carry the field — they
// simply read as not-terminating, which is the safe default.
export function isNodeTerminating(node: GitOpsTreeNode): boolean {
  return Boolean(node.data?.deletionTimestamp)
}

// rolloutInFlight is the rule every rollout spinner turns on
// (rolloutIsMoving): applying or progressing, never waiting, paused or stalled.
function rolloutInFlight(node: GitOpsTreeNode): boolean {
  return rolloutIsMoving(node.data?.rollout as Parameters<typeof rolloutIsMoving>[0])
}

// Why a node reads as work in flight. 'progressing' is a controller's bare
// Progressing verdict, the one kind with no end in sight: Argo CD holds a
// Service waiting for a load balancer there indefinitely.
export type InFlightKind = 'pass' | 'requested' | 'rollout' | 'starting' | 'progressing'

// inFlightKind says whether a node's controller has work running now, and
// which: a controller's own pass (the GitOps controller's, or any custom
// resource's whose controller says it is still working: a certificate being
// issued, a Crossplane resource being created), a reconcile requested and not
// yet picked up, a workload controller's rollout, or a workload whose Pods are
// still starting. Radar's replica count never counts on its own:
// "Progressing" at 2 of 3 ready fits a crashloop as well as a rollout, and a
// spinner on a stall would claim progress that isn't happening. A paused node
// and one being deleted are never in flight.
export function inFlightKind(node: GitOpsTreeNode): InFlightKind | undefined {
  if (node.role === 'group' || node.missing || isNodeTerminating(node) || node.health === 'Suspended') return undefined
  if (node.sync === 'Reconciling' || node.data?.reconciling === true || node.data?.operationInProgress === true) return 'pass'
  // Requested and not yet handled: the moment after a Reconcile click, or a
  // controller working through a queue.
  if (node.data?.reconcileRequested === true || node.data?.inProgress === 'requested') return 'requested'
  if (typeof node.data?.inProgress === 'string') return 'pass'
  if (rolloutInFlight(node)) return 'rollout'
  if (node.data?.starting === true) return 'starting'
  // A node parked until a person acts is not at work, whatever its controller
  // calls it: Argo CD reads a Flagger Canary on its confirmation gate as
  // Progressing, and that gate is the request, not the work.
  if (awaitingAction(node.data)) return undefined
  // The root's health is always its controller's (the backend reads it from
  // the Application or the Flux conditions), with or without a stated source.
  const controllerVerdict = node.role === 'root' || node.healthSource === 'controller' || node.healthSource === 'controllerApi'
  return node.health === 'Progressing' && controllerVerdict ? 'progressing' : undefined
}

// nodeInFlight is the rule every in-flight affordance on the tree turns on.
export function nodeInFlight(node: GitOpsTreeNode): boolean {
  return inFlightKind(node) !== undefined
}

// inFlightNodeIDs is the set nodeInFlight reports, for the counts that follow
// it.
export function inFlightNodeIDs(nodes: GitOpsTreeNode[]): Set<string> {
  return new Set(nodes.filter(nodeInFlight).map(node => node.id))
}

// nodeAwaiting says what a node is waiting on a person for, if anything: a
// rollout parked until it is promoted. Never while its controller is at work,
// and never on a node that is gone or going.
export function nodeAwaiting(node: GitOpsTreeNode): AwaitingAction | undefined {
  if (node.role === 'group' || node.missing || isNodeTerminating(node) || nodeInFlight(node)) return undefined
  return awaitingAction(node.data)
}

// nodeRolloutHold says a node's rollout is under way but neither moving nor
// waiting to be promoted (rolloutHold): the stretch of a canary between two
// steps, which would otherwise look like a settled workload.
export function nodeRolloutHold(node: GitOpsTreeNode): RolloutHold | undefined {
  if (node.role === 'group' || node.missing || isNodeTerminating(node) || nodeInFlight(node)) return undefined
  return rolloutHold(node.data)
}

// flowingSources is the set of nodes whose outgoing edges march. Every node
// with work in flight; and below a workload mid-rollout, the whole chain it
// owns, since the rollout runs through all of it: the new ReplicaSet brings up
// its Pods while the old one winds its own down. A GitOps controller's pass
// reaches only its direct children: it applies them, and a child that isn't
// rolling has nothing moving beneath it.
export function flowingSources(nodes: GitOpsTreeNode[], edges: GitOpsResourceTree['edges']): Set<string> {
  const sources = inFlightNodeIDs(nodes)
  const queue = nodes.filter(node => !node.missing && !isNodeTerminating(node) && rolloutInFlight(node)).map(node => node.id)
  if (queue.length === 0) return sources
  const owned = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.type !== 'owns') continue
    const targets = owned.get(edge.source)
    if (targets) targets.push(edge.target)
    else owned.set(edge.source, [edge.target])
  }
  while (queue.length > 0) {
    for (const target of owned.get(queue.pop()!) ?? []) {
      if (sources.has(target)) continue
      sources.add(target)
      queue.push(target)
    }
  }
  return sources
}

// The motion a tree can afford. A card with work in flight pings its dot,
// sweeps a light across its subtitle and runs a bar along its edge, and every
// edge out of it marches. Marching dashes are what a large tree cannot afford:
// each one repaints on every frame, at a cost that grows with everything else
// on the canvas, so a root with a few hundred children mid-pass can take the
// page from 60 frames a second to a handful. Animated cards never cost frames,
// only processor time, and past a dozen of them the picture is too busy to
// read. Beyond either budget the tree goes calm: each card keeps its spinner
// and its timer (ticking every five seconds rather than every second), which
// still say which nodes are at work, and the edges keep their dashes but hold
// still. The topology graph puts a limit of the same
// kind on its animated edges (EDGE_ANIMATION_THRESHOLD).
//
// edgeLoad is marching edges times nodes on the canvas. Measured on trees of
// 160 to 1,600 nodes, frames start to drop near 50,000; the budget is half of
// that, for machines slower than the one it was measured on.
export const TREE_MOTION_BUDGET = { cards: 12, edgeLoad: 25_000 }

export type TreeMotion = 'full' | 'calm'

// treeMotion picks the mode from what is on the canvas: the cards with work
// in flight, the edges that would march, and how many nodes they are drawn
// among.
export function treeMotion(inFlightCards: number, marchingEdges: number, shownNodes: number): TreeMotion {
  return inFlightCards > TREE_MOTION_BUDGET.cards || marchingEdges * shownNodes > TREE_MOTION_BUDGET.edgeLoad ? 'calm' : 'full'
}

const TREE_IN_FLIGHT_POLL_MS = 2000
const TREE_LONG_RUNNING_POLL_MS = 10_000
const IN_FLIGHT_FRESH_MS = 5 * 60_000

// treePollInterval is how often a tree with work in flight is worth
// re-reading; false when nothing is. Fast while the work is fresh: the end of
// a pass is the moment worth seeing, and SSE batches land up to 3s late. Slow
// once it has run for minutes, or when all that is left is a controller's
// bare Progressing: a release retrying for hours or a Service Argo CD waits on
// forever must not hold a page at two-second polling for as long as it is
// open. So is work whose start the tree does not carry (a workload's rollout,
// Pods starting, a Flux spec its controller has not picked up, which a dead
// controller never does): fresh it may be, but nothing says when it stops
// being so. A requested reconcile is the exception: it is the moment after a
// click, and the backend stops calling it requested after ten minutes. A node
// that stands still is not polled at all, whether it waits on a person or
// holds between two rollout steps: the page re-reads the tree on every batch
// of cluster changes anyway, and the change that ends the wait is one.
export function treePollInterval(nodes: GitOpsTreeNode[] | undefined, now: number): number | false {
  let longRunning = false
  for (const node of nodes ?? []) {
    const kind = inFlightKind(node)
    if (!kind) continue
    const since = inFlightSince(node)
    const fresh = kind === 'requested' || (kind !== 'progressing' && since !== undefined && now - Date.parse(since) <= IN_FLIGHT_FRESH_MS)
    if (!fresh) {
      longRunning = true
      continue
    }
    return TREE_IN_FLIGHT_POLL_MS
  }
  return longRunning ? TREE_LONG_RUNNING_POLL_MS : false
}

// inFlightSince is when the work on a node began, by the controller's own
// clock: Flux's Reconciling transition, Argo's operation start, or the
// transition of the condition a custom resource's controller reports it by.
export function inFlightSince(node: GitOpsTreeNode): string | undefined {
  return text(node.data?.reconcilingSince) || text(node.data?.operationStartedAt) || text(node.data?.inProgressSince) || undefined
}

// inFlightTimeoutMs is the time a Flux Kustomization or HelmRelease gives a
// pass before calling it failed (spec.timeout).
export function inFlightTimeoutMs(node: GitOpsTreeNode): number | undefined {
  return parseGoDuration(text(node.data?.timeout))
}

// inFlightNote is what the controller says it is doing, for the hover.
export function inFlightNote(node: GitOpsTreeNode): string {
  const parts: string[] = []
  const working = node.sync === 'Reconciling' || node.data?.reconciling === true || node.data?.operationInProgress === true
  if (node.data?.reconcileRequested === true && !working) parts.push('Reconcile requested; waiting for the controller to pick it up')
  const message = text(node.data?.operationMessage) || (node.data?.readyStatus !== 'True' ? text(node.data?.readyMessage) : '') || text(node.data?.inProgressMessage)
  if (message) parts.push(message)
  const rollout = node.data?.rollout as { label?: string; detail?: string } | undefined
  if (rollout?.label) parts.push(rollout.detail ? `${rollout.label}: ${rollout.detail}` : rollout.label)
  if (node.data?.starting === true) parts.push('Its Pods are still starting')
  return parts.join(' · ')
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
