import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AlertTriangle, ChevronRight, Clock3, Hand, Loader2, Maximize, Pause, Search, X } from 'lucide-react'
import { PaneLoader } from '../../ui/PaneLoader'
import { Input } from '../../ui/Input'
import { clsx } from 'clsx'

import type { GitOpsIssue, GitOpsResourceTree, GitOpsTreeNode, GitOpsTreeRef, HealthStatus } from '../../../types'
import { displayKind } from '../../../types'
import { healthToSeverity, SEVERITY_DOT, SEVERITY_TEXT } from '../../../utils/badge-colors'
import { formatCompactAge, formatElapsed } from '../../../utils/format'
import { awaitingNote, rolloutStall, type AwaitingAction } from '../../../utils/awaiting-action'
import { radarHealthNote } from '../health-provenance'
import { useNow } from '../../../hooks/useNow'
import { servicePortsTooltip, type ServicePortEntry } from '../../topology/K8sResourceNode'
import { getTopologyIcon } from '../../../utils/resource-icons'
import { Tooltip } from '../../ui/Tooltip'
import {
  flowingSources,
  hasGitOpsTreeFilters,
  inFlightNote,
  inFlightSince,
  inFlightTimeoutMs,
  isNodeTerminating,
  matchesGitOpsTreeFilters,
  nodeAwaiting,
  nodeInFlight,
  nodeRolloutHold,
  treeMotion,
  treeNodeHealth,
  type GitOpsTreeFilters,
} from './tree-helpers'
export { flowingSources, inFlightNodeIDs, nodeInFlight } from './tree-helpers'
import { rankTree, renderedEdge, shortcutEdges, upstreamClosure, upstreamEdges } from './layout'

export type GitOpsTreePreset = 'full' | 'compact' | 'workloads' | 'app'

const RANK_GAP = 390
const ROW_GAP = 118
const NODE_WIDTH = 320
const NODE_HEIGHT = 84
const GROUP_WIDTH = 230
const GROUP_HEIGHT = 64
const ROOT_Y_OFFSET = 28

const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Rollout', 'Job', 'CronJob'])
const WORKLOAD_CHILD_KINDS = new Set(['ReplicaSet', 'Pod', 'PodGroup'])
const COMPACT_INFRA_KINDS = new Set([
  'AppProject',
  'ClusterRole',
  'ClusterRoleBinding',
  'ConfigMap',
  'CustomResourceDefinition',
  'Role',
  'RoleBinding',
  'Secret',
  'SealedSecret',
  'ServiceAccount',
])

interface GitOpsTreeGraphProps {
  tree: GitOpsResourceTree | null
  loading?: boolean
  error?: Error | null
  onNodeClick?: (ref: GitOpsTreeRef, node: GitOpsTreeNode) => void
  preset?: GitOpsTreePreset
  onPresetChange?: (preset: GitOpsTreePreset) => void
  query?: string
  onQueryChange?: (query: string) => void
  filters?: GitOpsTreeFilters
  showToolbar?: boolean
  // Root-cause issues from the same detail page's insights fetch (already
  // loaded alongside the tree — no extra request). Matched onto tree nodes
  // by ref so an unhealthy node's hover reveals WHY, not just THAT.
  issues?: GitOpsIssue[]
  // What the host can do for a node that waits on a person (nodeAwaiting): a
  // Promote button for an Argo Rollout. Rendered on the card, beside the words
  // that say what is being waited for. Without it the card only says so.
  renderAwaitingAction?: (node: GitOpsTreeNode, awaiting: AwaitingAction) => ReactNode
}

// React Flow builds the cards itself, so the host's renderer reaches them
// through context instead of through each node's data.
const AwaitingActionContext = createContext<GitOpsTreeGraphProps['renderAwaitingAction']>(undefined)

// refKey builds a stable lookup key from either a tree ref or an insight
// ref. Namespace is omitted for cluster-scoped resources on both sides, so
// normalize the missing case the same way instead of using `undefined` vs
// `''` as accidentally distinct keys. Group is included for the same
// reason CLAUDE.md calls out elsewhere (Knative Service vs core Service,
// CNPG Cluster vs CAPI Cluster) — kind+namespace+name alone collides across
// a real, documented class of same-plural CRDs, which would show one
// resource's cause/tooltip on a completely unrelated node.
function refKey(ref: { group?: string; kind: string; namespace?: string; name: string }): string {
  return `${ref.group ?? ''}/${ref.kind}/${ref.namespace ?? ''}/${ref.name}`
}

export function GitOpsTreeGraph(props: GitOpsTreeGraphProps) {
  return (
    <ReactFlowProvider>
      <GitOpsTreeGraphInner {...props} />
    </ReactFlowProvider>
  )
}

