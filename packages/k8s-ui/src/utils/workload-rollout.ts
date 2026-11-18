import type { WorkloadPodInfo } from '../types/core'

/** Every CanaryStep variant Argo defines; raw JSON is unreadable in a step list. */
export function canaryStepLabel(step: any): string {
  if (!step || typeof step !== 'object') return 'Unknown step'

  if (step.setWeight !== undefined) return `Set weight: ${step.setWeight}%`

  if (step.pause !== undefined) {
    return pauseHasDuration(step.pause) ? `Pause: ${step.pause.duration}` : 'Pause: until promoted'
  }

  if (step.analysis) {
    const templates = (step.analysis.templates || [])
      .map((t: any) => t.templateName || t.clusterTemplateName)
      .filter(Boolean)
    return templates.length > 0 ? `Analysis: ${templates.join(', ')}` : 'Analysis'
  }

  if (step.experiment) {
    const templates = (step.experiment.templates || []).map((t: any) => t.name).filter(Boolean)
    const duration = step.experiment.duration ? ` for ${step.experiment.duration}` : ''
    return templates.length > 0
      ? `Experiment: ${templates.join(', ')}${duration}`
      : `Experiment${duration}`
  }

  if (step.setCanaryScale) {
    const { weight, replicas, matchTrafficWeight } = step.setCanaryScale
    if (matchTrafficWeight) return 'Set canary scale: match traffic weight'
    if (replicas !== undefined) return `Set canary scale: ${replicas} replicas`
    if (weight !== undefined) return `Set canary scale: ${weight}%`
    return 'Set canary scale'
  }

  if (step.setHeaderRoute) {
    const { name, match } = step.setHeaderRoute
    // An empty match list is how a header route is torn down again.
    if (!match || match.length === 0) return `Remove header route${name ? `: ${name}` : ''}`
    const headers = match.map((m: any) => m.headerName).filter(Boolean)
    return `Header route${name ? ` ${name}` : ''}${headers.length ? `: ${headers.join(', ')}` : ''}`
  }

  if (step.setMirrorRoute) {
    const { name, match, percentage } = step.setMirrorRoute
    if (!match || match.length === 0) return `Remove mirror route${name ? `: ${name}` : ''}`
    const pct = percentage !== undefined ? ` (${percentage}%)` : ''
    return `Mirror route${name ? ` ${name}` : ''}${pct}`
  }

  if (step.plugin) return `Plugin: ${step.plugin.name || 'unnamed'}`

  const key = Object.keys(step)[0]
  return key ? `Unrecognized step: ${key}` : 'Unknown step'
}

export type WorkloadRolloutPhase =
  | 'idle'
  | 'applying'
  | 'progressing'
  | 'waiting'
  | 'paused'
  | 'partition-reached'
  | 'stalled'

export interface WorkloadRolloutActivity {
  phase: WorkloadRolloutPhase
  active: boolean
  manual: boolean
  label: string
  detail?: string
  desired: number
  updated: number
  ready: number
  available: number
  /** The pause an Argo Rollout waits for promotion at (argoPromotionGate); absent otherwise and from older Radars. */
  gate?: string
}

// isArgoRolloutRef is isArgoRolloutResource for a reference ({group, kind}):
// the one kind Radar can promote itself. Argo Rollouts takes a promote through
// its API, while a Flagger gate is a webhook only its owner can answer.
export function isArgoRolloutRef(ref: { group?: string; kind?: string }): boolean {
  return ref.kind === 'Rollout' && ref.group === 'argoproj.io'
}

export function isArgoRolloutResource(resource: any): boolean {
  return String(resource?.apiVersion || '').startsWith('argoproj.io/')
}

export function rolloutMayAdvanceAutomatically(activity: WorkloadRolloutActivity): boolean {
  return activity.phase === 'applying' ||
    activity.phase === 'progressing' ||
    (activity.phase === 'waiting' && !activity.manual)
}

// rolloutIsMoving is the rule every rollout spinner turns on: a rollout the
// controller is applying or progressing. Waiting, paused and stalled rollouts
// are still shown, but they don't spin: nothing is moving.
export function rolloutIsMoving(activity?: Pick<WorkloadRolloutActivity, 'active' | 'phase'> | null): boolean {
  return Boolean(activity?.active && (activity.phase === 'applying' || activity.phase === 'progressing'))
}

