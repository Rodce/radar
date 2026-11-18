package gitops

import (
	"strconv"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// FluxActivityState is what a Flux object's controller is doing right now,
// beyond its sync and health verdict: since when a pass has been running, the
// timeout it works against, a requested reconcile the controller hasn't
// picked up yet, and its own message while it works or fails.
type FluxActivityState struct {
	// Since is the Reconciling=True condition's transition: when the pass
	// in flight began. Empty when none is running.
	Since string
	// Timeout is spec.timeout as written ("10m"); empty when unset.
	Timeout string
	// Requested reports a reconcile.fluxcd.io/requestedAt the controller has
	// not answered yet: the moment after a Reconcile click, or a controller
	// working through a queue.
	Requested bool
	// Message is the Ready condition's message while Ready isn't True:
	// "Running 'upgrade' action with timeout of 10m0s", or a failure.
	Message string
}

// FluxInFlight reports a Flux object its controller is working on now without
// having reported a failure. A failed object keeps Reconciling=True for as
// long as it retries, which can be forever; there the failure is the news and
// motion would dress it up as progress. A suspended one isn't worked on at
// all, whatever condition it still carries.
func FluxInFlight(state FluxState) bool {
	if state.Health == "Suspended" || state.Health == "Degraded" {
		return false
	}
	return state.Sync == "Reconciling" || state.Reconciling
}

// reconcileRequestKinds are the kinds whose controllers answer a
// reconcile.fluxcd.io/requestedAt annotation by copying it to
// status.lastHandledReconcileAt. The rest (Alert, Provider, ExternalArtifact)
// never do, so an annotation left on one would read as pending forever.
var reconcileRequestKinds = map[string]bool{
	"Kustomization":  true,
	"HelmRelease":    true,
	"GitRepository":  true,
	"OCIRepository":  true,
	"HelmRepository": true,
	"HelmChart":      true,
	"Bucket":         true,
	"Receiver":       true,
}

// reconcileRequestWindow bounds how long an unanswered request counts as
// pending. A controller that is running picks one up within seconds; past
// this it is not coming, and a spinner would claim otherwise.
const reconcileRequestWindow = 10 * time.Minute

// FluxActivity reads FluxActivityState from a Flux object. Shared by the
// GitOps tree, the topology graph and the Applications view so all three say
// the same thing.
func FluxActivity(obj *unstructured.Unstructured) FluxActivityState {
	return fluxActivityAt(obj, time.Now())
}

func fluxActivityAt(obj *unstructured.Unstructured, now time.Time) FluxActivityState {
	var state FluxActivityState
	if obj == nil {
		return state
	}
	for _, c := range fluxConditions(obj) {
		switch c.typ {
		case "Reconciling":
			if c.status == "True" {
				state.Since = c.lastTransitionTime
			}
		case "Ready":
			if c.status != "True" {
				state.Message = c.message
			}
		}
	}
	state.Timeout, _, _ = unstructured.NestedString(obj.Object, "spec", "timeout")
	state.Requested = reconcileRequestPending(obj, now)
	return state
}

func reconcileRequestPending(obj *unstructured.Unstructured, now time.Time) bool {
	requested := obj.GetAnnotations()["reconcile.fluxcd.io/requestedAt"]
	if requested == "" || !reconcileRequestKinds[obj.GetKind()] {
		return false
	}
	if handled, _, _ := unstructured.NestedString(obj.Object, "status", "lastHandledReconcileAt"); handled == requested {
		return false
	}
	at, ok := reconcileRequestTime(requested)
	return ok && now.Sub(at) < reconcileRequestWindow
}

// reconcileRequestTime reads when a request was made from its token. Flux
// treats the value as opaque; its CLI and Radar write an RFC 3339 time and its
// docs use `date +%s`. Any other token can't be dated, so it can't be bounded
// and is not read as pending.
func reconcileRequestTime(token string) (time.Time, bool) {
	if at, err := time.Parse(time.RFC3339Nano, token); err == nil {
		return at, true
	}
	if seconds, err := strconv.ParseInt(token, 10, 64); err == nil && seconds > 0 {
		return time.Unix(seconds, 0), true
	}
	return time.Time{}, false
}

// ArgoSuspendedByRadar reports an Application Radar suspended and that still
// is: auto-sync off, with the prior policy kept in annotations (current or
// legacy keys). The annotations alone don't say it: auto-sync turned back on
// outside Radar (a parent app-of-apps restoring the policy) leaves them
// behind. Its health stays whatever its resources report, never "Suspended".
func ArgoSuspendedByRadar(obj *unstructured.Unstructured) bool {
	if obj == nil || ArgoAutoSyncEnabled(obj) {
		return false
	}
	annotations := obj.GetAnnotations()
	for _, key := range []string{ArgoSuspendedAutomatedAnnotation, ArgoSuspendedPruneAnnotation, ArgoSuspendedSelfHealAnnotation, legacyArgoSuspendedPruneAnnotation, legacyArgoSuspendedSelfHealAnnotation} {
		if _, ok := annotations[key]; ok {
			return true
		}
	}
	return false
}

// ArgoOperationInProgress matches the detail page's reading of an Argo CD
// Application: an operation requested, or one Argo is still running.
func ArgoOperationInProgress(obj *unstructured.Unstructured) bool {
	if obj == nil || ToolOf(obj) != ToolArgoCD || obj.GetKind() != "Application" {
		return false
	}
	if op, ok := obj.Object["operation"]; ok && op != nil {
		return true
	}
	phase, _, _ := unstructured.NestedString(obj.Object, "status", "operationState", "phase")
	return phase == "Running" || phase == "Terminating"
}