function GitOpsTreeGraphInner({
  tree,
  loading = false,
  error = null,
  onNodeClick,
  preset: controlledPreset,
  onPresetChange,
  query: controlledQuery,
  onQueryChange,
  filters,
  showToolbar = true,
  issues,
  renderAwaitingAction,
}: GitOpsTreeGraphProps) {
  const [internalPreset, setInternalPreset] = useState<GitOpsTreePreset>('compact')
  const [internalQuery, setInternalQuery] = useState('')
  const preset = controlledPreset ?? internalPreset
  const query = controlledQuery ?? internalQuery
  const setPreset = onPresetChange ?? setInternalPreset
  const setQuery = onQueryChange ?? setInternalQuery
  const reactFlow = useReactFlow()
  // Per-group expand state (keyed by group node ID, e.g. "<parent>/compact/<kind>").
  // When a group ID is in this set, compactInfra leaves the children visible
  // instead of collapsing them into a single "N <kind>s" node. Collapses
  // back to the default when the user toggles off or switches preset.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  // Reset expansion when leaving compact preset — there are no groups to
  // expand in 'full', and stale state would surprise the user when they
  // toggle back.
  useEffect(() => {
    if (preset !== 'compact') setExpandedGroups(new Set())
  }, [preset])
  const causeByRef = useMemo(() => buildCauseByRef(issues), [issues])
  const { nodes, edges, calm } = useMemo(() => buildFlowGraph(tree, preset, query, filters, expandedGroups, causeByRef), [tree, preset, query, filters, expandedGroups, causeByRef])

  useEffect(() => {
    if (nodes.length === 0) return
    const id = window.setTimeout(() => reactFlow.fitView({ padding: 0.18, maxZoom: 1.15, duration: 180 }), 0)
    return () => window.clearTimeout(id)
  }, [nodes.length, edges.length, preset, query, reactFlow])

  const handleNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    const gitOpsNode = node.data.node as GitOpsTreeNode | undefined
    if (!gitOpsNode) return
    if (gitOpsNode.role === 'group') {
      // Toggle expand/collapse for this group. Re-render replaces the
      // synthetic group node with the original children (or vice versa).
      setExpandedGroups((prev) => {
        const next = new Set(prev)
        if (next.has(gitOpsNode.id)) next.delete(gitOpsNode.id)
        else next.add(gitOpsNode.id)
        return next
      })
      return
    }
    onNodeClick?.(gitOpsNode.ref, gitOpsNode)
  }, [onNodeClick])

  if (loading) {
    return <PaneLoader label="Loading GitOps resource tree…" className="h-full" />
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-red-500">
        <AlertTriangle className="mr-2 h-4 w-4" />
        Failed to load GitOps tree: {error.message}
      </div>
    )
  }

  if (!tree || nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-theme-text-secondary">
        No managed resources found for this GitOps object.
      </div>
    )
  }

  return (
    <div className="relative h-full min-h-0 min-w-0">
      {showToolbar && (
        <GitOpsTreeToolbar
          preset={preset}
          onPresetChange={setPreset}
          query={query}
          onQueryChange={setQuery}
          onFit={() => reactFlow.fitView({ padding: 0.18, maxZoom: 1.15, duration: 180 })}
        />
      )}
      <AwaitingActionContext.Provider value={renderAwaitingAction}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1.15 }}
        minZoom={0.15}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        className="bg-theme-base"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          className="opacity-40"
        />
        <Controls
          className="!border-theme-border !bg-theme-surface"
          showInteractive={false}
        />
      </ReactFlow>
      </AwaitingActionContext.Provider>
      <EdgeLegend edges={edges} calm={calm} />
    </div>
  )
}

// EdgeLegend documents the color encoding on the GitOps tree graph. Only
// renders rows for edge types actually present in the current view —
// hides the legend entirely when the graph has only `owns` edges (the
// default for Argo apps without dependencies).
function EdgeLegend({ edges, calm }: { edges: Edge[]; calm: boolean }) {
  const types = new Set(edges.map((e) => e.data?.type as string).filter(Boolean))
  const rows: Array<{ key: string; color: string; label: string; dashed?: boolean }> = []
  if (types.has('source')) rows.push({ key: 'source', color: getEdgeColor('source'), label: 'Source artifact' })
  if (types.has('dependsOn')) rows.push({ key: 'dependsOn', color: getEdgeColor('dependsOn'), label: 'Depends on' })
  // Past the motion budget the dashes hold still; the legend says why, so a
  // still tree is not read as an idle one.
  if (edges.some((e) => e.data?.flowing)) rows.push({ key: 'flowing', color: getEdgeColor('owns'), label: calm ? 'Change in progress (many at once: motion reduced)' : 'Change in progress', dashed: true })
  // Always show the default ownership color when there are 2+ edge kinds —
  // operators need to compare against it. Hide when "owns" is the only kind.
  if (rows.length > 0) rows.unshift({ key: 'owns', color: getEdgeColor('owns'), label: 'Ownership' })
  if (rows.length === 0) return null
  return (
    <div className="absolute bottom-4 left-4 z-10 rounded-md border border-theme-border bg-theme-surface/90 px-2.5 py-1.5 text-[10px] backdrop-blur">
      <div className="mb-1 font-medium uppercase tracking-wide text-theme-text-tertiary">Edges</div>
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center gap-2 text-theme-text-secondary">
            {row.dashed
              ? <span className="inline-block w-5 border-t-2 border-dashed" style={{ borderColor: row.color }} />
              : <span className="inline-block h-[2px] w-5 rounded" style={{ backgroundColor: row.color }} />}
            {row.label}
          </div>
        ))}
      </div>
    </div>
  )
}

