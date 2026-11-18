package server

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

type kindLister map[string][]*unstructured.Unstructured

func (l kindLister) ListDynamicWithGroup(_ context.Context, kind, _, group string) ([]*unstructured.Unstructured, error) {
	return l[group+"/"+kind], nil
}

func fluxRelease(name string, spec map[string]any, status map[string]any) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "helm.toolkit.fluxcd.io/v2", "kind": "HelmRelease",
		"metadata": map[string]any{"name": name, "namespace": "apps", "generation": int64(3)},
		"spec":     spec, "status": status,
	}}
}

func releaseRow(name, runtime string) appRow {
	return appRow{RuntimeHealth: runtime, Health: runtime, SourceRef: &appSourceRef{Type: "gitops", Tool: "fluxcd", Group: "helm.toolkit.fluxcd.io", Kind: "HelmRelease", Namespace: "apps", Name: name}}
}

func fluxCond(typ, status, reason, message, at string) map[string]any {
	return map[string]any{"type": typ, "status": status, "reason": reason, "message": message, "lastTransitionTime": at, "observedGeneration": int64(3)}
}

func fluxReleases() kindLister {
	observed := func(conditions ...any) map[string]any {
		return map[string]any{"observedGeneration": int64(3), "conditions": conditions}
	}
	return kindLister{"helm.toolkit.fluxcd.io/HelmRelease": {
		fluxRelease("settled", nil, observed(fluxCond("Ready", "True", "UpgradeSucceeded", "", ""))),
		fluxRelease("paused", map[string]any{"suspend": true}, observed(fluxCond("Ready", "True", "UpgradeSucceeded", "", ""))),
		fluxRelease("upgrading", map[string]any{"timeout": "10m"}, observed(
			fluxCond("Ready", "Unknown", "Progressing", "Running 'upgrade' action with timeout of 10m0s", "2026-11-18T00:00:01Z"),
			fluxCond("Reconciling", "True", "Progressing", "", "2026-11-18T00:00:00Z"),
		)),
		fluxRelease("failing", nil, observed(
			fluxCond("Ready", "False", "InstallFailed", "chart not found", "2026-11-17T18:00:00Z"),
			fluxCond("Reconciling", "True", "ProgressingWithRetry", "", "2026-11-17T18:00:00Z"),
		)),
	}}
}

// A Flux-delivered app says what its HelmRelease is doing, read live: paused,
// or mid-upgrade with since-when and the controller's words. A source that
// fails and keeps retrying shows its failure, not motion; a settled one says
// nothing; a native Helm app gets nothing of the kind.
func TestLiveSourceActivityForFlux(t *testing.T) {
	native := appRow{RuntimeHealth: "healthy", Health: "healthy", SourceRef: &appSourceRef{Type: "helm", Tool: "helm", Kind: "HelmRelease", Namespace: "apps", Name: "upgrading"}}
	shared := []appRow{releaseRow("settled", "neutral"), releaseRow("paused", "healthy"), releaseRow("upgrading", "healthy"), releaseRow("failing", "healthy"), native}
	got := withLiveSourceActivity(context.Background(), fluxReleases(), shared)

	if got[0].SourceStatus != nil || got[0].Health != "neutral" {
		t.Fatalf("a settled source must leave an idle app as it is: %+v health=%s", got[0].SourceStatus, got[0].Health)
	}
	if s := got[1].SourceStatus; s == nil || !s.Suspended || s.Health != "Suspended" || s.Reconciling {
		t.Fatalf("paused: %+v", s)
	}
	if s := got[2].SourceStatus; s == nil || !s.Reconciling || s.Since != "2026-11-18T00:00:00Z" || s.Timeout != "10m" || s.Message != "Running 'upgrade' action with timeout of 10m0s" {
		t.Fatalf("upgrading: %+v", s)
	}
	if s := got[3].SourceStatus; s == nil || s.Reconciling || s.Sync != "OutOfSync" || s.Health != "Degraded" || s.Message != "chart not found" {
		t.Fatalf("a failure that keeps retrying must show the failure: %+v", s)
	}
	if got[4].SourceStatus != nil {
		t.Fatalf("a native Helm app got a GitOps status: %+v", got[4].SourceStatus)
	}
	if shared[2].SourceStatus != nil {
		t.Fatal("the shared cached rows were mutated")
	}
}

