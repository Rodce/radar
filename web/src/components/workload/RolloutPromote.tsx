import { createContext, useCallback, useContext, useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Play } from 'lucide-react'
import { awaitsPromotion } from '@skyhook-io/k8s-ui/utils/awaiting-action'
import { getWorkloadRolloutActivity } from '@skyhook-io/k8s-ui/utils/workload-rollout'
import { fetchResourceWithRelationships, useRolloutAction, useRolloutCapabilities } from '../../api/client'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { showApiError, showApiNotice } from '../ui/Toast'
import { Tooltip } from '../ui/Tooltip'

// Promote an Argo Rollout from wherever Radar says it is waiting for that: a
// node of the GitOps tree, a row of the applications list. It is the Promote
// of the Rollout's own page (the same call, the same permission check), with
// one difference: it asks first. On a graph or in a list a click lands on the
// wrong item far more easily than on a page opened for that one Rollout, and
// a promote sends the new version on to more traffic.
//
// RolloutPromoteProvider owns the question and the call, once per page, and
// draws the dialog outside the graph's nodes and the list's rows: a dialog
// drawn inside one would pass its pointer and keyboard events up to it (its
// hover card, its key handling). Each RolloutPromoteButton only asks it.

interface PromoteRequest {
  namespace: string
  name: string
  waitingFor?: string
  // The pause the person was shown (WorkloadRolloutActivity.gate). Absent
  // from an older Radar, which then checks only that the Rollout still waits.
  gate?: string
  // Called once Argo Rollouts has accepted the promote.
  onSent: () => void
}

const PromoteContext = createContext<((request: PromoteRequest) => void) | null>(null)

export function RolloutPromoteProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const action = useRolloutAction()
  const [request, setRequest] = useState<PromoteRequest | null>(null)
  const ask = useCallback((next: PromoteRequest) => setRequest(next), [])

  // The surfaces this sits on read the Rollout through their own queries,
  // none of which polls a Rollout that is only waiting. Argo Rollouts acts on
  // the promote a moment after the call returns, Radar sees that a moment
  // later still, and the tree and the applications list read through
  // server-side snapshots kept for 5 and 10 seconds. So read again a few
  // times, the last one past those snapshots; once the Rollout is seen moving,
  // each surface's own polling takes over. (The call's own success handler
  // refreshes the Rollout's page and topology.)
  const refetch = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['gitops-tree'] })
    queryClient.invalidateQueries({ queryKey: ['applications'] })
  }, [queryClient])
  // The mark that offered this promote comes from snapshots up to half a
  // minute old (the list's and the tree's server-side caches, then this
  // page's own copy). A promote on a Rollout that has moved on since clears no
  // pause: Argo Rollouts skips the step the Rollout is on, an analysis
  // included. One that has moved on to the next untimed pause still reads as
  // waiting, and a promote would clear a pause nobody was shown. So read the
  // Rollout again first and send only while it waits at the same pause; the
  // server checks that pause again on the live object (rollouts.PromoteAt).
  const [checking, setChecking] = useState(false)
  const promote = async () => {
    if (!request || checking) return
    const { namespace, name, gate, onSent } = request
    setChecking(true)
    let waiting: boolean
    let samePause: boolean
    try {
      const live = await fetchResourceWithRelationships<unknown>('rollouts', namespace, name, 'argoproj.io')
      const activity = getWorkloadRolloutActivity(live.resource, 'rollout')
      waiting = awaitsPromotion(activity.label)
      samePause = !gate || activity.gate === gate
    } catch (error) {
      setChecking(false)
      setRequest(null)
      showApiError(`Could not read ${namespace}/${name} again; nothing was sent`, error instanceof Error ? error.message : undefined)
      return
    }
    setChecking(false)
    if (!waiting) {
      setRequest(null)
      refetch()
      showApiNotice(`${namespace}/${name} is no longer waiting for promotion`, 'Nothing was sent: the rollout has moved on since this page last read it.', 'info')
      return
    }
    if (!samePause) {
      setRequest(null)
      refetch()
      showApiNotice(`${namespace}/${name} now waits at a different pause`, 'Nothing was sent: someone moved it on since this page last read it. Check the new pause before promoting again.', 'info')
      return
    }
    action.mutate(
      { action: 'promote', namespace, name, gate },
      {
        onSuccess: () => {
          onSent()
          refetch()
          for (const delay of [1500, 4000, 7000, 12_000]) {
            window.setTimeout(() => {
              refetch()
              queryClient.invalidateQueries({ queryKey: ['topology'] })
            }, delay)
          }
        },
        // A pause that changed after the check is refused by the server (409);
        // the global toast says so, and the surfaces read the Rollout again.
        onError: () => refetch(),
        onSettled: () => setRequest(null),
      },
    )
  }

  return (
    <PromoteContext.Provider value={ask}>
      {children}
      <ConfirmDialog
        open={request !== null}
        onClose={() => setRequest(null)}
        onConfirm={promote}
        title={request ? `Promote ${request.name}?` : 'Promote?'}
        message={request
          ? `Argo Rollouts continues ${request.namespace}/${request.name} past the pause it is waiting at. A canary moves on to its next step; a blue-green rollout switches all traffic to the new version.`
          : ''}
        details={request?.waitingFor}
        confirmLabel="Promote"
        variant="warning"
        isLoading={checking || action.isPending}
      />
    </PromoteContext.Provider>
  )
}