function GitOpsTreeToolbar({
  preset,
  onPresetChange,
  query,
  onQueryChange,
  onFit,
}: {
  preset: GitOpsTreePreset
  onPresetChange: (preset: GitOpsTreePreset) => void
  query: string
  onQueryChange: (query: string) => void
  onFit: () => void
}) {
  return (
    <div className="absolute right-4 top-4 z-10 flex flex-wrap items-center justify-end gap-2">
      <div className="flex items-center gap-1 rounded-lg border border-theme-border bg-theme-surface/90 p-1 backdrop-blur">
        {(['compact', 'workloads', 'app', 'full'] as const).map(value => (
          <button
            key={value}
            type="button"
            onClick={() => onPresetChange(value)}
            className={clsx(
              'rounded-md px-2.5 py-1 text-xs transition-colors',
              preset === value
                ? 'bg-skyhook-600 text-white'
                : 'text-theme-text-secondary hover:bg-theme-elevated hover:text-theme-text-primary'
            )}
          >
            {getPresetLabel(value)}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1 rounded-lg border border-theme-border bg-theme-surface/90 px-2 py-1.5 backdrop-blur">
        <Search className="h-3.5 w-3.5 text-theme-text-tertiary" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Find node..."
          className="w-36 bg-transparent text-xs text-theme-text-primary outline-none placeholder:text-theme-text-tertiary"
        />
        {query && (
          <button type="button" onClick={() => onQueryChange('')} className="text-theme-text-tertiary hover:text-theme-text-primary">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <Tooltip content="Fit tree" delay={120}>
        <button
          type="button"
          onClick={onFit}
          className="flex items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface/90 px-2.5 py-1.5 text-xs text-theme-text-secondary backdrop-blur transition-colors hover:text-theme-text-primary"
        >
          <Maximize className="h-3.5 w-3.5" />
          Fit
        </button>
      </Tooltip>
    </div>
  )
}

function getPresetLabel(preset: GitOpsTreePreset): string {
  switch (preset) {
    case 'compact': return 'Compact'
    case 'workloads': return 'Workloads'
    case 'app': return 'Declared'
    case 'full': return 'Full'
  }
}

function getEdgeColor(type: string): string {
  switch (type) {
    case 'source': return '#0ea5e9'
    case 'dependsOn': return '#f59e0b'
    default: return '#64748b'
  }
}

export function buildFlowGraph(tree: GitOpsResourceTree | null, preset: GitOpsTreePreset, query: string, filters?: GitOpsTreeFilters, expandedGroups?: Set<string>, causeByRef?: Map<string, NodeCause>): { nodes: Node[]; edges: Edge[]; calm: boolean } {
  if (!tree) return { nodes: [], edges: [], calm: false }
  const visibleTree = applyGraphFilters(applyPreset(tree, preset, expandedGroups), filters)
  const byID = new Map(visibleTree.nodes.map(node => [node.id, node]))
  const ranks = groupRanks(rankTree(visibleTree), byID)
  const positioned = positionRanks(ranks, byID)
  const upstreamTargets = new Set(upstreamEdges(visibleTree).map(edge => edge.target))
  const shortcuts = shortcutEdges(visibleTree)
  const normalizedQuery = query.trim().toLowerCase()
  const flowing = flowingSources(visibleTree.nodes, visibleTree.edges)
  const shownEdges = visibleTree.edges.filter(edge => positioned.has(edge.source) && positioned.has(edge.target) && !shortcuts.has(edge))
  // Edges out of a node with work in flight march toward what it is applying
  // or rolling: the change's direction at a glance. Upstream edges (sources,
  // dependsOn) stay still: nothing flows back up them.
  const marches = (edge: GitOpsResourceTree['edges'][number]) => flowing.has(edge.source) && !upstreamTargets.has(edge.target)
  const inFlightCards = Array.from(positioned.keys()).filter(id => nodeInFlight(byID.get(id)!)).length
  const calm = treeMotion(inFlightCards, shownEdges.filter(marches).length, positioned.size) === 'calm'
  const nodes = Array.from(positioned.entries()).map(([id, position]) => {
    const node = byID.get(id)!
    return {
      id,
      type: 'gitopsResource',
      position,
      data: {
        node,
        highlighted: normalizedQuery !== '' && matchesQuery(node, normalizedQuery),
        cause: causeByRef?.get(refKey(node.ref)),
        calm,
      },
    }
  })

  const edges = shownEdges
    .map(edge => {
      // Marching edges keep their own colour, since sky and amber already
      // mean source and dependsOn here; motion and weight carry the state.
      // Past the motion budget they keep the dashes and the weight and hold
      // still.
      const marching = marches(edge)
      return {
        id: `${edge.source}->${edge.target}`,
        ...renderedEdge(edge, upstreamTargets),
        type: 'smoothstep',
        animated: marching && !calm,
        // The legend reads back edge.data?.type to decide which rows to render —
        // ReactFlow doesn't preserve our custom `type` field at the top level
        // because it overloads `type` for the edge component identity ("smoothstep").
        data: { type: edge.type, flowing: marching },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: getEdgeColor(edge.type),
        },
        style: {
          stroke: getEdgeColor(edge.type),
          strokeWidth: marching ? 2.5 : edge.type === 'owns' ? 1.5 : 1.75,
          // The dash pattern React Flow's own animation draws, without the animation.
          ...(marching && calm ? { strokeDasharray: '5' } : {}),
        },
      }
    })

  return { nodes, edges, calm }
}

function applyPreset(tree: GitOpsResourceTree, preset: GitOpsTreePreset, expandedGroups?: Set<string>): GitOpsResourceTree {
  if (preset === 'full') return tree
  if (preset === 'compact') return compactInfra(tree, expandedGroups)

  const byID = new Map(tree.nodes.map(node => [node.id, node]))
  const children = new Map<string, string[]>()
  for (const edge of tree.edges) {
    children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target])
  }

  // Dependencies answer "where does this come from" and are few, so every
  // preset keeps them.
  const keep = new Set<string>([tree.root.id, ...upstreamClosure(tree)])
  if (preset === 'app') {
    for (const edge of tree.edges) {
      if (edge.source === tree.root.id) keep.add(edge.target)
    }
  } else {
    for (const node of tree.nodes) {
      if (node.role === 'root' || WORKLOAD_KINDS.has(node.ref.kind) || WORKLOAD_CHILD_KINDS.has(node.ref.kind)) {
        keep.add(node.id)
      }
    }
    let changed = true
    while (changed) {
      changed = false
      for (const edge of tree.edges) {
        if (keep.has(edge.target) && !keep.has(edge.source)) {
          keep.add(edge.source)
          changed = true
        }
      }
    }
  }

  return {
    ...tree,
    nodes: tree.nodes.filter(node => keep.has(node.id)),
    edges: tree.edges.filter(edge => keep.has(edge.source) && keep.has(edge.target)),
    root: byID.get(tree.root.id) ?? tree.root,
  }
}

function applyGraphFilters(tree: GitOpsResourceTree, filters?: GitOpsTreeFilters): GitOpsResourceTree {
  if (!hasGitOpsTreeFilters(filters)) return tree

  const parent = new Map<string, string>()
  for (const edge of tree.edges) {
    if (!parent.has(edge.target)) parent.set(edge.target, edge.source)
  }

  const keep = new Set<string>([tree.root.id])
  for (const node of tree.nodes) {
    if (node.id === tree.root.id) continue
    if (matchesGitOpsTreeFilters(node, filters)) {
      let current: string | undefined = node.id
      while (current && !keep.has(current)) {
        keep.add(current)
        current = parent.get(current)
      }
    }
  }

  return {
    ...tree,
    nodes: tree.nodes.filter(node => keep.has(node.id)),
    edges: tree.edges.filter(edge => keep.has(edge.source) && keep.has(edge.target)),
  }
}

function compactInfra(tree: GitOpsResourceTree, expandedGroups?: Set<string>): GitOpsResourceTree {
  const children = new Map<string, string[]>()
  const parent = new Map<string, string>()
  for (const edge of tree.edges) {
    children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target])
    parent.set(edge.target, edge.source)
  }

  const groups = new Map<string, GitOpsTreeNode[]>()
  for (const node of tree.nodes) {
    if (node.id === tree.root.id || node.role === 'group' || !COMPACT_INFRA_KINDS.has(node.ref.kind)) continue
    if ((children.get(node.id) ?? []).length > 0) continue
    const p = parent.get(node.id)
    if (!p) continue
    const key = `${p}|${node.ref.kind}`
    groups.set(key, [...(groups.get(key) ?? []), node])
  }

  const remove = new Set<string>()
  const additions: GitOpsTreeNode[] = []
  const edgeAdditions: GitOpsResourceTree['edges'] = []
  for (const [key, nodes] of groups) {
    if (nodes.length < 2) continue
    const [p, kind] = key.split('|')
    const id = `${p}/compact/${kind}`
    // Per-group expand: when the user has clicked this group's bubble,
    // skip the collapse step for that group only — leave the children
    // visible alongside any other still-collapsed groups in the tree.
    if (expandedGroups?.has(id)) continue
    for (const node of nodes) remove.add(node.id)
    additions.push({
      id,
      ref: { kind, namespace: '', name: `${nodes.length} ${pluralize(kind)}` },
      role: 'group',
      tool: nodes[0].tool,
      topologyStatus: 'unknown',
      groupedNodeIDs: nodes.map(node => node.id),
      count: nodes.length,
      data: { groupedKind: kind },
    })
    edgeAdditions.push({ source: p, target: id, type: 'owns' })
  }

  if (remove.size === 0) return tree
  return {
    ...tree,
    nodes: [...tree.nodes.filter(node => !remove.has(node.id)), ...additions],
    edges: [
      ...tree.edges.filter(edge => !remove.has(edge.source) && !remove.has(edge.target)),
      ...edgeAdditions,
    ],
  }
}