// rolloutAwaitsAction is the rule every "waiting for you" mark turns on: a
// rollout that will not move until a person acts (an Argo Rollout on an
// untimed pause, a workload whose strategy waits for its Pods to be deleted by
// hand). The backend's topology uses the same two fields for data.awaiting.
export function rolloutAwaitsAction(activity?: Pick<WorkloadRolloutActivity, 'active' | 'manual'> | null): boolean {
  return Boolean(activity?.active && activity.manual)
}

export function isRolloutActivityVisible(activity: WorkloadRolloutActivity): boolean {
  return activity.active || activity.phase === 'stalled'
}

export function getObservedGeneration(resource: any): number {
  const observed = resource?.status?.observedGeneration
  if (typeof observed === 'number' && Number.isFinite(observed)) return observed
  return typeof observed === 'string' && /^\d+$/.test(observed)
    ? Number.parseInt(observed, 10)
    : 0
}

export function getWorkloadRolloutActivity(
  resource: any,
  kind?: string,
  workloadPods?: WorkloadPodInfo[],
): WorkloadRolloutActivity {
  const normalized = (kind || resource?.kind || '').toLowerCase().replace(/s$/, '')
  if (normalized === 'rollout' && !isArgoRolloutResource(resource)) {
    return activity('idle', false, false, 'Stable', '', 0, 0, 0, 0)
  }
  let result: WorkloadRolloutActivity
  switch (normalized) {
    case 'deployment':
      result = deploymentActivity(resource)
      break
    case 'statefulset':
      result = statefulSetActivity(resource)
      break
    case 'daemonset':
      result = daemonSetActivity(resource)
      break
    case 'rollout':
      result = argoRolloutActivity(resource)
      break
    default:
      result = activity('idle', false, false, 'Stable', '', 0, 0, 0, 0)
  }
  return withUpdatedRevisionFailure(result, workloadPods)
}

function deploymentActivity(resource: any): WorkloadRolloutActivity {
  const spec = resource?.spec || {}
  const status = resource?.status || {}
  const desired = spec.replicas ?? 1
  const updated = status.updatedReplicas ?? 0
  const ready = status.readyReplicas ?? 0
  const available = status.availableReplicas ?? 0
  const base = activity('idle', false, false, 'Stable', '', desired, updated, ready, available)
  const progress = (status.conditions || []).find((condition: any) => condition.type === 'Progressing')

  if ((status.observedGeneration ?? 0) < (resource?.metadata?.generation ?? 0)) {
    return merge(base, 'applying', true, 'Applying change', 'Waiting for the Deployment controller to observe generation')
  }
  if (progress?.status === 'False' || progress?.reason === 'ProgressDeadlineExceeded') {
    return merge(base, 'stalled', false, 'Rollout stalled', progress.message || 'Progress deadline exceeded')
  }
  const old = Math.max(0, (status.replicas ?? 0) - updated)
  const pending = updated < desired || old > 0
  if (spec.paused) {
    return merge(base, 'paused', pending, 'Rollout paused', pending ? `Paused at ${updated}/${desired} updated` : 'No rollout is pending')
  }
  if (desired === 0) return merge(base, 'idle', false, 'Scaled to zero', 'No replicas requested')
  if (!pending) return merge(base, 'idle', false, 'Stable', `${available}/${desired} available`)
  if (spec.strategy?.type === 'Recreate') {
    if (updated === 0 && old > 0) {
      return merge(base, 'waiting', true, 'Replacing replicas', `Waiting for old replicas to stop · ${available} available`)
    }
    return updated === 0
      ? merge(base, 'waiting', true, 'Waiting for new revision', replicaDetail(updated, desired, available))
      : merge(base, 'progressing', true, 'Replacing replicas', replicaDetail(updated, desired, available))
  }
  if (updated === 0) return merge(base, 'waiting', true, 'Waiting for new revision', replicaDetail(updated, desired, available))
  return old === 0 && updated === (status.replicas ?? 0)
    ? merge(base, 'progressing', true, 'Scaling', replicaDetail(updated, desired, available))
    : merge(base, 'progressing', true, 'Rolling out', replicaDetail(updated, desired, available))
}

