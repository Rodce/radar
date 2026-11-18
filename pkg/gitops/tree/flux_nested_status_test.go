package tree

import (
	"context"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/skyhook-io/radar/pkg/topology"
)

func nestedRelease(name string, suspend bool, conditions ...map[string]any) *unstructured.Unstructured {
	hr := helmRelease("apps", name)
	unstructured.SetNestedField(hr.Object, int64(3), "metadata", "generation")
	if suspend {
		unstructured.SetNestedField(hr.Object, true, "spec", "suspend")
	}
	raw := make([]any, 0, len(conditions))
	for _, c := range conditions {
		raw = append(raw, c)
	}
	hr.Object["status"] = map[string]any{"observedGeneration": int64(3), "conditions": raw}
	return hr
}

func cond(typ, status, reason string) map[string]any {
	return map[string]any{"type": typ, "status": status, "reason": reason, "observedGeneration": int64(3)}
}

// A Kustomization's inventory names the HelmReleases it applies but carries
// no verdict on them; each one's own controller state must decide its node,
// the same verdict its own page shows.
func TestNestedFluxReconcilersCarryTheirOwnVerdict(t *testing.T) {
	ks := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "kustomize.toolkit.fluxcd.io/v1", "kind": "Kustomization",
		"metadata": map[string]any{"name": "apps", "namespace": "flux-system", "generation": int64(1)},
		"status": map[string]any{
			"observedGeneration": int64(1),
			"conditions":         []any{cond("Ready", "True", "ReconciliationSucceeded")},
			"inventory": map[string]any{"entries": []any{
				map[string]any{"id": "apps_paused_helm.toolkit.fluxcd.io_HelmRelease"},
				map[string]any{"id": "apps_upgrading_helm.toolkit.fluxcd.io_HelmRelease"},
				map[string]any{"id": "apps_settled_helm.toolkit.fluxcd.io_HelmRelease"},
			}},
		},
	}}
	objects := map[string]*unstructured.Unstructured{
		refKey(ResourceRef{Group: "kustomize.toolkit.fluxcd.io", Kind: "Kustomization", Namespace: "flux-system", Name: "apps"}): ks,
		// Suspended while Ready=True: Radar's topology read says Healthy.
		refKey(ResourceRef{Group: "helm.toolkit.fluxcd.io", Kind: "HelmRelease", Namespace: "apps", Name: "paused"}): nestedRelease("paused", true, cond("Ready", "True", "UpgradeSucceeded")),
		// Mid-upgrade: Ready=Unknown, Reconciling=True. Topology says Unknown.
		refKey(ResourceRef{Group: "helm.toolkit.fluxcd.io", Kind: "HelmRelease", Namespace: "apps", Name: "upgrading"}): nestedRelease("upgrading", false, cond("Ready", "Unknown", "Progressing"), cond("Reconciling", "True", "Progressing")),
		refKey(ResourceRef{Group: "helm.toolkit.fluxcd.io", Kind: "HelmRelease", Namespace: "apps", Name: "settled"}):   nestedRelease("settled", false, cond("Ready", "True", "UpgradeSucceeded")),
	}
	tree, _, err := NewBuilder(&fakeDynamic{objects: objects}, nil).WithOwnership(ownershipSession(t)).Build(context.Background(), "Kustomization", "flux-system", "apps", "kustomize.toolkit.fluxcd.io")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]struct {
		sync, health, tone string
		reconciling        bool
	}{
		"paused":    {"Synced", "Suspended", "neutral", false},
		"upgrading": {"Reconciling", "Progressing", "degraded", true},
		"settled":   {"Synced", "Healthy", "healthy", false},
	}
	for _, node := range tree.Nodes {
		w, ok := want[node.Ref.Name]
		if !ok || node.Ref.Kind != "HelmRelease" {
			continue
		}
		delete(want, node.Ref.Name)
		if node.Sync != w.sync || node.Health != w.health || node.TopologyStatus != w.tone {
			t.Errorf("%s = %s/%s/%s, want %s/%s/%s", node.Ref.Name, node.Sync, node.Health, node.TopologyStatus, w.sync, w.health, w.tone)
		}
		if node.HealthSource != HealthSourceController {
			t.Errorf("%s healthSource = %q, want controller", node.Ref.Name, node.HealthSource)
		}
		if got, _ := node.Data["reconciling"].(bool); got != w.reconciling {
			t.Errorf("%s reconciling = %v, want %v", node.Ref.Name, got, w.reconciling)
		}
	}
	if len(want) != 0 {
		t.Fatalf("missing from tree: %v", want)
	}
}

// An Argo Application mid-operation says so on its node, root or nested,
// the same reading the detail page applies.
func TestArgoOperationInProgressOnNode(t *testing.T) {
	app := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
		"metadata": map[string]any{"name": "child", "namespace": "argocd"},
		"status":   map[string]any{"operationState": map[string]any{"phase": "Running"}},
	}}
	node := enrichNodeFromObject(Node{Tool: ToolArgoCD, Role: RoleDeclared, Data: map[string]any{}}, app)
	if node.Data["operationInProgress"] != true {
		t.Fatalf("running operation not marked: %v", node.Data)
	}
	unstructured.SetNestedField(app.Object, "Succeeded", "status", "operationState", "phase")
	node = enrichNodeFromObject(Node{Tool: ToolArgoCD, Role: RoleDeclared, Data: map[string]any{}}, app)
	if _, ok := node.Data["operationInProgress"]; ok {
		t.Fatalf("finished operation still marked: %v", node.Data)
	}
}