function groupRanks(rankByID: Map<string, number>, nodes: Map<string, GitOpsTreeNode>): Map<number, string[]> {
  const ranks = new Map<number, string[]>()
  for (const [id, rank] of rankByID.entries()) {
    if (!nodes.has(id)) continue
    ranks.set(rank, [...(ranks.get(rank) ?? []), id])
  }
  for (const ids of ranks.values()) {
    ids.sort((a, b) => compareTreeNodes(nodes.get(a), nodes.get(b)))
  }
  return ranks
}

function positionRanks(ranks: Map<number, string[]>, nodes: Map<string, GitOpsTreeNode>): Map<string, { x: number; y: number }> {
  const positioned = new Map<string, { x: number; y: number }>()
  const sortedRanks = Array.from(ranks.keys()).sort((a, b) => a - b)

  for (const rank of sortedRanks) {
    const ids = ranks.get(rank) ?? []
    ids.forEach((id, row) => {
      positioned.set(id, { x: rank * RANK_GAP, y: row * ROW_GAP })
    })
  }

  const rootRank = ranks.get(0) ?? []
  if (rootRank.length === 1) {
    const rootID = rootRank[0]
    const rootHeight = getNodeDimensions(nodes.get(rootID)!).height
    const tallest = Math.max((ranks.get(1)?.length ?? 0), (ranks.get(-1)?.length ?? 0))
    if (tallest > 0) {
      const maxY = (tallest - 1) * ROW_GAP
      positioned.set(rootID, { x: 0, y: Math.max(0, (maxY - rootHeight) / 2 - ROOT_Y_OFFSET) })
    }
    // Dependency columns are short; center them on the root so the chain
    // reads as one line into it.
    const rootCenter = positioned.get(rootID)!.y + rootHeight / 2
    for (const rank of sortedRanks) {
      if (rank >= 0) continue
      const ids = ranks.get(rank) ?? []
      const columnCenter = ((ids.length - 1) * ROW_GAP + rootHeight) / 2
      ids.forEach((id, row) => {
        positioned.set(id, { x: rank * RANK_GAP, y: row * ROW_GAP + rootCenter - columnCenter })
      })
    }
  }

  return positioned
}