function statefulSetActivity(resource: any): WorkloadRolloutActivity {
  const spec = resource?.spec || {}
  const status = resource?.status || {}
  const desired = spec.replicas ?? 1
  const updated = status.updatedReplicas ?? 0
  const ready = status.readyReplicas ?? 0
  const base = activity('idle', false, false, 'Stable', '', desired, updated, ready, ready)

  if ((status.observedGeneration ?? 0) < (resource?.metadata?.generation ?? 0)) {
    return merge(base, 'applying', true, 'Applying change', 'Waiting for the StatefulSet controller to observe generation')
  }
  if (desired === 0) return merge(base, 'idle', false, 'Scaled to zero', 'No replicas requested')
  if (spec.updateStrategy?.type === 'OnDelete') {
    return updated === desired && ready === desired
      ? merge(base, 'idle', false, 'Stable', `${ready}/${desired} ready`)
      : mergeManual(base, 'waiting', true, 'Waiting for Pod restart', `OnDelete strategy · ${updated}/${desired} updated`)
  }
  const partition = spec.updateStrategy?.rollingUpdate?.partition ?? 0
  const target = Math.max(0, desired - partition)
  if (updated >= target) {
    const pendingRevision = Boolean(status.currentRevision && status.updateRevision && status.currentRevision !== status.updateRevision)
    return partition > 0 && pendingRevision
      ? merge(base, 'partition-reached', false, 'Partition reached', `${partition}/${desired} Pods intentionally retained`)
      : merge(base, 'idle', false, 'Stable', `${ready}/${desired} ready`)
  }
  const detail = `${updated}/${target} target Pods updated · ${ready}/${desired} ready`
  return updated === 0
    ? merge(base, 'waiting', true, 'Waiting for new revision', detail)
    : merge(base, 'progressing', true, 'Rolling out', detail)
}

function daemonSetActivity(resource: any): WorkloadRolloutActivity {
  const spec = resource?.spec || {}
  const status = resource?.status || {}
  const desired = status.desiredNumberScheduled ?? 0
  const updated = status.updatedNumberScheduled ?? 0
  const ready = status.numberReady ?? 0
  const available = status.numberAvailable ?? 0
  const base = activity('idle', false, false, 'Stable', '', desired, updated, ready, available)

  if ((status.observedGeneration ?? 0) < (resource?.metadata?.generation ?? 0)) {
    return merge(base, 'applying', true, 'Applying change', 'Waiting for the DaemonSet controller to observe generation')
  }
  if (desired === 0) return merge(base, 'idle', false, 'No targets', 'Selector matches no nodes')
  if (spec.updateStrategy?.type === 'OnDelete') {
    return updated === desired && available === desired
      ? merge(base, 'idle', false, 'Stable', `${available}/${desired} available`)
      : mergeManual(base, 'waiting', true, 'Waiting for Pod restart', `OnDelete strategy · ${updated}/${desired} updated`)
  }
  if (updated === desired) return merge(base, 'idle', false, 'Stable', `${available}/${desired} available`)
  return updated === 0
    ? merge(base, 'waiting', true, 'Waiting for new revision', replicaDetail(updated, desired, available))
    : merge(base, 'progressing', true, 'Rolling out', replicaDetail(updated, desired, available))
}

