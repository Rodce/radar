import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, GitCommit, Pause, Play, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { AppRow, AppSourceRef } from "@skyhook-io/k8s-ui";
import { GitOpsActionButton } from "@skyhook-io/k8s-ui/components/gitops/GitOpsDetailLayout";
import {
  useArgoRefresh,
  useFluxReconcile,
  useFluxResume,
  useFluxSuspend,
  useFluxSyncWithSource,
} from "../../api/client";
import { kindToPluralWithGroup } from "../../utils/navigation";
import { Tooltip } from "../ui/Tooltip";

// AppSourceActions puts the delivery controls of an app's GitOps source on the
// application page, the same buttons and wording as the source's own GitOps
// page.
//
// Flux gets them all: Reconcile, Sync with source, Suspend or Resume. Argo CD
// gets Refresh and a way to its GitOps page: Sync there is a choice of
// revision, prune and options, and Suspend/Resume depend on how auto-sync is
// set up and on what the server supports, all of which that page already
// handles. A native Helm release, or an app grouped by labels with no source,
// gets none: there is no GitOps controller to tell anything, and the
// Deployment source panel still links to what there is.
export function AppSourceActions({
  app,
  onOpenSource,
}: {
  app: AppRow;
  onOpenSource?: (source: AppSourceRef) => void;
}) {
  const queryClient = useQueryClient();
  const fluxReconcile = useFluxReconcile();
  const fluxSyncWithSource = useFluxSyncWithSource();
  const fluxSuspend = useFluxSuspend();
  const fluxResume = useFluxResume();
  const argoRefresh = useArgoRefresh();

  const source = app.sourceRef;
  if (!source || source.type !== "gitops") return null;
  const { namespace, name } = source;
  const suspended = app.sourceStatus?.suspended === true;
  // The app row carries the source's live state; refetch it so the page
  // answers the click instead of waiting for its next minute-long poll. Radar's
  // informers see the change a moment after the API call returns, so the first
  // refetch can still read the old state: catch up again, as the GitOps list
  // does after its own actions.
  const refetchApps = () => queryClient.invalidateQueries({ queryKey: ["applications"] });
  const settle = {
    onSuccess: () => {
      refetchApps();
      window.setTimeout(refetchApps, 1200);
      window.setTimeout(refetchApps, 3000);
    },
  };
  const group = (tool: string, children: ReactNode) => (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-theme-border px-1.5 py-1">
      <Tooltip content={`These act on ${source.kind} ${namespace}/${name}, the source that delivers this application.`} delay={150}>
        <span className="cursor-help px-1 text-[10px] font-semibold uppercase tracking-wide text-theme-text-tertiary">{tool}</span>
      </Tooltip>
      {children}
    </div>
  );

  if (source.tool === "fluxcd") {
    const kind = kindToPluralWithGroup(source.kind, source.group ?? "");
    return group(
      "Flux",
      <>
        <GitOpsActionButton
          label="Reconcile"
          description="Tell Flux to reconcile this resource now: re-read its source, re-apply the manifests, update status. Skips waiting for the regular reconciliation interval."
          icon={RefreshCw}
          loading={fluxReconcile.isPending}
          onClick={() => fluxReconcile.mutate({ kind, namespace, name }, settle)}
          disabled={suspended}
          disabledReason={suspended ? "Suspended: resume first, Flux skips a suspended object." : undefined}
        />
        <GitOpsActionButton
          label="Sync with source"
          description="Reconcile the upstream source CR (GitRepository/HelmRepository) first — re-fetching from Git or Helm — then reconcile this resource against the refreshed source."
          icon={GitCommit}
          loading={fluxSyncWithSource.isPending}
          onClick={() => fluxSyncWithSource.mutate({ kind, namespace, name }, settle)}
        />
        {suspended ? (
          <GitOpsActionButton
            label="Resume"
            description="Resume Flux reconciliation. Flux will start applying changes from the source again on its normal interval."
            icon={Play}
            loading={fluxResume.isPending}
            onClick={() => fluxResume.mutate({ kind, namespace, name }, settle)}
          />
        ) : (
          <GitOpsActionButton
            label="Suspend"
            description="Pause Flux reconciliation. The resource stays exactly as-is — new commits in the source won't be applied until you resume."
            icon={Pause}
            loading={fluxSuspend.isPending}
            onClick={() => fluxSuspend.mutate({ kind, namespace, name }, settle)}
          />
        )}
      </>,
    );
  }

  if (source.tool === "argocd") {
    return group(
      "Argo CD",
      <>
        <GitOpsActionButton
          label="Refresh"
          description="Ask Argo CD to compare the live state with Git again now, without syncing."
          icon={RefreshCw}
          loading={argoRefresh.isPending}
          onClick={() => argoRefresh.mutate({ namespace, name, hard: false }, settle)}
        />
        {onOpenSource && (
          <GitOpsActionButton
            label="Sync and auto-sync…"
            description="Open the Application's GitOps page: syncing takes a revision, prune and sync options, and suspending or resuming auto-sync depends on how it is set up."
            icon={ExternalLink}
            onClick={() => onOpenSource(source)}
          />
        )}
      </>,
    );
  }
  return null;
}