// Past the motion budget the cards' timers tick every five seconds: dozens or
// hundreds of cards re-rendering every second is the cost the budget cuts.
const CALM_CLOCK_MS = 5000

const GitOpsResourceNode = memo(function GitOpsResourceNode({ data }: NodeProps<Node<{ node: GitOpsTreeNode; highlighted?: boolean; cause?: NodeCause; calm?: boolean }>>) {
  const node = data.node
  const kind = normalizeDisplayKind(node)
  const status = nodeTone(node)
  const terminating = isNodeTerminating(node)
  const inFlight = nodeInFlight(node)
  // Past the tree's motion budget a card keeps the spinner and the timer and
  // drops the rest (treeMotion).
  const lively = inFlight && !data.calm
  // Parked until a person acts: held still and amber, the opposite of the
  // motion that marks a controller at work.
  const awaiting = nodeAwaiting(node)
  const renderAwaitingAction = useContext(AwaitingActionContext)
  const awaitingControl = awaiting && renderAwaitingAction ? renderAwaitingAction(node, awaiting) : null
  // A rollout under way and standing still between two steps: said in the
  // workload page's words, so the card does not read as settled.
  const hold = nodeRolloutHold(node)
  // A rollout that cannot go on (its new revision cannot start): the reason
  // takes the place of Radar's replica-count health word, which reads
  // "Progressing" for a crash loop as well as for a rollout.
  const stall = !inFlight && !awaiting && !terminating && !node.missing ? rolloutStall(node.data) : undefined
  const HoldIcon = hold?.phase === 'waiting' ? Clock3 : Pause
  // How long the controller has been at it, against the timeout it works to:
  // past half of it the time turns amber, the "this is taking long" a stuck
  // pass needs, before the controller itself gives up.
  const since = inFlight ? inFlightSince(node) : undefined
  const now = useNow(Boolean(since), data.calm ? CALM_CLOCK_MS : 1000)
  const elapsedMs = since ? now - Date.parse(since) : NaN
  const timeoutMs = inFlightTimeoutMs(node)
  const slow = Number.isFinite(elapsedMs) && timeoutMs !== undefined && elapsedMs > timeoutMs / 2
  const note = inFlight ? inFlightNote(node) : awaiting ? awaitingNote(awaiting) : hold ? awaitingNote(hold) : stall ? awaitingNote(stall) : ''
  const gitopsTool = gitopsToolForNode(node)
  const chips = buildChips(node)
  const dim = getNodeDimensions(node)
  const KindIcon = getTopologyIcon(kind)
  const cause = nodeCause(node, data.cause)
  // Only declared resources can carry the controller's verdict, so only
  // there does "this one is Radar's" mean anything. Generated children
  // (ReplicaSets, Pods) are always Radar's read; marking each would be
  // noise.
  const radarNote = node.role === 'declared' ? radarHealthNote(node) : ''
  // A Service's subtitle names its first port and counts the rest, so without a
  // hover the ones behind "+1 more" can't be reached from the graph at all. Same
  // affordance the topology graph's Service node carries, same renderer. Stood
  // down when the card already explains an unhealthy verdict: that reason is
  // what the hover should say, and only one tooltip is ever visible anyway.
  const portsTooltip = kind === 'Service' && !cause
    ? servicePortsTooltip((node.data?.ports as ServicePortEntry[] | undefined) ?? [])
    : null
  const subtitle = getSubtitle(node)

  const card = (
      <div
        className={clsx(
          'relative overflow-hidden rounded-lg border bg-theme-surface shadow-md transition-colors',
          data.highlighted ? 'border-skyhook-400 ring-2 ring-skyhook-400/40' : 'border-theme-border',
          // Lifecycle dominates the left-stripe color: a Terminating node
          // paints orange regardless of its frozen sync/health state. Same
          // logic as the fleet-row statusStripe — sync/health shouldn't
          // signal "fix me" when the resource is being deleted.
          terminating
            ? 'border-l-orange-500'
            : status === 'healthy' && 'border-l-green-500',
          !terminating && status === 'degraded' && 'border-l-yellow-500',
          !terminating && status === 'unhealthy' && 'border-l-red-500',
          !terminating && status === 'neutral' && 'border-l-sky-500',
          !terminating && status === 'unknown' && 'border-l-slate-500',
          // GitOps portal nodes get a slightly stronger ring so the user's
          // eye picks them out from generic K8s leaves. Combined with the
          // tool-icon overlay + "→ Open" affordance below, this signals
          // "click me to dive into this CR's own GitOps view" without
          // making the node look broken or alarming.
          gitopsTool && !data.highlighted && 'ring-1 ring-skyhook-500/30 hover:ring-skyhook-500/60',
          // Waiting on a person: an amber outline, so the one node in a tree
          // that needs someone stands out from the ones that are fine.
          awaiting && !data.highlighted && 'ring-1 ring-amber-500/70',
          gitopsTool && 'cursor-pointer',
          // Group nodes are interactive (click toggles expand) but the
          // default ReactFlow handler doesn't add a hover state. A subtle
          // border lift telegraphs "this responds to clicks" without
          // looking like a primary action.
          node.role === 'group' && 'cursor-pointer hover:border-theme-text-tertiary/50 hover:bg-theme-hover',
          // The root node is this page's own subject, so it deliberately
          // skips the portal ring/tool-badge above (clicking it can't
          // "dive into" anything — it's already the page you're on). It's
          // still clickable — opens the standard resource drawer — so it
          // gets its own quieter affordance: a hover ring, no ring at rest,
          // so it doesn't visually compete with real portal children.
          node.role === 'root' && !data.highlighted && 'cursor-pointer hover:ring-1 hover:ring-theme-text-tertiary/40',
        )}
        style={{ width: dim.width, minHeight: dim.height, borderLeftWidth: 4 }}
      >
        <div className="px-3 py-2.5">
          <div className="mb-1 flex items-center gap-1.5">
            <KindIcon className="h-3.5 w-3.5 shrink-0 text-theme-text-tertiary" aria-hidden />
            <span className="truncate text-[10px] font-medium uppercase tracking-wide text-theme-text-tertiary">
              {node.role === 'group' ? displayKind((node.data?.groupedKind as string) || kind) : displayKind(kind)}
            </span>
            {/* Tool badge for GitOps portal nodes — sits between the kind
                label and the status dot, signaling "this is a managed-
                GitOps-app, not a leaf K8s resource". Keeps the dot's
                position so non-portal nodes look unchanged. */}
            {gitopsTool && (
              <span className="rounded-sm border border-skyhook-500/30 bg-skyhook-500/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-skyhook-300">
                {gitopsTool === 'argocd' ? 'Argo' : 'Flux'}
              </span>
            )}
            {/* Work in flight: the dot pings (a radar sweep, the product's own
                metaphor) while the subtitle carries the spinner, so one card
                never shows two spinners for one fact. */}
            <span className={clsx('relative ml-auto flex shrink-0', inFlight ? 'h-2 w-2' : 'h-1.5 w-1.5')}>
              {lively && <span className={clsx('absolute inline-flex h-full w-full animate-ping rounded-full opacity-75', inFlightBg(status))} />}
              <span className={clsx('relative inline-flex h-full w-full rounded-full', inFlight ? inFlightBg(status) : getStatusDotColor(status))} />
            </span>
          </div>
          <div className="truncate pr-1 text-sm font-medium text-theme-text-primary">{node.ref.name}</div>
          {/* Group nodes get a chevron at the bottom-right to advertise the
              click-to-expand affordance. GitOps portal nodes get a similar
              chevron at the right of the subtitle to signal "→ opens its
              own page". The subtitle text alone wasn't enough — users were
              treating the count as an immutable fact rather than a button. */}
          <div className="mt-0.5 flex items-center gap-1 text-xs text-theme-text-secondary">
            {/* The same Loader2 the fleet row and the detail header spin for the
                same state, at the size of the words it qualifies: the tree
                stops being the one GitOps surface where a rollout looks the
                same as a stall. The light sweep marks activity and never
                fakes progress. */}
            {inFlight && (
              <Loader2
                className={clsx('h-3.5 w-3.5 shrink-0 animate-spin', inFlightText(status))}
                aria-label="Reconcile in progress"
              />
            )}
            {awaiting && <Hand className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />}
            {portsTooltip ? (
              <Tooltip content={portsTooltip} position="bottom" wrapperClassName="min-w-0">
                <span className="cursor-help truncate">{subtitle}</span>
              </Tooltip>
            ) : awaiting ? (
              // What is being waited for takes the place of a health word that
              // only repeats the colours (Healthy, Progressing, Suspended); a
              // failing one stays in front of it.
              <span className="truncate">
                {statePrefix(node)}
                <span className="font-medium text-amber-700 dark:text-amber-400">{awaiting.label}</span>
              </span>
            ) : stall ? (
              <span className="truncate">
                {statePrefix(node)}
                <span className="font-medium text-red-600 dark:text-red-400">{stall.label}</span>
                {node.info?.[0]?.value ? ` • ${node.info[0].value}` : ''}
              </span>
            ) : hold ? (
              <span className="flex min-w-0 items-center gap-1">
                <HoldIcon className="h-3.5 w-3.5 shrink-0 text-theme-text-tertiary" aria-hidden />
                <span className="truncate">{statePrefix(node)}{hold.label}</span>
              </span>
            ) : (
              <span className={clsx('truncate', lively && 'inflight-shimmer')}>{subtitle}</span>
            )}
            {Number.isFinite(elapsedMs) && elapsedMs >= 0 && (
              <span className={clsx('shrink-0 tabular-nums', slow ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-theme-text-tertiary')}>
                · {formatElapsed(elapsedMs)}{slow && timeoutMs ? ` of ${formatElapsed(timeoutMs)}` : ''}
              </span>
            )}
            {awaitingControl && <span className="ml-auto shrink-0">{awaitingControl}</span>}
            {(node.role === 'group' || gitopsTool) && <ChevronRight className="ml-auto h-3 w-3 shrink-0 text-theme-text-tertiary" />}
          </div>
          {chips.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {chips.slice(0, 4).map(chip => (
                <span
                  key={`${chip.label}:${chip.value}`}
                  className={clsx(
                    'max-w-[145px] truncate rounded border px-1.5 py-0.5 text-[10px] leading-3',
                    chip.tone === 'warning'
                      ? 'border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300'
                      : chip.tone === 'danger'
                        ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
                        : 'border-theme-border bg-theme-elevated/70 text-theme-text-secondary'
                  )}
                >
                  {chip.label ? `${chip.label}: ` : ''}{chip.value}
                </span>
              ))}
              {radarNote && (
                <Tooltip content={radarNote} delay={200}>
                  <span className="rounded border border-theme-border bg-theme-elevated/70 px-1.5 py-0.5 text-[10px] leading-3 text-theme-text-tertiary">
                    Found by Radar
                  </span>
                </Tooltip>
              )}
            </div>
          )}
        </div>
        {/* An indeterminate bar along the bottom edge: peripheral vision picks
            up motion at a card's edge long before it reads a word. */}
        {lively && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden" aria-hidden>
            <div className={clsx('inflight-bar h-full w-1/3 rounded-full', inFlightBg(status))} />
          </div>
        )}
      </div>
  )

  return (
    <>
      <Handle type="target" position={Position.Left} className="!h-0 !w-0 !border-0 !bg-transparent" />
      {/* A failure's cause wins the hover; otherwise work in flight says what
          the controller is doing (Flux's or Argo's own message, or the
          rollout's progress), and a parked node what it is waiting for. */}
      {cause || note ? <Tooltip content={cause || note} delay={200}>{card}</Tooltip> : card}
      <Handle type="source" position={Position.Right} className="!h-0 !w-0 !border-0 !bg-transparent" />
    </>
  )
})