function argoRolloutActivity(resource: any): WorkloadRolloutActivity {
  const spec = resource?.spec || {}
  const status = resource?.status || {}
  const desired = spec.replicas ?? ((status.replicas ?? 0) || 1)
  const updated = status.updatedReplicas ?? 0
  const ready = status.readyReplicas ?? 0
  const available = status.availableReplicas ?? 0
  const base = activity('idle', false, false, 'Stable', '', desired, updated, ready, available)
  const detail = argoDetail(resource, updated, desired, available)
  const observedGeneration = getObservedGeneration(resource)
  if (observedGeneration > 0 && observedGeneration < (resource?.metadata?.generation ?? 0)) {
    return merge(base, 'applying', true, 'Applying change', 'Waiting for the Rollout controller to observe generation')
  }
  const failedCondition = (status.conditions || []).find((condition: any) =>
    (condition.type === 'InvalidSpec' && condition.status === 'True') ||
    (condition.type === 'Progressing' && (condition.status === 'False' || condition.reason === 'ProgressDeadlineExceeded')),
  )
  if (failedCondition || status.abort) {
    return merge(base, 'stalled', false, 'Rollout stalled', failedCondition?.message || failedCondition?.reason || status.message || (status.abort ? 'The Rollout was aborted' : '') || 'The Rollout controller reported a failed revision')
  }
  switch (String(status.phase || '').toLowerCase()) {
    case 'degraded':
    case 'error':
    case 'failed':
    case 'aborted':
      return merge(base, 'stalled', false, 'Rollout stalled', status.message || 'The Rollout controller reported a failed revision')
    case 'paused': {
      const awaited = argoAwaitedAction(resource)
      if (!awaited) return merge(base, 'paused', true, 'Rollout paused', detail)
      const waiting = mergeManual(base, 'paused', true, awaited, detail)
      return awaited === 'Waiting for promotion' ? { ...waiting, gate: argoPromotionGate(resource) } : waiting
    }
    case 'progressing':
      return updated === 0
        ? merge(base, 'waiting', true, 'Waiting for new revision', detail)
        : merge(base, 'progressing', true, 'Rolling out', detail)
    case 'healthy':
      return merge(base, 'idle', false, 'Stable', `${available}/${desired} available`)
    default:
      return desired > 0 && (updated < desired || available < desired)
        ? merge(base, 'applying', true, 'Applying change', detail)
        : merge(base, 'idle', false, 'Stable', status.message || '')
  }
}

// Mirrors pkg/health/workload_rollout.go's ArgoPromotionGate: where the
// Rollout stands (canary step or blue-green revision) and when the controller
// recorded the pause, so a promote confirmed for one pause never clears the
// next one, which reads "Waiting for promotion" too.
export function argoPromotionGate(resource: any): string {
  let started = ''
  const pauses = resource?.status?.pauseConditions
  for (const pause of Array.isArray(pauses) ? pauses : []) {
    if (typeof pause?.startTime === 'string' && pause.startTime > started) started = pause.startTime
  }
  const blueGreen = resource?.spec?.strategy?.blueGreen
  if (blueGreen && typeof blueGreen === 'object') {
    const hash = resource?.status?.currentPodHash
    return `pod:${typeof hash === 'string' ? hash : ''}@${started}`
  }
  const index = resource?.status?.currentStepIndex
  return `step:${typeof index === 'number' ? index : 0}@${started}`
}

// Mirrors pkg/health/workload_rollout.go's argoAwaitedAction exactly: what a
// paused Rollout is waiting on someone for, or '' when it is waiting on no
// one. Only a pause the controller recorded counts: right after a promote the
// stored phase still says Paused with the pause conditions already gone, and
// a pause a person set (spec.paused) is left to that person. Checked against
// the same golden fixture as the rest of this file.
function argoAwaitedAction(resource: any): string {
  if (resource?.spec?.paused === true) return ''
  const recorded = resource?.status?.pauseConditions
  const reasons = new Set<string>(
    (Array.isArray(recorded) ? recorded : []).map((pause: any) => pause?.reason).filter(Boolean),
  )
  if (reasons.has('InconclusiveAnalysisRun')) return 'Analysis inconclusive'
  if (reasons.has('InconclusiveExperiment')) return 'Experiment inconclusive'
  const blueGreen = resource?.spec?.strategy?.blueGreen
  if (blueGreen && typeof blueGreen === 'object') {
    // With auto-promotion off the controller ignores autoPromotionSeconds.
    return reasons.has('BlueGreenPause') && blueGreen.autoPromotionEnabled === false
      ? 'Waiting for promotion'
      : ''
  }
  if (!reasons.has('CanaryPauseStep')) return ''
  const steps = resource?.spec?.strategy?.canary?.steps || []
  const index = resource?.status?.currentStepIndex
  if (typeof index !== 'number' || index < 0 || index >= steps.length) return ''
  const step = steps[index]
  if (!step || typeof step !== 'object' || !('pause' in step)) return ''
  // Argo Rollouts reads a missing or empty duration as "until promoted"; any
  // other value, 0 included, ends the pause by itself.
  return pauseHasDuration(step.pause) ? '' : 'Waiting for promotion'
}

function pauseHasDuration(pause: any): boolean {
  const duration = pause?.duration
  return duration !== undefined && duration !== null && duration !== ''
}

