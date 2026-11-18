import { describe, expect, it } from 'vitest'
import { applicationsPollInterval, rolloutSummaryAwaitsAction, rolloutSummaryForApps, sourceActivityLabel, sourceInFlight, type AppRow } from './applications'
import { rolloutAwaitsAction } from './workload-rollout'

const flux = { tool: 'fluxcd', kind: 'HelmRelease' }

describe('sourceActivityLabel', () => {
  it("names a Flux pass by the controller's own words", () => {
    expect(sourceActivityLabel(flux, { reconciling: true, message: "Running 'upgrade' action with timeout of 10m0s" })).toBe('Upgrading')
    expect(sourceActivityLabel(flux, { reconciling: true, message: "Running 'install' action with timeout of 5m0s" })).toBe('Installing')
    expect(sourceActivityLabel(flux, { reconciling: true })).toBe('Reconciling')
    expect(sourceActivityLabel({ tool: 'fluxcd', kind: 'Kustomization' }, { reconciling: true })).toBe('Applying')
  })

  it('names an Argo CD operation, a pending request, a pause and a settled source', () => {
    expect(sourceActivityLabel({ tool: 'argocd', kind: 'Application' }, { reconciling: true })).toBe('Syncing')
    expect(sourceActivityLabel(flux, { reconcileRequested: true, sync: 'Synced', health: 'Healthy' })).toBe('Reconcile requested')
    expect(sourceActivityLabel(flux, { suspended: true, reconcileRequested: true })).toBe('Suspended')
    expect(sourceActivityLabel({ tool: 'argocd', kind: 'Application' }, { suspended: true, reconciling: true })).toBe('Syncing')
    expect(sourceActivityLabel(flux, { sync: 'OutOfSync', health: 'Degraded', message: 'chart not found' })).toBe('OutOfSync · Degraded')
    expect(sourceActivityLabel(flux, { sync: 'Synced', health: 'Healthy' })).toBe('Synced · Healthy')
  })
})

describe('sourceInFlight', () => {
  it('is work running or about to run, never a pause', () => {
    expect(sourceInFlight({ reconciling: true })).toBe(true)
    expect(sourceInFlight({ reconcileRequested: true })).toBe(true)
    expect(sourceInFlight({ suspended: true, reconcileRequested: true })).toBe(false)
    expect(sourceInFlight({ suspended: true, reconciling: true })).toBe(true)
    expect(sourceInFlight({ sync: 'Synced', health: 'Healthy' })).toBe(false)
    expect(sourceInFlight(undefined)).toBe(false)
  })
})

describe('applicationsPollInterval', () => {
  const now = Date.parse('2026-11-18T01:00:00Z')
  const app = (extra: Record<string, unknown>) => ({ key: 'a', name: 'a', workloads: [], ...extra }) as unknown as AppRow

  it('polls fast for a fresh delivery, slower for a rollout, and not for a settled list', () => {
    expect(applicationsPollInterval([app({ sourceStatus: { reconciling: true, since: '2026-11-18T00:59:30Z' } })], now)).toBe(2000)
    expect(applicationsPollInterval([app({ sourceStatus: { reconcileRequested: true } })], now)).toBe(2000)
    expect(applicationsPollInterval([app({ workloads: [{ rollout: { active: true, phase: 'progressing' } }] })], now)).toBe(5000)
    expect(applicationsPollInterval([app({ sourceStatus: { suspended: true } }), app({ workloads: [{ rollout: { active: false, phase: 'stalled' } }] })], now)).toBeUndefined()
    expect(applicationsPollInterval(undefined, now)).toBeUndefined()
  })

  it('backs off for a delivery that has run for minutes', () => {
    expect(applicationsPollInterval([app({ sourceStatus: { reconciling: true, since: '2026-11-17T22:00:00Z' } })], now)).toBe(10_000)
  })

  // A Flux spec its controller has not picked up reads as reconciling with no
  // start; with the controller down it stays that way for as long as the
  // page is open.
  it('backs off for a delivery whose start is unknown', () => {
    expect(applicationsPollInterval([app({ sourceStatus: { reconciling: true } })], now)).toBe(10_000)
    expect(applicationsPollInterval([app({ sourceStatus: { reconciling: true, since: 'not a time' } })], now)).toBe(10_000)
  })
})

describe('rollouts that wait on a person', () => {
  const workload = (name: string, rollout: Record<string, unknown>) => ({
    kind: 'Rollout', group: 'argoproj.io', namespace: 'apps', name, health: 'healthy', ready: 4, desired: 4, restarts: 0,
    rollout: { desired: 4, updated: 1, ready: 4, available: 4, detail: '', ...rollout },
  })
  const row = (...workloads: ReturnType<typeof workload>[]) => ({ key: 'apps/web', name: 'web', namespace: 'apps', health: 'healthy', workloads }) as unknown as AppRow
  const parked = { phase: 'paused', active: true, manual: true, label: 'Waiting for promotion' }
  const moving = { phase: 'progressing', active: true, manual: false, label: 'Rolling out' }

  it('is a rollout that will not move until someone acts', () => {
    expect(rolloutAwaitsAction({ active: true, manual: true })).toBe(true)
    expect(rolloutAwaitsAction({ active: true, manual: false })).toBe(false)
    expect(rolloutAwaitsAction({ active: false, manual: true })).toBe(false)
    expect(rolloutAwaitsAction(undefined)).toBe(false)
  })

  it('names the workloads a row waits on, so the list can offer the action for exactly one', () => {
    expect(rolloutSummaryForApps([row(workload('web', parked))])?.awaiting.map((w) => w.name)).toEqual(['web'])
    expect(rolloutSummaryForApps([row(workload('web', parked), workload('api', parked))])?.awaiting.map((w) => w.name)).toEqual(['web', 'api'])
    expect(rolloutSummaryForApps([row(workload('web', moving))])?.awaiting).toEqual([])
  })

  it('reads as waiting only when nothing in the row is worse', () => {
    const stalled = { phase: 'stalled', active: false, manual: false, label: 'New revision cannot start' }
    expect(rolloutSummaryAwaitsAction(rolloutSummaryForApps([row(workload('web', parked))]))).toBe(true)
    expect(rolloutSummaryAwaitsAction(rolloutSummaryForApps([row(workload('web', parked), workload('api', stalled))]))).toBe(false)
    expect(rolloutSummaryAwaitsAction(rolloutSummaryForApps([row(workload('web', parked), workload('api', moving))]))).toBe(false)
  })

  it('leaves a workload waiting for its Pods to be deleted out: an operator may be doing that', () => {
    const onDelete = { ...workload('db', { phase: 'waiting', active: true, manual: true, label: 'Waiting for Pod restart' }), kind: 'StatefulSet', group: 'apps' }
    expect(rolloutSummaryForApps([row(onDelete)])?.awaiting).toEqual([])
  })

  it('does not poll a row that only waits: nothing changes until someone acts', () => {
    expect(applicationsPollInterval([row(workload('web', parked))], Date.now())).toBeUndefined()
  })
})