const nodeTypes: NodeTypes = {
  gitopsResource: GitOpsResourceNode,
}

// gitopsToolForNode returns 'argocd' | 'fluxcd' | undefined depending on
// whether the backend classified this node as itself a GitOps detail-page
// CR (Argo Application/Set/Project, Flux Kustomization/HelmRelease/source).
// These nodes are *portals* — clicking them opens that CR's own GitOps
// detail page rather than the standard resource drawer. The visual
// treatment around them (tool icon overlay, "→" affordance, stronger
// border) advertises that they're not just leaves.
function gitopsToolForNode(node: GitOpsTreeNode): 'argocd' | 'fluxcd' | undefined {
  // The root node IS the resource this detail page is already showing — it is
  // the subject, not a portal to another page. Never give it the portal
  // treatment (tool badge, chevron, click-to-dive ring): clicking the thing
  // you're already viewing would just stack an identical page onto itself.
  if (node.role === 'root') return undefined
  const t = node.data?.gitopsTool
  if (t === 'argocd' || t === 'fluxcd') return t
  return undefined
}

function buildChips(node: GitOpsTreeNode): Array<{ label?: string; value: string; tone?: 'neutral' | 'warning' | 'danger' }> {
  const data = node.data ?? {}
  const chips: Array<{ label?: string; value: string; tone?: 'neutral' | 'warning' | 'danger' }> = []
  // Terminating dominates: surface a single Terminating chip and skip the
  // sync/health chips entirely. Showing "OutOfSync" or "Degraded" alongside
  // a deletion-in-progress tag makes a stuck zombie look like a routine
  // sync problem — same misleading-state pattern we removed from the
  // detail title row and fleet rows.
  if (isNodeTerminating(node)) {
    chips.push({ value: 'Terminating', tone: 'warning' })
    if (typeof data.createdAt === 'string') chips.push({ label: 'age', value: formatCompactAge(data.createdAt) })
    return chips
  }
  if (typeof data.createdAt === 'string') chips.push({ label: 'age', value: formatCompactAge(data.createdAt) })
  const revision = stringData(data.revision) || stringData(data.lastSyncRevision)
  if (revision) chips.push({ label: 'rev', value: revision })
  const attempted = stringData(data.attemptedRevision)
  if (attempted && attempted !== revision) chips.push({ label: 'attempted', value: attempted, tone: 'warning' })
  const wave = stringData(data.syncWave)
  if (wave) chips.push({ label: 'wave', value: wave })
  const hook = stringData(data.hook)
  if (hook) chips.push({ value: hook })
  const relationship = stringData(data.relationship)
  if (relationship) chips.push({ value: relationship })
  if (node.sync === 'OutOfSync') chips.push({ value: 'OutOfSync', tone: 'warning' })
  const health = treeNodeHealth(node)
  if (health === 'Degraded' || health === 'Missing') chips.push({ value: health, tone: 'danger' })
  return chips
}

