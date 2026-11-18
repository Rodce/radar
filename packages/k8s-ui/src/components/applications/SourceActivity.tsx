import { clsx } from 'clsx'
import { Tooltip } from '../ui/Tooltip'
import { StatusDotOrSpinner, type StatusTone } from '../ui/status-tone'
import { useNow } from '../../hooks/useNow'
import { formatElapsed, parseGoDuration } from '../../utils/format'
import { sourceActivityLabel, sourceInFlight, type AppSourceRef, type AppSourceStatus } from '../../utils/applications'

// SourceActivity says what an app's GitOps source is doing: Flux upgrading
// for 18s, Argo CD syncing, a reconcile requested, paused on purpose, or its
// sync and health verdict (a source that fails and keeps retrying shows the
// failure, never motion). In flight it spins and shimmers like the tree, and
// the time turns amber past half the controller's timeout. With
// onlyWhenNotable it stays out of the way of a settled source (list rows).
export function SourceActivity({
  source,
  status,
  onlyWhenNotable,
}: {
  source?: AppSourceRef | null
  status?: AppSourceStatus | null
  onlyWhenNotable?: boolean
}) {
  const moving = sourceInFlight(status)
  const now = useNow(moving && Boolean(status?.since))
  if (!source || source.type !== 'gitops' || !status) return null
  if (onlyWhenNotable && !moving && !status.suspended) return null
  const elapsed = moving && status.since ? now - Date.parse(status.since) : NaN
  const timeoutMs = parseGoDuration(status.timeout)
  const slow = Number.isFinite(elapsed) && timeoutMs !== undefined && elapsed > timeoutMs / 2
  const tool = source.tool === 'argocd' ? 'Argo CD' : source.tool === 'fluxcd' ? 'Flux' : 'GitOps'
  const note = [
    status.reconcileRequested && !status.reconciling ? 'Reconcile requested; waiting for the controller to pick it up' : '',
    status.message ?? '',
    moving && status.timeout ? `Timeout ${status.timeout}` : '',
  ].filter(Boolean).join(' · ')
  return (
    <Tooltip content={note || undefined} delay={150}>
      <span className="inline-flex min-w-0 items-center gap-1.5 text-xs">
        <StatusDotOrSpinner tone={sourceTone(status)} moving={moving} label="Delivery in progress" />
        <span className={clsx('truncate', moving ? 'inflight-shimmer' : 'text-theme-text-secondary')}>
          {tool}: {sourceActivityLabel(source, status)}
        </span>
        {Number.isFinite(elapsed) && elapsed >= 0 && (
          <span className={clsx('shrink-0 tabular-nums', slow ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-theme-text-tertiary')}>
            · {formatElapsed(elapsed)}{slow && timeoutMs ? ` of ${formatElapsed(timeoutMs)}` : ''}
          </span>
        )}
      </span>
    </Tooltip>
  )
}

function sourceTone(status: AppSourceStatus): StatusTone {
  if (sourceInFlight(status) || status.suspended) return 'neutral'
  const health = (status.health ?? '').toLowerCase()
  if (health === 'degraded' || health === 'missing') return 'unhealthy'
  if ((status.sync ?? '').toLowerCase() === 'outofsync') return 'degraded'
  if (health === 'healthy') return 'healthy'
  return 'unknown'
}
