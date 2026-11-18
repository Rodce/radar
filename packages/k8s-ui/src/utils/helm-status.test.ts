import { describe, it, expect } from 'vitest'
import { isHelmReleaseActionable } from './badge-colors'
import { HELM_PENDING_STUCK_AFTER_MS, helmReleaseActivity, type HelmReleaseActivityInput } from './helm-status'

// Pin the membership set so adding a new Helm status becomes a
// deliberate decision here.

describe('isHelmReleaseActionable', () => {
  it('returns true for `failed`', () => {
    expect(isHelmReleaseActionable('failed')).toBe(true)
  })

  it('is case-insensitive (matches Helm SDK serialisation variants)', () => {
    expect(isHelmReleaseActionable('FAILED')).toBe(true)
    expect(isHelmReleaseActionable('Failed')).toBe(true)
  })

  it('returns FALSE for the pending-* in-flight statuses', () => {
    // These are Helm's NORMAL in-flight states during every
    // routine install/upgrade/rollback. If we treated them as
    // actionable, every routine install would briefly attach an
    // alarming chevron + tooltip to its own row. Telling
    // "transient" from "stuck > N min" takes the release's age,
    // which a status alone doesn't carry: helmReleaseActivity
    // makes that call where the age is known.
    expect(isHelmReleaseActionable('pending-install')).toBe(false)
    expect(isHelmReleaseActionable('pending-upgrade')).toBe(false)
    expect(isHelmReleaseActionable('pending-rollback')).toBe(false)
  })

  it('returns false for the success / normal statuses', () => {
    expect(isHelmReleaseActionable('deployed')).toBe(false)
    expect(isHelmReleaseActionable('superseded')).toBe(false)
    expect(isHelmReleaseActionable('uninstalled')).toBe(false)
  })

  it('returns false for `uninstalling` (in-progress, not stuck)', () => {
    expect(isHelmReleaseActionable('uninstalling')).toBe(false)
  })

  it('returns false for null / undefined / empty', () => {
    expect(isHelmReleaseActionable(null)).toBe(false)
    expect(isHelmReleaseActionable(undefined)).toBe(false)
    expect(isHelmReleaseActionable('')).toBe(false)
  })

  it('returns false for unknown strings (defensive)', () => {
    expect(isHelmReleaseActionable('mystery-status')).toBe(false)
    expect(isHelmReleaseActionable('error')).toBe(false) // Helm uses 'failed', not 'error'
  })
})

describe('helmReleaseActivity', () => {
  const now = Date.parse('2026-11-18T12:00:00Z')
  const ago = (ms: number) => new Date(now - ms).toISOString()
  const MONTH = 30 * 24 * 3_600_000
  const release = (status: string, updated: string, extra: Partial<HelmReleaseActivityInput> = {}): HelmReleaseActivityInput => ({ status, updated, ...extra })
  const stuckVerdict = { kind: 'pending', status: 'stuck_pending', source: 'helm_status', confidence: 'high', message: '' } as const

  it('spins a fresh pending operation, with the time it has run', () => {
    expect(helmReleaseActivity(release('pending-upgrade', ago(18_000)), now)).toEqual({ moving: true, slow: false, stuck: false, label: 'pending-upgrade · 18s' })
    // A start in the browser's future (clock skew) still spins, without a time.
    expect(helmReleaseActivity(release('pending-upgrade', ago(-5_000)), now)).toMatchObject({ moving: true, label: 'pending-upgrade' })
  })

  it('turns slow past half the threshold, before it is stuck', () => {
    expect(helmReleaseActivity(release('pending-install', ago(6 * 60_000)), now)).toEqual({ moving: true, slow: true, stuck: false, label: 'pending-install · 6m 00s' })
  })

  it('calls an operation still held at the threshold stuck', () => {
    expect(helmReleaseActivity(release('pending-upgrade', ago(23 * 60_000)), now)).toEqual({ moving: false, slow: false, stuck: true, label: 'Stuck: pending-upgrade · 23m' })
    expect(helmReleaseActivity(release('pending-rollback', ago(HELM_PENDING_STUCK_AFTER_MS)), now).stuck).toBe(true)
  })

  it('leaves settled statuses as Helm states them, however old', () => {
    for (const status of ['deployed', 'failed', 'superseded', 'uninstalled']) {
      expect(helmReleaseActivity(release(status, ago(MONTH)), now)).toEqual({ moving: false, slow: false, stuck: false, label: status })
    }
  })

  it('times an uninstall from when it began, not from the last deployment', () => {
    const history = [{ revision: 3, status: 'uninstalling', chart: 'web-1.0.0', appVersion: '1.0', description: 'Deletion in progress', updated: ago(MONTH), deleted: ago(30_000) }]
    expect(helmReleaseActivity(release('uninstalling', ago(MONTH), { revision: 3, history }), now)).toMatchObject({ moving: true, stuck: false, label: 'uninstalling · 30s' })
    // A list row carries no uninstall start until Radar flags it stuck.
    expect(helmReleaseActivity(release('uninstalling', ago(MONTH)), now)).toEqual({ moving: false, slow: false, stuck: false, label: 'uninstalling' })
    expect(helmReleaseActivity(release('uninstalling', ago(MONTH), { lastOperation: { ...stuckVerdict, updated: ago(42 * 60_000) } }), now).label).toBe('Stuck: uninstalling · 42m')
  })

  it("keeps Radar's stuck verdict when the browser's clock says fresh", () => {
    expect(helmReleaseActivity(release('pending-upgrade', ago(60_000), { lastOperation: { ...stuckVerdict, updated: ago(-60_000) } }), now)).toEqual({ moving: false, slow: false, stuck: true, label: 'Stuck: pending-upgrade' })
  })

  it('makes no claim without a start time', () => {
    for (const updated of ['', '0001-01-01T00:00:00Z', 'not a time']) {
      expect(helmReleaseActivity(release('pending-upgrade', updated), now)).toEqual({ moving: false, slow: false, stuck: false, label: 'pending-upgrade' })
    }
  })
})