export interface NodeCause {
  text: string
  // An issue that names a resource as a lead without saying it failed: Argo's
  // Warning-event lead (Go: degradedResourceFromEvents) and the Flux
  // source/dependency blockers (Go: attachFluxBlocker, fluxSourceWarnings).
  lead: boolean
}

const LEAD_REASONS = new Set(['PossibleCause', 'SourceNotReady', 'ArtifactFailed', 'DependencyNotReady'])

export function buildCauseByRef(issues?: GitOpsIssue[]): Map<string, NodeCause> {
  const map = new Map<string, NodeCause>()
  for (const issue of issues ?? []) {
    const cause = issue.cause
    const ref = issue.refs?.[0]
    if (!cause || !ref) continue
    const key = refKey(ref)
    // First match wins — issues arrive ranked by severity, so a node
    // that's the subject of multiple issues keeps its most severe cause.
    if (!map.has(key)) map.set(key, { text: cause, lead: LEAD_REASONS.has(issue.reason) })
  }
  return map
}

// A failing node (topology 'unhealthy') shows any cause as is. A failure
// verdict on a Progressing node would read as "this is broken" on a rollout
// in flight, so elsewhere only a lead shows, framed as possible. That is where
// leads land: the Warning-event lead is only emitted when no resource reads
// as failing, and a Flux source mid-retry reads Progressing while its fetch
// error is still the answer. Healthy and Suspended nodes show nothing.
export function nodeCause(node: GitOpsTreeNode, cause?: NodeCause): string | undefined {
  if (!cause) return undefined
  const status = normalizeHealth(node.topologyStatus)
  if (status === 'unhealthy') return cause.text
  if (!cause.lead || status === 'healthy' || node.health === 'Suspended') return undefined
  return `Possible cause: ${cause.text}`
}