function withUpdatedRevisionFailure(
  rollout: WorkloadRolloutActivity,
  pods?: WorkloadPodInfo[],
): WorkloadRolloutActivity {
  if ((!rollout.active && rollout.phase !== 'stalled') || rollout.phase === 'applying' || !pods) return rollout
  // The server decides it per Pod (revisionFailing, from pkg/health
  // RevisionPodFailing), as it does for the tree and the applications list: a
  // crash-looping Pod can pass its probes between restarts, and a Pod being
  // deleted says nothing. An older Radar sends no verdict; then an unhealthy
  // Pod that has not ended (evicted, stopped with its node) is the best read.
  const failed = pods
    .filter((pod) => pod.updatedRevision === true && (pod.revisionFailing ?? (pod.healthLevel === 'unhealthy' && pod.phase !== 'Failed' && pod.phase !== 'Succeeded')))
    .sort((a, b) => a.name.localeCompare(b.name))[0]
  if (!failed) return rollout
  const reason = failed.reason || failed.lastTerminationReason || failed.phase || 'Pod failed'
  return merge(rollout, 'stalled', false, 'New revision cannot start', `${reason} · Pod ${failed.name}`)
}

export function getArgoRolloutStepNumber(resource: any): number | null {
  const steps = resource?.spec?.strategy?.canary?.steps || []
  const currentIndex = resource?.status?.currentStepIndex
  if (steps.length === 0 || typeof currentIndex !== 'number') return null
  return Math.min(Math.max(currentIndex + 1, 1), steps.length)
}

// Mirrors pkg/health/workload_rollout.go's argoStepDetail exactly (same
// output string, same step-type coverage via canaryStepLabel) - the two are
// checked against the same golden fixture
// (pkg/health/testdata/workload_rollout_vectors.json), so a change to one
// without the other silently breaks cross-language parity rather than
// failing loudly.
function argoDetail(resource: any, updated: number, desired: number, available: number): string {
  const steps = resource?.spec?.strategy?.canary?.steps || []
  const stepNumber = getArgoRolloutStepNumber(resource)
  const step = stepNumber === null ? '' : `Step ${stepNumber}`
  const currentStep = stepNumber === null ? undefined : steps[stepNumber - 1]
  const label = currentStep ? ` (${canaryStepLabel(currentStep)})` : ''
  const weight = resource?.status?.canary?.weights?.canary?.weight
  const weightSuffix = typeof weight === 'number' ? ` · ${weight}% canary traffic` : ''
  const prefix = stepNumber === null ? '' : `${step}${label} · `
  return `${prefix}${updated}/${desired} updated · ${available} available${weightSuffix}`
}

function replicaDetail(updated: number, desired: number, available: number): string {
  return `${updated}/${desired} updated · ${available} available`
}

function activity(
  phase: WorkloadRolloutPhase,
  active: boolean,
  manual: boolean,
  label: string,
  detail: string,
  desired: number,
  updated: number,
  ready: number,
  available: number,
): WorkloadRolloutActivity {
  return { phase, active, manual, label, detail, desired, updated, ready, available }
}

function merge(
  base: WorkloadRolloutActivity,
  phase: WorkloadRolloutPhase,
  active: boolean,
  label: string,
  detail: string,
): WorkloadRolloutActivity {
  return { ...base, phase, active, manual: false, label, detail, gate: undefined }
}

function mergeManual(
  base: WorkloadRolloutActivity,
  phase: WorkloadRolloutPhase,
  active: boolean,
  label: string,
  detail: string,
): WorkloadRolloutActivity {
  return { ...base, phase, active, manual: true, label, detail, gate: undefined }
}

export function rolloutActivityLevel(activity: WorkloadRolloutActivity): 'healthy' | 'neutral' | 'degraded' | 'unhealthy' {
  switch (activity.phase) {
    case 'stalled':
      return 'unhealthy'
    case 'paused':
      return 'degraded'
    case 'waiting':
      return activity.manual ? 'degraded' : 'neutral'
    case 'applying':
    case 'progressing':
    case 'partition-reached':
      return 'neutral'
    default:
      return activity.label === 'Stable' ? 'healthy' : 'neutral'
  }
}

export function rolloutActivityBadge(activity: WorkloadRolloutActivity): { text: string; color: string; level: 'healthy' | 'neutral' | 'degraded' | 'unhealthy' } {
  const level = rolloutActivityLevel(activity)
  return { text: activity.label, color: `status-${level}`, level }
}