// At build time a failing Flux source degrades the app, as a failing Argo CD
// one does, and a settled source changes nothing.
func TestFluxStatusRollsIntoRowHealth(t *testing.T) {
	rows := []appRow{releaseRow("settled", "neutral"), releaseRow("failing", "healthy"), releaseRow("upgrading", "healthy")}
	enrichRowsWithFluxStatus(context.Background(), fluxReleases(), rows)
	if rows[0].SourceStatus != nil || rows[0].Health != "neutral" {
		t.Fatalf("settled: %+v health=%s", rows[0].SourceStatus, rows[0].Health)
	}
	if rows[1].SourceStatus == nil || rows[1].Health != "degraded" {
		t.Fatalf("failing: %+v health=%s", rows[1].SourceStatus, rows[1].Health)
	}
	if rows[2].SourceStatus == nil || rows[2].Health != "healthy" {
		t.Fatalf("an upgrade in flight must not change the app's health: %+v health=%s", rows[2].SourceStatus, rows[2].Health)
	}
}

// An Argo CD app mid-sync says so, with Argo's own message; a suspension
// Radar made reads as suspended though Argo's health never says it.
func TestLiveSourceActivityForArgo(t *testing.T) {
	app := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
		"metadata": map[string]any{"name": "shop", "namespace": "argocd", "annotations": map[string]any{"radarhq.io/suspended-automated": "{}"}},
		"status": map[string]any{
			"sync": map[string]any{"status": "OutOfSync"}, "health": map[string]any{"status": "Progressing"},
			"operationState": map[string]any{"phase": "Running", "startedAt": "2026-11-18T00:00:00Z", "message": "waiting for healthy state of apps/Deployment/shop"},
		},
	}}
	row := appRow{RuntimeHealth: "healthy", SourceRef: &appSourceRef{Type: "gitops", Tool: "argocd", Group: "argoproj.io", Kind: "Application", Namespace: "argocd", Name: "shop"}}
	got := withLiveSourceActivity(context.Background(), kindLister{"argoproj.io/Application": {app}}, []appRow{row})
	s := got[0].SourceStatus
	if s == nil || !s.Reconciling || s.Since != "2026-11-18T00:00:00Z" || s.Message != "waiting for healthy state of apps/Deployment/shop" || !s.Suspended || s.Sync != "OutOfSync" {
		t.Fatalf("argo: %+v", s)
	}
}

// readOnlyKinds serves only the copy-free list, as k8s.ResourceCache does
// beside its copying one; the copying list fails, so a read through it shows.
type readOnlyKinds struct{ kindLister }

func (readOnlyKinds) ListDynamicWithGroup(context.Context, string, string, string) ([]*unstructured.Unstructured, error) {
	return nil, errors.New("copying list used")
}

func (l readOnlyKinds) ListDynamicWithGroupReadOnly(ctx context.Context, kind, namespace, group string) ([]*unstructured.Unstructured, error) {
	return l.kindLister.ListDynamicWithGroup(ctx, kind, namespace, group)
}

// The live refresh runs on every applications request and lists its sources
// cluster-wide, so it reads the cached objects without copying them; it only
// reads them, and leaves them as they were.
func TestLiveSourceActivityReadsWithoutCopying(t *testing.T) {
	lister := readOnlyKinds{fluxReleases()}
	before := lister.kindLister["helm.toolkit.fluxcd.io/HelmRelease"][2].DeepCopy()
	got := withLiveSourceActivity(context.Background(), lister, []appRow{releaseRow("upgrading", "healthy")})
	if s := got[0].SourceStatus; s == nil || !s.Reconciling || s.Since != "2026-11-18T00:00:00Z" {
		t.Fatalf("upgrading through the read-only list: %+v", s)
	}
	if after := lister.kindLister["helm.toolkit.fluxcd.io/HelmRelease"][2]; !reflect.DeepEqual(after.Object, before.Object) {
		t.Fatal("the live refresh changed a cached object")
	}
}
