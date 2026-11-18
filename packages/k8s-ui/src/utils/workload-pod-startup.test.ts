import { describe, expect, it } from 'vitest'
import type { TimelineEvent, WorkloadPodInfo } from '../types/core'
import { podReadinessDetail, startupProbeNoise, summarizeWorkloadPodReadiness, workloadPodStarting } from './workload-pod-startup'

const pod = (name: string, extra: Partial<WorkloadPodInfo> = {}): WorkloadPodInfo => ({
  name, containers: ['app'], ready: false, healthLevel: 'healthy', createdAt: '2026-11-18T12:00:00Z', ...extra,
})
const serving = pod('api-old', { ready: true, starting: false })
const starting = pod('api-new', { starting: true })
const crashlooping = pod('api-crash', { healthLevel: 'unhealthy', reason: 'CrashLoopBackOff', restartCount: 4, starting: false })
// Past its probes' startup budget: still inside the server's five-minute grace, so it grades healthy.
const late = pod('api-late', { starting: false })

const unhealthy = (podName: string, message: string, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id: `${podName}-${message}`, timestamp: '2026-11-18T12:00:20Z', source: 'k8s_event', kind: 'Pod', namespace: 'shop', name: podName,
  eventType: 'Warning', reason: 'Unhealthy', message, ...extra,
})
const startupProbeFailed = 'Startup probe failed: Get "http://10.0.0.7:8080/health/readiness": dial tcp 10.0.0.7:8080: connect: connection refused'

describe('workloadPodStarting', () => {
  it('takes the server at its word', () => {
    expect(workloadPodStarting(starting)).toBe(true)
    expect(workloadPodStarting(late)).toBe(false)
    expect(workloadPodStarting(late, true)).toBe(false)
  })

  it('never calls a ready pod or a problem verdict starting', () => {
    expect(workloadPodStarting({ ...starting, ready: true })).toBe(false)
    for (const healthLevel of ['degraded', 'unhealthy', 'unknown'] as const) {
      expect(workloadPodStarting({ ...starting, healthLevel })).toBe(false)
    }
  })

  it('leans on a moving rollout when the server predates the signal', () => {
    const newRevision = pod('api-new', { updatedRevision: true })
    expect(workloadPodStarting(newRevision, true)).toBe(true)
    expect(workloadPodStarting(newRevision, false)).toBe(false)
    expect(workloadPodStarting({ ...newRevision, restartCount: 1 }, true)).toBe(false)
    expect(workloadPodStarting({ ...newRevision, updatedRevision: false }, true)).toBe(false)
  })
})

describe('pod readiness detail', () => {
  const detail = (pods: WorkloadPodInfo[]) => podReadinessDetail(summarizeWorkloadPodReadiness(pods), 'all ready')

  it('reads a pod coming up mid-rollout as starting, not as a problem', () => {
    expect(summarizeWorkloadPodReadiness([serving, starting])).toEqual({ ready: 1, total: 2, starting: 1, attention: 0 })
    expect(detail([serving, starting])).toBe('1 starting')
  })

  it('keeps real failures and late pods loud, ahead of the starting ones', () => {
    expect(detail([serving, starting, crashlooping])).toBe('1 need attention · 1 starting')
    expect(detail([serving, late])).toBe('1 need attention')
    expect(detail([serving])).toBe('all ready')
  })
})

describe('startupProbeNoise', () => {
  const noise = (pods: WorkloadPodInfo[]) => startupProbeNoise(pods, 'shop')

  it('mutes failed startup and readiness probes of a starting pod', () => {
    const isNoise = noise([serving, starting])
    expect(isNoise(unhealthy('api-new', startupProbeFailed))).toBe(true)
    expect(isNoise(unhealthy('api-new', 'Readiness probe failed: HTTP probe failed with statuscode: 503'))).toBe(true)
  })

  it('keeps liveness failures and pods that need attention loud', () => {
    expect(noise([starting])(unhealthy('api-new', 'Liveness probe failed: connection refused'))).toBe(false)
    expect(noise([crashlooping])(unhealthy('api-crash', startupProbeFailed))).toBe(false)
    expect(noise([late])(unhealthy('api-late', 'Readiness probe failed: HTTP probe failed with statuscode: 503'))).toBe(false)
  })

  it('keeps a failed startup probe muted once the pod is ready without a restart', () => {
    const started = pod('api-new', { ready: true, starting: false })
    expect(noise([started])(unhealthy('api-new', startupProbeFailed))).toBe(true)
    expect(noise([started])(unhealthy('api-new', 'Readiness probe failed: HTTP probe failed with statuscode: 503'))).toBe(false)
    expect(noise([{ ...started, restartCount: 1 }])(unhealthy('api-new', startupProbeFailed))).toBe(false)
  })

  it('only matches the pod the event is about, since it was created', () => {
    const isNoise = noise([starting])
    expect(isNoise(unhealthy('api-new', startupProbeFailed, { timestamp: '2026-11-18T11:58:00Z' }))).toBe(false)
    expect(isNoise(unhealthy('api-new', startupProbeFailed, { namespace: 'other' }))).toBe(false)
    expect(isNoise(unhealthy('api-gone', startupProbeFailed))).toBe(false)
    expect(isNoise(unhealthy('api-new', startupProbeFailed, { kind: 'Deployment' }))).toBe(false)
    expect(isNoise(unhealthy('api-new', startupProbeFailed, { reason: 'BackOff' }))).toBe(false)
  })
})