// How long a sent promote keeps its button disabled when the waiting mark
// outlives it: a promote that took effect makes the mark, and the button with
// it, go away well before this.
const SENT_HOLD_MS = 30_000

export function RolloutPromoteButton({
  namespace,
  name,
  waitingFor,
  gate,
}: {
  namespace: string
  name: string
  // What the Rollout is waiting at, in Radar's words ("Step 2 (Pause: until
  // promoted) · 1/4 updated"), repeated in the question.
  waitingFor?: string
  // The pause it waits at (WorkloadRolloutActivity.gate), so the promote
  // clears that pause and no other.
  gate?: string
}) {
  const ask = useContext(PromoteContext)
  const { data: capabilities } = useRolloutCapabilities(namespace, name, ask !== null, { staleTime: 30_000 })
  // Once sent, the button stays disabled: the mark it sits beside can read
  // "waiting" for a few seconds more, and a second promote would pass the
  // next gate too.
  const [sent, setSent] = useState(false)
  useEffect(() => {
    if (!sent) return
    const id = window.setTimeout(() => setSent(false), SENT_HOLD_MS)
    return () => window.clearTimeout(id)
  }, [sent])
  // Nothing to offer without the page's dialog, without permission (as on the
  // Rollout's page), or on a Rollout being deleted.
  if (!ask || !capabilities?.promote || capabilities.terminating) return null

  // The button lives inside clickable things (a graph node, a table row) that
  // also answer keys: keep its clicks and keys to itself.
  const contain = (event: MouseEvent | KeyboardEvent) => event.stopPropagation()
  return (
    <Tooltip content={sent ? 'Promote sent; waiting for Argo Rollouts to move on' : 'Clear the pause and let the rollout continue'} delay={150}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          ask({ namespace, name, waitingFor, gate, onSent: () => setSent(true) })
        }}
        onDoubleClick={contain}
        onKeyDown={contain}
        onKeyUp={contain}
        disabled={sent}
        aria-label={sent ? `Promote of ${namespace}/${name} sent` : `Promote ${namespace}/${name}`}
        className="nodrag nopan inline-flex items-center gap-1 rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium leading-4 text-amber-800 transition-colors hover:bg-amber-500/20 disabled:cursor-default disabled:opacity-70 dark:text-amber-300"
      >
        {sent ? <Check className="h-3 w-3" aria-hidden /> : <Play className="h-3 w-3" aria-hidden />}
        {sent ? 'Promote sent' : 'Promote'}
      </button>
    </Tooltip>
  )
}