// A pass in flight carries since when and against what timeout; a requested
// reconcile the controller has not handled yet reads as pending; a failure
// that keeps retrying is not activity.
func TestFluxActivityOnNode(t *testing.T) {
	requested := time.Now().Add(-5 * time.Second).Format(time.RFC3339Nano)
	hr := nestedRelease("upgrading", false, cond("Ready", "Unknown", "Progressing"), map[string]any{"type": "Reconciling", "status": "True", "reason": "Progressing", "lastTransitionTime": "2026-11-17T21:00:00Z"})
	unstructured.SetNestedField(hr.Object, "10m", "spec", "timeout")
	hr.SetAnnotations(map[string]string{"reconcile.fluxcd.io/requestedAt": requested})
	unstructured.SetNestedField(hr.Object, "earlier", "status", "lastHandledReconcileAt")
	node := enrichNodeFromObject(Node{Tool: ToolFluxCD, Role: RoleDeclared, Data: map[string]any{}}, hr)
	if node.Data["reconciling"] != true || node.Data["reconcilingSince"] != "2026-11-17T21:00:00Z" || node.Data["timeout"] != "10m" || node.Data["reconcileRequested"] != true {
		t.Fatalf("activity = %v", node.Data)
	}
	unstructured.SetNestedField(hr.Object, requested, "status", "lastHandledReconcileAt")
	node = enrichNodeFromObject(Node{Tool: ToolFluxCD, Role: RoleDeclared, Data: map[string]any{}}, hr)
	if _, pending := node.Data["reconcileRequested"]; pending {
		t.Fatalf("handled request still pending: %v", node.Data)
	}

	failing := nestedRelease("failing", false,
		map[string]any{"type": "Ready", "status": "False", "reason": "InstallFailed", "message": "chart not found", "observedGeneration": int64(3)},
		map[string]any{"type": "Reconciling", "status": "True", "reason": "ProgressingWithRetry", "lastTransitionTime": "2026-11-17T18:00:00Z"})
	node = enrichNodeFromObject(Node{Tool: ToolFluxCD, Role: RoleDeclared, Data: map[string]any{}}, failing)
	if node.Health != "Degraded" {
		t.Fatalf("failing release health = %q, want Degraded", node.Health)
	}
	for _, key := range []string{"reconciling", "reconcilingSince", "timeout"} {
		if _, ok := node.Data[key]; ok {
			t.Fatalf("a failure that keeps retrying reads as activity (%s): %v", key, node.Data)
		}
	}
}

// A workload topology calls starting reads Progressing in the tree, as a
// GitOps controller would call it, not Unknown.
func TestStartingWorkloadReadsProgressing(t *testing.T) {
	live := topology.Node{ID: "replicaset/apps/web-1", Kind: topology.KindReplicaSet, Name: "web-1", Status: topology.StatusNeutral, Data: map[string]any{"starting": true}}
	node := nodeFromTopology(live, ResourceRef{Group: "apps", Kind: "ReplicaSet", Namespace: "apps", Name: "web-1"}, RoleGenerated, ToolFluxCD, "", "", "")
	if node.Health != "Progressing" || node.HealthSource != HealthSourceRadar || node.TopologyStatus != "degraded" {
		t.Fatalf("starting ReplicaSet = %s/%s/%s", node.Health, node.HealthSource, node.TopologyStatus)
	}
	idle := topology.Node{ID: "deployment/apps/idle", Kind: topology.KindDeployment, Name: "idle", Status: topology.StatusNeutral, Data: map[string]any{}}
	if got := nodeFromTopology(idle, ResourceRef{Group: "apps", Kind: "Deployment", Namespace: "apps", Name: "idle"}, RoleDeclared, ToolFluxCD, "", "", "").Health; got != "Unknown" {
		t.Fatalf("a scaled-to-zero workload must keep its reading, got %q", got)
	}
}

