import { rolloutIsMoving, type WorkloadRolloutActivity } from './workload-rollout'

// A resource parked until a person acts: an Argo Rollout on an untimed pause
// or an inconclusive analysis, a Flagger Canary on a confirmation gate. The
// backend puts it on the node as data.awaiting. It is the opposite of work in
// flight: nothing moves until someone does something, so the surfaces that
// show it hold still and say what is being waited for.
export interface AwaitingAction {
  label: string
  detail?: string
  // The pause a promotion gate is (pkg/health ArgoPromotionGate): a promote
  // names it, so it never clears a later pause. Absent from older Radars.
  gate?: string
}

export function awaitingAction(data: Record<string, unknown> | undefined): AwaitingAction | undefined {
  const raw = data?.awaiting
  if (!raw || typeof raw !== 'object') return undefined
  const { label, detail, gate } = raw as { label?: unknown; detail?: unknown; gate?: unknown }
  if (typeof label !== 'string' || label === '') return undefined
  return {
    label,
    detail: typeof detail === 'string' && detail !== '' ? detail : undefined,
    ...(typeof gate === 'string' && gate !== '' ? { gate } : {}),
  }
}

// awaitingNote is the one-line hover for it, and for a rollout hold.
export function awaitingNote(awaiting: { label: string; detail?: string }): string {
  return awaiting.detail ? `${awaiting.label}: ${awaiting.detail}` : awaiting.label
}

// The one request a promote answers. An inconclusive analysis or experiment
// waits on a decision, promote or abort, which belongs on the Rollout's own
// page, where both are offered beside the analysis that came back unclear.
const PROMOTION_GATE = 'Waiting for promotion'

export function awaitsPromotion(label: string | undefined): boolean {
  return label === PROMOTION_GATE
}

// A rollout under way and standing still that the backend does not mark as
// waiting on a person (data.awaiting), in the words the workload page uses for
// it ("Rollout paused", "Waiting for new revision", "Waiting for Pod
// restart"): a canary between two steps, a workload someone paused
// mid-rollout, a StatefulSet whose new revision waits for its Pods to be
// deleted (by a person or by an operator; Radar can't tell which). Shown so
// the workload never reads as settled; never spun, since nothing is moving.
export interface RolloutHold {
  label: string
  detail?: string
  phase: WorkloadRolloutActivity['phase']
}

// rolloutStall is a rollout that cannot go on, in the workload page's words:
// its new revision cannot start, its controller gave up, it was aborted. The
// node's own status already paints it; this says why, beside it.
export function rolloutStall(data: Record<string, unknown> | undefined): { label: string; detail?: string } | undefined {
  const rollout = data?.rollout as WorkloadRolloutActivity | undefined
  if (!rollout?.label || rollout.phase !== 'stalled') return undefined
  return { label: rollout.label, detail: rollout.detail || undefined }
}

export function rolloutHold(data: Record<string, unknown> | undefined): RolloutHold | undefined {
  if (!data || awaitingAction(data)) return undefined
  const rollout = data.rollout as WorkloadRolloutActivity | undefined
  if (!rollout?.label || !rollout.active || rolloutIsMoving(rollout)) return undefined
  return { label: rollout.label, detail: rollout.detail || undefined, phase: rollout.phase }
}
