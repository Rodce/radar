import { clsx } from 'clsx'
import { Loader2 } from 'lucide-react'
import { useNow } from '@skyhook-io/k8s-ui'
import {
  HELM_PENDING_STUCK_AFTER_MS,
  helmReleaseActivity,
  isHelmReleasePending,
  type HelmReleaseActivityInput,
} from '@skyhook-io/k8s-ui/utils/helm-status'
import type { HelmRelease } from '../../types'
import { getHelmStatusColor, SEVERITY_BADGE } from '../../utils/badge-colors'
import { Tooltip } from '../ui/Tooltip'

type StatusRelease = HelmReleaseActivityInput &
  Pick<HelmRelease, 'name' | 'namespace' | 'storageNamespace' | 'managedByFlux' | 'managedByFluxHelmRelease'>

const STUCK_AFTER = `${HELM_PENDING_STUCK_AFTER_MS / 60_000} minutes`

const OPERATION: Record<string, string> = {
  'pending-install': 'Install',
  'pending-upgrade': 'Upgrade',
  'pending-rollback': 'Rollback',
  uninstalling: 'Uninstall',
}

// HelmReleaseStatusBadge is a release's status as Helm states it, except while
// an operation holds the release: in flight it spins with the time the
// operation has run, turning amber past half the stuck threshold, and once
// stuck it turns red and says how to clear Helm's lock.
export function HelmReleaseStatusBadge({ release, className }: { release: StatusRelease; className?: string }) {
  const now = useNow(isHelmReleasePending(release.status))
  const activity = helmReleaseActivity(release, now)
  if (activity.stuck) {
    return (
      <Tooltip content={<StuckNote release={release} />}>
        <span className={clsx('badge', SEVERITY_BADGE.error, className)}>{activity.label}</span>
      </Tooltip>
    )
  }
  if (activity.moving) {
    const operation = OPERATION[release.status.toLowerCase()] ?? 'Helm operation'
    return (
      <Tooltip content={`${operation} in progress. If the release is still ${release.status} after ${STUCK_AFTER}, Radar marks it stuck.`}>
        <span className={clsx('badge tabular-nums', activity.slow ? SEVERITY_BADGE.warning : SEVERITY_BADGE.info, className)}>
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          {activity.label}
        </span>
      </Tooltip>
    )
  }
  return <span className={clsx('badge', getHelmStatusColor(release.status), className)}>{release.status}</span>
}

function StuckNote({ release }: { release: StatusRelease }) {
  const status = release.status.toLowerCase()
  // Helm's CLI finds a release by the namespace that stores it.
  const namespace = release.storageNamespace || release.namespace
  if (status === 'uninstalling') {
    return (
      <div className="max-w-xs">
        Helm has been uninstalling this release for over {STUCK_AFTER}. A pre-delete hook Job or a finalizer on one of its
        resources usually holds it: check its Hooks and any resources still Terminating, then retry the uninstall.
      </div>
    )
  }
  return (
    <div className="max-w-xs space-y-1.5">
      {release.lastOperation?.message && <p className="text-theme-text-secondary">{release.lastOperation.message}</p>}
      <p>
        Helm keeps a release {release.status} until the operation finishes, and refuses every upgrade meanwhile with
        “another operation (install/upgrade/rollback) is in progress”. Past {STUCK_AFTER}, whatever ran it (helm, a CI
        job, a controller) most likely stopped mid-way and left that lock behind.
      </p>
      {status === 'pending-install' ? (
        <p>
          A first install has no revision to roll back to: uninstall it (<code className="inline-code text-[11px]">helm uninstall {release.name} -n {namespace}</code>) and install again.
        </p>
      ) : (
        <p>
          Rolling back to the last deployed revision clears it: Rollback on the release’s History tab, or <code className="inline-code text-[11px]">helm rollback {release.name} &lt;revision&gt; -n {namespace}</code>.
        </p>
      )}
      {(release.managedByFlux || release.managedByFluxHelmRelease) && (
        <p>Flux manages this release: suspend its HelmRelease while you do this.</p>
      )}
    </div>
  )
}