// A custom resource Radar reads as unhealthy reads Progressing while its
// controller says it is still working; a controller's verdict stands, a node
// with no health keeps none, and a built-in kind is left to its own reading.
func TestConditionProgressOnNode(t *testing.T) {
	started := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
	certificate := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "cert-manager.io/v1", "kind": "Certificate",
		"metadata": map[string]any{"name": "web", "namespace": "apps"},
		"status": map[string]any{"conditions": []any{
			map[string]any{"type": "Ready", "status": "False", "reason": "DoesNotExist", "lastTransitionTime": started},
			map[string]any{"type": "Issuing", "status": "True", "reason": "DoesNotExist", "message": "Issuing certificate as Secret does not exist", "lastTransitionTime": started},
		}},
	}}
	radar := enrichNodeFromObject(Node{Tool: ToolFluxCD, Role: RoleDeclared, Health: "Degraded", HealthSource: HealthSourceRadar, TopologyStatus: "unhealthy", Data: map[string]any{}}, certificate)
	if radar.Health != "Progressing" || radar.HealthSource != HealthSourceRadar || radar.TopologyStatus != "degraded" ||
		radar.Data["inProgress"] != "reconciling" || radar.Data["inProgressMessage"] != "Issuing certificate as Secret does not exist" || radar.Data["inProgressUntil"] == nil {
		t.Fatalf("issuing certificate: %s/%s/%s %v", radar.Health, radar.HealthSource, radar.TopologyStatus, radar.Data)
	}
	verdict := enrichNodeFromObject(Node{Tool: ToolArgoCD, Role: RoleDeclared, Health: "Degraded", HealthSource: HealthSourceController, Data: map[string]any{}}, certificate)
	if verdict.Health != "Degraded" || verdict.Data["inProgress"] != "reconciling" {
		t.Fatalf("a controller's verdict must stand, with the activity beside it: %s %v", verdict.Health, verdict.Data)
	}
	none := enrichNodeFromObject(Node{Tool: ToolArgoCD, Role: RoleDeclared, Sync: "Synced", Data: map[string]any{}}, certificate)
	if none.Health != "" || none.Data["inProgress"] != "reconciling" {
		t.Fatalf("a node with no health got one: %q %v", none.Health, none.Data)
	}
	// Topology's copy of the same reading can be a few seconds older than the
	// object: once the controller is done, nothing of it stays on the node.
	issued := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "cert-manager.io/v1", "kind": "Certificate",
		"metadata": map[string]any{"name": "web", "namespace": "apps"},
		"status":   map[string]any{"conditions": []any{map[string]any{"type": "Ready", "status": "True", "reason": "Ready", "lastTransitionTime": started}}},
	}}
	done := enrichNodeFromObject(Node{Tool: ToolFluxCD, Role: RoleDeclared, Health: "Healthy", HealthSource: HealthSourceRadar,
		Data: map[string]any{"inProgress": "reconciling", "inProgressSince": started, "inProgressUntil": started, "inProgressMessage": "Issuing"}}, issued)
	if done.Health != "Healthy" || done.Data["inProgress"] != nil || done.Data["inProgressSince"] != nil || done.Data["inProgressUntil"] != nil || done.Data["inProgressMessage"] != nil {
		t.Fatalf("a settled certificate keeps a stale in-progress reading: %s %v", done.Health, done.Data)
	}
	// Dated, so only the group rule keeps a built-in kind out: its condition
	// would read as in progress otherwise.
	deployment := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apps/v1", "kind": "Deployment",
		"metadata": map[string]any{"name": "web", "namespace": "apps"},
		"status":   map[string]any{"conditions": []any{map[string]any{"type": "Available", "status": "False", "reason": "Pending", "lastTransitionTime": started}}},
	}}
	if builtin := enrichNodeFromObject(Node{Tool: ToolFluxCD, Role: RoleDeclared, Health: "Degraded", HealthSource: HealthSourceRadar, Data: map[string]any{}}, deployment); builtin.Health != "Degraded" || builtin.Data["inProgress"] != nil {
		t.Fatalf("a built-in kind was read as a custom resource: %s %v", builtin.Health, builtin.Data)
	}
	// A Flagger Canary parked on its confirmation hook asks for it.
	canary := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "flagger.app/v1beta1", "kind": "Canary",
		"metadata": map[string]any{"name": "web", "namespace": "apps"},
		"status":   map[string]any{"phase": "WaitingPromotion", "lastTransitionTime": started},
	}}
	gate := enrichNodeFromObject(Node{Tool: ToolFluxCD, Role: RoleDeclared, Data: map[string]any{}}, canary)
	if awaiting, _ := gate.Data["awaiting"].(map[string]any); awaiting == nil || awaiting["label"] != "Waiting for promotion" || gate.Data["inProgress"] != nil {
		t.Fatalf("canary on its confirmation gate: %v", gate.Data)
	}
}

// A reconcile requested of a failed object that its controller has not
// picked up is no work yet: the node stays failed.
func TestRequestedReconcileKeepsAFailure(t *testing.T) {
	failed := topology.Node{ID: "hr", Kind: "HelmRelease", Name: "web", Status: topology.StatusUnhealthy, Data: map[string]any{"inProgress": "requested"}}
	ref := ResourceRef{Group: "helm.toolkit.fluxcd.io", Kind: "HelmRelease", Namespace: "apps", Name: "web"}
	if got := nodeFromTopology(failed, ref, RoleGenerated, ToolFluxCD, "", "", "").Health; got != "Degraded" {
		t.Fatalf("health = %q, want Degraded", got)
	}
	failed.Data["inProgress"] = "reconciling"
	if got := nodeFromTopology(failed, ref, RoleGenerated, ToolFluxCD, "", "", "").Health; got != "Progressing" {
		t.Fatalf("health = %q while the controller works, want Progressing", got)
	}
}