// The subtitle is the node's one line of prose, and sync, health and the
// backend's info line all want it. It can't be won on precedence: the backend
// derives a health for every node it can build an info line for, so a rule that
// only reaches info when health is absent never reaches it at all, and a
// Service's ports, a Pod's phase and an Ingress's host stay invisible.
//
// So all three share the line, and "Healthy" is the part that yields when the
// space is contested. It is the one health value the node already states without
// words — healthToTopology maps it onto the green status dot and the green left
// stripe, one value to one colour. Degraded and Missing are both red, so for
// those the word is the only thing that tells them apart and it keeps its
// place; Progressing and Suspended keep theirs for the same reason colour alone
// can't carry a state to everyone. "Healthy" gives up the line only
// when there is a concrete info line to spend it on, so a node with nothing to
// say instead still reads as Healthy.
export function getSubtitle(node: GitOpsTreeNode): string {
  if (node.role === 'group') {
    // Action-oriented copy invites the click; "collapsed" alone reads as
    // a state description, not an affordance.
    return 'Click to expand'
  }
  if (node.missing) return `${node.sync ? `${node.sync} • ` : ''}Not found in cluster`
  if (isNodeTerminating(node)) {
    return 'Pending deletion'
  }
  const info = node.info?.[0]?.value
  const health = node.health === 'Healthy' && info ? undefined : node.health
  const parts = [node.sync, health, info].filter(Boolean)
  if (parts.length > 0) return parts.join(' • ')
  // A resource with no state of its own to show that its controller is
  // working on (a Flagger Canary mid-analysis) says what the controller says,
  // rather than its namespace.
  if (typeof node.data?.inProgressMessage === 'string' && node.data.inProgressMessage) return node.data.inProgressMessage
  return node.ref.namespace || ''
}

// statePrefix is what stays in front of a waiting or holding label: the sync
// word, and a health word that says something is wrong.
function statePrefix(node: GitOpsTreeNode): string {
  const failing = node.health === 'Degraded' || node.health === 'Missing' ? node.health : undefined
  return [node.sync, failing].filter(Boolean).map((part) => `${part} • `).join('')
}

function normalizeDisplayKind(node: GitOpsTreeNode): string {
  if (node.role === 'group' && node.ref.kind === 'Pod') return 'PodGroup'
  return node.ref.kind || 'PodGroup'
}

// In-flight colour: the node's own tone, except an unknown one, whose gray
// would hide the motion that is the whole point; sky is the neutral
// "something is happening" tone.
function inFlightBg(status: HealthStatus): string {
  return status === 'unknown' ? SEVERITY_DOT.info : SEVERITY_DOT[healthToSeverity(status)]
}

function inFlightText(status: HealthStatus): string {
  return status === 'unknown' ? SEVERITY_TEXT.info : SEVERITY_TEXT[healthToSeverity(status)]
}

function normalizeHealth(status?: string): HealthStatus {
  if (status === 'healthy' || status === 'degraded' || status === 'unhealthy' || status === 'neutral') return status
  return 'unknown'
}

// nodeTone is the colour a node paints. A paused node is neutral (sky), as on
// every other surface; the health word covers a backend that still sends
// Suspended as 'degraded', since the frontend may be newer than it.
export function nodeTone(node: GitOpsTreeNode): HealthStatus {
  if (node.missing) return 'unhealthy'
  if (node.health === 'Suspended') return 'neutral'
  return normalizeHealth(node.topologyStatus)
}

function getStatusDotColor(status: HealthStatus): string {
  return SEVERITY_DOT[healthToSeverity(status)]
}

function getNodeDimensions(node: GitOpsTreeNode): { width: number; height: number } {
  if (node.role === 'group') return { width: GROUP_WIDTH, height: GROUP_HEIGHT }
  return { width: NODE_WIDTH, height: NODE_HEIGHT }
}

function matchesQuery(node: GitOpsTreeNode, query: string): boolean {
  return [
    node.ref.kind,
    node.ref.name,
    node.ref.namespace,
    node.ref.group,
    node.sync,
    treeNodeHealth(node),
  ].some(value => String(value ?? '').toLowerCase().includes(query))
}

function compareTreeNodes(a?: GitOpsTreeNode, b?: GitOpsTreeNode): number {
  if (!a || !b) return 0
  const roleDiff = rolePriority(a.role) - rolePriority(b.role)
  if (roleDiff !== 0) return roleDiff
  const kindDiff = kindPriority(a.ref.kind) - kindPriority(b.ref.kind)
  if (kindDiff !== 0) return kindDiff
  return `${a.ref.namespace}/${a.ref.name}`.localeCompare(`${b.ref.namespace}/${b.ref.name}`)
}

function rolePriority(role: string): number {
  switch (role) {
    case 'root': return 0
    case 'declared': return 1
    case 'generated': return 2
    case 'group': return 3
    default: return 4
  }
}

function kindPriority(kind: string): number {
  const priorities: Record<string, number> = {
    Namespace: 0,
    AppProject: 1,
    ServiceAccount: 2,
    Secret: 3,
    SealedSecret: 3,
    ConfigMap: 4,
    CustomResourceDefinition: 5,
    ClusterRole: 6,
    ClusterRoleBinding: 7,
    Role: 8,
    RoleBinding: 9,
    Service: 10,
    Deployment: 11,
    StatefulSet: 11,
    DaemonSet: 11,
    ReplicaSet: 12,
    Pod: 13,
    Ingress: 14,
    Gateway: 14,
    HTTPRoute: 15,
  }
  return priorities[kind] ?? 20
}

function stringData(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function pluralize(kind: string): string {
  if (kind.endsWith('s')) return kind
  if (kind.endsWith('y')) return `${kind.slice(0, -1)}ies`
  return `${kind}s`
}

