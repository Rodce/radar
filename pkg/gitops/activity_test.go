package gitops

import (
	"strconv"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func fluxObject(kind string, annotations map[string]string, status map[string]any) *unstructured.Unstructured {
	obj := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "helm.toolkit.fluxcd.io/v2", "kind": kind,
		"metadata": map[string]any{"name": "web", "namespace": "apps", "generation": int64(2)},
		"status":   status,
	}}
	obj.SetAnnotations(annotations)
	return obj
}

// A pass in flight is motion; a failure that keeps retrying, or a pause, is
// not, whatever Reconciling condition the object still carries.
func TestFluxInFlight(t *testing.T) {
	cases := map[string]struct {
		state FluxState
		want  bool
	}{
		"mid-pass":                    {FluxState{Sync: "Reconciling", Health: "Progressing", Reconciling: true}, true},
		"applied, pass running":       {FluxState{Sync: "Synced", Health: "Healthy", Reconciling: true}, true},
		"failing and retrying":        {FluxState{Sync: "OutOfSync", Health: "Degraded", Reconciling: true}, false},
		"suspended with stale status": {FluxState{Sync: "Synced", Health: "Suspended", Reconciling: true}, false},
		"waiting on a dependency":     {FluxState{Sync: "OutOfSync", Health: "Progressing"}, false},
		"settled":                     {FluxState{Sync: "Synced", Health: "Healthy"}, false},
	}
	for name, c := range cases {
		if got := FluxInFlight(c.state); got != c.want {
			t.Errorf("%s: in flight = %v, want %v", name, got, c.want)
		}
	}
}

// A requested reconcile is pending only on a kind that answers requests, only
// until it is answered, and only while the request is recent enough to still
// be coming.
func TestReconcileRequestPending(t *testing.T) {
	now := time.Date(2026, 11, 18, 1, 0, 0, 0, time.UTC)
	fresh := now.Add(-5 * time.Second).Format(time.RFC3339Nano)
	requested := func(kind, token, handled string) bool {
		status := map[string]any{}
		if handled != "" {
			status["lastHandledReconcileAt"] = handled
		}
		return fluxActivityAt(fluxObject(kind, map[string]string{"reconcile.fluxcd.io/requestedAt": token}, status), now).Requested
	}
	if !requested("HelmRelease", fresh, "") {
		t.Error("a fresh, unanswered request must be pending")
	}
	if !requested("Kustomization", strconv.FormatInt(now.Add(-5*time.Second).Unix(), 10), "") { // `date +%s`
		t.Error("an epoch-seconds token must be read")
	}
	if requested("HelmRelease", fresh, fresh) {
		t.Error("an answered request is not pending")
	}
	if requested("HelmRelease", now.Add(-time.Hour).Format(time.RFC3339Nano), "") {
		t.Error("a request nobody answered for an hour is not coming")
	}
	if requested("Alert", fresh, "") {
		t.Error("a kind that never answers requests has none pending")
	}
	if requested("HelmRelease", "please", "") {
		t.Error("a token that can't be dated can't be bounded")
	}
}

// Radar's suspension is the annotations with auto-sync still off.
func TestArgoSuspendedByRadar(t *testing.T) {
	app := func(automated bool) *unstructured.Unstructured {
		spec := map[string]any{}
		if automated {
			spec["syncPolicy"] = map[string]any{"automated": map[string]any{}}
		}
		obj := &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
			"metadata": map[string]any{"name": "shop", "namespace": "argocd"},
			"spec":     spec,
		}}
		obj.SetAnnotations(map[string]string{ArgoSuspendedAutomatedAnnotation: "{}"})
		return obj
	}
	if !ArgoSuspendedByRadar(app(false)) {
		t.Error("annotations with auto-sync off must read suspended")
	}
	if ArgoSuspendedByRadar(app(true)) {
		t.Error("auto-sync turned back on outside Radar is not suspended")
	}
}
