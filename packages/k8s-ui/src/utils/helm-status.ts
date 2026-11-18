import type { HelmRelease, HelmReleaseDetail } from '../types/core'
import { formatElapsed } from './format'
import { formatDuration } from '../components/resources/resource-utils'

// The threshold pkg/helmhistory uses for stuck_pending, so the badge and
// Radar's own verdict agree. Helm doesn't record the --timeout an operation ran
// with, so there is no per-release timeout to prefer.
export const HELM_PENDING_STUCK_AFTER_MS = 10 * 60_000

const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set([
  'pending-install',
  'pending-upgrade',
  'pending-rollback',
  'uninstalling',
])

// An install, upgrade, rollback or uninstall holds the release while Helm
// records one of these.
export function isHelmReleasePending(status: string | null | undefined): boolean {
  return Boolean(status && IN_FLIGHT_STATUSES.has(status.toLowerCase()))
}

export type HelmReleaseActivityInput = Pick<HelmRelease, 'status' | 'updated' | 'lastOperation'> &
  Partial<Pick<HelmReleaseDetail, 'history' | 'revision'>>

export interface HelmReleaseActivity {
  moving: boolean
  // Past half the threshold: the elapsed time turns amber before it's stuck.
  slow: boolean
  stuck: boolean
  label: string
}

// helmReleaseActivity is the rule every Helm status badge turns on. A fresh
// pending-* or uninstalling is work in flight. One still held past the
// threshold is the stuck lock: whatever ran the operation stopped mid-way, and
// Helm refuses every upgrade until someone clears it. With no start time it is
// neither, since the two can't be told apart, and the badge reads as Helm
// states it. Radar's own stuck verdict from its last read wins over the
// browser's clock.
export function helmReleaseActivity(release: HelmReleaseActivityInput, now: number): HelmReleaseActivity {
  const status = release.status
  if (!isHelmReleasePending(status)) return { moving: false, slow: false, stuck: false, label: status }
  const flagged = release.lastOperation?.status === 'stuck_pending'
  const started = timestamp(flagged ? release.lastOperation?.updated : operationStart(release))
  const elapsed = started === undefined ? undefined : now - started
  // A start a little in the browser's future (clock skew) has no time to show.
  const shown = elapsed !== undefined && elapsed >= 0 ? elapsed : undefined
  if (flagged || (elapsed !== undefined && elapsed >= HELM_PENDING_STUCK_AFTER_MS)) {
    return { moving: false, slow: false, stuck: true, label: `Stuck: ${status}${shown === undefined ? '' : ` · ${formatDuration(shown)}`}` }
  }
  if (elapsed === undefined) return { moving: false, slow: false, stuck: false, label: status }
  return {
    moving: true,
    slow: elapsed > HELM_PENDING_STUCK_AFTER_MS / 2,
    stuck: false,
    label: shown === undefined ? status : `${status} · ${formatElapsed(shown)}`,
  }
}

// Helm stamps LastDeployed when an install, upgrade or rollback starts. An
// uninstall keeps the last deployment's and stamps Deleted instead, which only
// the release detail's history carries.
function operationStart(release: HelmReleaseActivityInput): string | undefined {
  if (release.status.toLowerCase() !== 'uninstalling') return release.updated
  return release.history?.find((revision) => revision.revision === release.revision)?.deleted
}

// An unset Go time arrives as 0001-01-01T00:00:00Z, which parses.
function timestamp(value: string | undefined): number | undefined {
  const ms = value ? Date.parse(value) : NaN
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}
