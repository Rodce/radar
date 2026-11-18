import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TimelineEvent, WorkloadPodInfo } from '../../types/core'
import { WorkloadView } from './WorkloadView'

// RollingUpdate with maxSurge 1: the old pod serves while the new one starts.
const rollingOut = {
  apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'api', namespace: 'shop', generation: 2 },
  spec: { replicas: 1, selector: { matchLabels: { app: 'api' } }, template: { metadata: { labels: { app: 'api' } }, spec: { containers: [{ name: 'app', image: 'api:2' }] } } },
  status: { observedGeneration: 2, replicas: 2, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1, unavailableReplicas: 1 },
}
const oldPod: WorkloadPodInfo = { name: 'api-old', containers: ['app'], ready: true, starting: false, healthLevel: 'healthy', phase: 'Running', updatedRevision: false }
const newPod: WorkloadPodInfo = { name: 'api-new', containers: ['app'], ready: false, starting: true, healthLevel: 'healthy', phase: 'Running', createdAt: '2026-11-18T12:00:00Z', updatedRevision: true }
const startupProbeFailed: TimelineEvent = {
  id: 'probe', timestamp: '2026-11-18T12:00:15Z', source: 'k8s_event', kind: 'Pod', namespace: 'shop', name: 'api-new',
  eventType: 'Warning', reason: 'Unhealthy', message: 'Startup probe failed: Get "http://10.0.0.7:8080/health/readiness": dial tcp 10.0.0.7:8080: connect: connection refused',
}

const render = (pods: WorkloadPodInfo[]) => renderToStaticMarkup(
  <WorkloadView kind="deployments" namespace="shop" name="api" group="apps" onBack={() => {}} resource={rollingOut} activeTab="overview"
    workloadPods={pods} resourceFocusedK8sEvents={[startupProbeFailed]} />,
)

describe('a pod starting mid-rollout', () => {
  it('reads as starting, and its failed startup probes as startup noise', () => {
    const html = render([oldPod, newPod])
    expect(html).toContain('1 starting')
    expect(html).not.toContain('need attention')
    expect(html).toMatch(/status-neutral">Starting</)
    expect(html).toContain('during startup')
  })

  it('stays loud once the new pod fails', () => {
    const html = render([oldPod, { ...newPod, starting: false, healthLevel: 'unhealthy', reason: 'CrashLoopBackOff', restartCount: 3 }])
    expect(html).toContain('1 need attention')
    expect(html).not.toContain('>Starting<')
    expect(html).not.toContain('during startup')
  })
})
