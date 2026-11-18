import type { TimelineEvent, WorkloadPodInfo } from '../types/core'

/**
 * A pod that is not ready only because it is still coming up. The server
 * decides (pkg/health IsPodStarting weighs the pod's probes against its age),
 * and a pod it grades as a problem never counts. A Radar that predates that
 * signal leaves `starting` out; then a moving rollout is the evidence: a pod
 * of the new revision with nothing failing and no restart.
 */
export function workloadPodStarting(pod: WorkloadPodInfo, rolloutMoving = false): boolean {
  if (pod.ready) return false
  if (pod.healthLevel && pod.healthLevel !== 'healthy' && pod.healthLevel !== 'neutral') return false
  if (pod.starting !== undefined) return pod.starting
  return rolloutMoving && pod.updatedRevision === true && pod.healthLevel === 'healthy' && !pod.restartCount
}

export interface WorkloadPodReadiness {
  ready: number
  total: number
  starting: number
  /** Not ready for any reason but starting up. */
  attention: number
}

export function summarizeWorkloadPodReadiness(pods: WorkloadPodInfo[], rolloutMoving = false): WorkloadPodReadiness {
  const ready = pods.filter((pod) => pod.ready).length
  const starting = pods.filter((pod) => workloadPodStarting(pod, rolloutMoving)).length
  return { ready, total: pods.length, starting, attention: pods.length - ready - starting }
}

/** The pods that are not ready, problems first; `whenNone` when there are none. */
export function podReadinessDetail(counts: { starting?: number; attention?: number }, whenNone: string): string {
  const parts: string[] = []
  if (counts.attention) parts.push(`${counts.attention} need attention`)
  if (counts.starting) parts.push(`${counts.starting} starting`)
  return parts.length > 0 ? parts.join(' · ') : whenNone
}

const PROBE_FAILURE = /^(startup|readiness) probe failed\b/i

/**
 * Picks out the failed startup and readiness probes a pod reports while it
 * comes up: the kubelet probes until the app answers and records every miss
 * as a Warning. That is expected while the pod is starting. A failed startup
 * probe stays expected once the pod is ready without a restart, because a
 * container that runs out of startup probes is restarted. Liveness failures,
 * and anything from a pod that restarted, stay alarms. Only events since the
 * pod's creation count: a recreated pod reuses its predecessor's name.
 */
export function startupProbeNoise(
  pods: WorkloadPodInfo[] | undefined,
  namespace: string,
  rolloutMoving = false,
): (event: TimelineEvent) => boolean {
  const byName = new Map((pods ?? []).map((pod) => [pod.name, pod]))
  return (event) => {
    if (event.kind !== 'Pod' || event.namespace !== namespace || event.reason !== 'Unhealthy') return false
    const pod = byName.get(event.name)
    const probe = PROBE_FAILURE.exec(event.message ?? '')?.[1]?.toLowerCase()
    if (!pod || !probe) return false
    if (pod.createdAt && Date.parse(event.timestamp) < Date.parse(pod.createdAt)) return false
    if (workloadPodStarting(pod, rolloutMoving)) return true
    return probe === 'startup' && pod.ready && !pod.restartCount
  }
}
