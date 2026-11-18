package topology

import (
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
)

func replicas(n int32) *int32 { return &n }

// A Deployment mid-rollout carries its rollout; a settled one carries nothing.
func TestRolloutActivityOnTopology(t *testing.T) {
	rolling := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "apps", Generation: 4},
		Spec:       appsv1.DeploymentSpec{Replicas: replicas(3)},
		Status:     appsv1.DeploymentStatus{ObservedGeneration: 4, Replicas: 4, UpdatedReplicas: 1, ReadyReplicas: 2, AvailableReplicas: 2},
	}
	data := map[string]any{}
	annotateWorkloadRollout(data, rolling, nil, time.Now())
	rollout, _ := data["rollout"].(map[string]any)
	if rollout == nil || rollout["phase"] != "progressing" || rollout["active"] != true {
		t.Fatalf("rolling deployment: %v", data)
	}
	settled := rolling.DeepCopy()
	settled.Status = appsv1.DeploymentStatus{ObservedGeneration: 4, Replicas: 3, UpdatedReplicas: 3, ReadyReplicas: 3, AvailableReplicas: 3}
	quiet := map[string]any{}
	annotateWorkloadRollout(quiet, settled, nil, time.Now())
	if len(quiet) != 0 {
		t.Fatalf("settled deployment carries %v", quiet)
	}
}

// A workload reads starting only on evidence: every missing replica is a Pod,
// and every Pod that is not ready is merely starting.
func TestApplyStarting(t *testing.T) {
	cases := []struct {
		name    string
		status  HealthStatus
		tally   podStartup
		missing int32
		want    HealthStatus
	}{
		{"its one Pod is starting", StatusUnhealthy, podStartup{notReady: 1, starting: 1}, 1, StatusNeutral},
		{"scale-up, the new Pods are starting", StatusDegraded, podStartup{notReady: 2, starting: 2}, 2, StatusNeutral},
		{"a Pod is crash-looping", StatusUnhealthy, podStartup{notReady: 1, starting: 0}, 1, StatusUnhealthy},
		{"one starts, one fails", StatusDegraded, podStartup{notReady: 2, starting: 1}, 2, StatusDegraded},
		{"the Pods can't be created (quota)", StatusUnhealthy, podStartup{}, 2, StatusUnhealthy},
		{"only one of two missing Pods exists", StatusUnhealthy, podStartup{notReady: 1, starting: 1}, 2, StatusUnhealthy},
		{"healthy is left alone", StatusHealthy, podStartup{notReady: 1, starting: 1}, 1, StatusHealthy},
	}
	for _, c := range cases {
		node := Node{Status: c.status, Data: map[string]any{"readyReplicas": int32(0)}}
		applyStarting(&node, c.tally, c.missing)
		if node.Status != c.want {
			t.Errorf("%s: status = %s, want %s", c.name, node.Status, c.want)
		}
		if starting, _ := node.Data["starting"].(bool); starting != (c.want == StatusNeutral && c.status != StatusNeutral) {
			t.Errorf("%s: starting flag = %v", c.name, starting)
		}
		if _, kept := node.Data["readyReplicas"]; !kept {
			t.Errorf("%s: the ready count must stay on the node", c.name)
		}
	}
}

type startupProvider struct {
	ResourceProvider
	pods        []*corev1.Pod
	replicasets []*appsv1.ReplicaSet
}

func (p startupProvider) Pods() ([]*corev1.Pod, error)               { return p.pods, nil }
func (p startupProvider) ReplicaSets() ([]*appsv1.ReplicaSet, error) { return p.replicasets, nil }

// Not-ready Pods are tallied per controller and rolled up from a ReplicaSet to
// its Deployment; Pods on their way out and ready Pods are no part of it.
func TestPodStartupTallies(t *testing.T) {
	now := time.Date(2026, 11, 18, 1, 0, 0, 0, time.UTC)
	controller := true
	owned := func(name string, owner metav1.OwnerReference, mutate func(*corev1.Pod)) *corev1.Pod {
		start := metav1.NewTime(now.Add(-10 * time.Second))
		pod := &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "apps", CreationTimestamp: start, OwnerReferences: []metav1.OwnerReference{owner}},
			Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}},
			Status: corev1.PodStatus{Phase: corev1.PodRunning, StartTime: &start,
				ContainerStatuses: []corev1.ContainerStatus{{Name: "app", Ready: false, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: start}}}}},
		}
		if mutate != nil {
			mutate(pod)
		}
		return pod
	}
	rsRef := metav1.OwnerReference{Kind: "ReplicaSet", Name: "web-2", UID: "rs-new", Controller: &controller}
	oldRef := metav1.OwnerReference{Kind: "ReplicaSet", Name: "web-1", UID: "rs-old", Controller: &controller}
	provider := startupProvider{
		pods: []*corev1.Pod{
			owned("starting", rsRef, nil),
			owned("crashing", rsRef, func(p *corev1.Pod) { p.Status.ContainerStatuses[0].RestartCount = 3 }),
			owned("leaving", oldRef, func(p *corev1.Pod) { gone := metav1.NewTime(now); p.DeletionTimestamp = &gone }),
			owned("serving", oldRef, func(p *corev1.Pod) {
				p.Status.ContainerStatuses[0].Ready = true
				p.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}
			}),
		},
		replicasets: []*appsv1.ReplicaSet{
			{ObjectMeta: metav1.ObjectMeta{Name: "web-2", Namespace: "apps", UID: "rs-new", OwnerReferences: []metav1.OwnerReference{{Kind: "Deployment", Name: "web", UID: "deploy", Controller: &controller}}}},
		},
	}
	tallies := (&Builder{provider: provider}).podStartupTallies(now)
	if got := tallies["rs-new"]; got != (podStartup{notReady: 2, starting: 1}) {
		t.Fatalf("new ReplicaSet tally = %+v", got)
	}
	if got := tallies["deploy"]; got != (podStartup{notReady: 2, starting: 1}) {
		t.Fatalf("Deployment tally = %+v", got)
	}
	if _, counted := tallies["rs-old"]; counted {
		t.Fatalf("ready and departing Pods were tallied: %+v", tallies["rs-old"])
	}
}

// A Flux object mid-pass is marked in progress with its controller's words; a
// suspended one and one that fails and keeps retrying are not.
func TestFluxActivityOnTopology(t *testing.T) {
	release := func(suspend bool, conditions ...any) *unstructured.Unstructured {
		return &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "helm.toolkit.fluxcd.io/v2", "kind": "HelmRelease",
			"metadata": map[string]any{"name": "web", "namespace": "apps", "generation": int64(2)},
			"spec":     map[string]any{"suspend": suspend},
			"status":   map[string]any{"observedGeneration": int64(2), "conditions": conditions},
		}}
	}
	ready := map[string]any{"type": "Ready", "status": "True", "reason": "UpgradeSucceeded", "observedGeneration": int64(2)}
	reconciling := map[string]any{"type": "Reconciling", "status": "True", "reason": "Progressing", "lastTransitionTime": "2026-11-18T00:00:00Z", "observedGeneration": int64(2)}
	upgrading := release(false,
		map[string]any{"type": "Ready", "status": "Unknown", "reason": "Progressing", "message": "Running 'upgrade' action with timeout of 5m0s", "observedGeneration": int64(2)},
		reconciling,
	)
	data := map[string]any{}
	annotateFluxActivity(data, upgrading)
	if data["inProgress"] != "reconciling" || data["inProgressSince"] != "2026-11-18T00:00:00Z" || data["inProgressMessage"] != "Running 'upgrade' action with timeout of 5m0s" {
		t.Fatalf("activity = %v", data)
	}
	for name, obj := range map[string]*unstructured.Unstructured{
		"suspended": release(true, ready, reconciling),
		"failing": release(false,
			map[string]any{"type": "Ready", "status": "False", "reason": "InstallFailed", "message": "chart not found", "observedGeneration": int64(2)},
			reconciling),
	} {
		quiet := map[string]any{}
		annotateFluxActivity(quiet, obj)
		if len(quiet) != 0 {
			t.Fatalf("a %s release must not read as work in flight: %v", name, quiet)
		}
	}
}

// A custom resource whose controller says it is still working is marked in
// progress, in the controller's words, until the reading lapses; one that
// failed, is being deleted, or has said so for too long is not. A Flagger
// Canary reads by phase: moving, under the same window counted from its last
// status report, or parked on a confirmation hook.
func TestConditionProgressOnTopology(t *testing.T) {
	now := time.Date(2026, 11, 18, 10, 5, 0, 0, time.UTC)
	at := func(minute int) string {
		return time.Date(2026, 11, 18, 10, minute, 0, 0, time.UTC).Format(time.RFC3339)
	}
	certificate := func(conds ...any) *unstructured.Unstructured {
		return &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "cert-manager.io/v1", "kind": "Certificate",
			"metadata": map[string]any{"name": "web", "namespace": "apps"},
			"status":   map[string]any{"conditions": conds},
		}}
	}
	issuing := certificate(
		map[string]any{"type": "Ready", "status": "False", "reason": "DoesNotExist", "message": "Issuing certificate as Secret does not exist", "lastTransitionTime": at(0)},
		map[string]any{"type": "Issuing", "status": "True", "reason": "DoesNotExist", "message": "Issuing certificate as Secret does not exist", "lastTransitionTime": at(1)},
	)
	data := map[string]any{}
	AnnotateResourceProgress(data, issuing, now)
	if data["inProgress"] != "reconciling" || data["inProgressSince"] != at(1) || data["inProgressUntil"] != at(11) || data["inProgressMessage"] != "Issuing certificate as Secret does not exist" {
		t.Fatalf("issuing certificate: %v", data)
	}
	// Past the window it is stuck, not working: the node keeps the status it
	// has without this reading.
	stuck := map[string]any{}
	AnnotateResourceProgress(stuck, issuing, now.Add(3*time.Hour))
	if len(stuck) != 0 {
		t.Fatalf("a certificate stuck issuing for hours reads as work in flight: %v", stuck)
	}
	failed := map[string]any{}
	AnnotateResourceProgress(failed, certificate(
		map[string]any{"type": "Ready", "status": "False", "reason": "DoesNotExist", "lastTransitionTime": at(0)},
		map[string]any{"type": "Issuing", "status": "False", "reason": "Failed", "lastTransitionTime": at(1)},
	), now)
	if len(failed) != 0 {
		t.Fatalf("a failed issuance reads as work in flight: %v", failed)
	}
	deleting := issuing.DeepCopy()
	deleting.SetDeletionTimestamp(&metav1.Time{Time: now})
	gone := map[string]any{}
	AnnotateResourceProgress(gone, deleting, now)
	if len(gone) != 0 {
		t.Fatalf("a certificate being deleted reads as work in flight: %v", gone)
	}

	canary := func(phase, reported string) *unstructured.Unstructured {
		status := map[string]any{"phase": phase}
		if reported != "" {
			status["lastTransitionTime"] = reported
		}
		return &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "flagger.app/v1beta1", "kind": "Canary",
			"metadata": map[string]any{"name": "web", "namespace": "apps"},
			"status":   status,
		}}
	}
	moving := map[string]any{}
	AnnotateResourceProgress(moving, canary("Progressing", at(4)), now)
	if moving["inProgress"] != "reconciling" || moving["inProgressSince"] != at(4) || moving["inProgressMessage"] != "Flagger: Progressing" || moving["awaiting"] != nil {
		t.Fatalf("progressing canary: %v", moving)
	}
	for name, c := range map[string]*unstructured.Unstructured{
		"a canary Flagger last reported on hours ago": canary("Initializing", now.Add(-3*time.Hour).Format(time.RFC3339)),
		"a canary with no report time":                canary("Progressing", ""),
	} {
		quiet := map[string]any{}
		AnnotateResourceProgress(quiet, c, now)
		if len(quiet) != 0 {
			t.Errorf("%s spins: %v", name, quiet)
		}
	}
	parked := map[string]any{}
	AnnotateResourceProgress(parked, canary("WaitingPromotion", at(0)), now)
	awaiting, _ := parked["awaiting"].(map[string]any)
	if awaiting == nil || awaiting["label"] != "Waiting for promotion" || parked["inProgress"] != nil {
		t.Fatalf("canary waiting for promotion: %v", parked)
	}
}

// Only an Argo Rollout parked until someone promotes it asks for that; one
// that moves by itself, one whose new revision cannot start, and a workload
// whose Pods wait to be deleted by hand do not.
func TestAwaitingActionOnTopology(t *testing.T) {
	now := time.Date(2026, 11, 18, 10, 0, 0, 0, time.UTC)
	controller := true
	rollout := func(steps []any, index int64) *unstructured.Unstructured {
		return &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "argoproj.io/v1alpha1", "kind": "Rollout",
			"metadata": map[string]any{"name": "web", "namespace": "apps", "uid": "rollout-uid"},
			"spec":     map[string]any{"replicas": int64(4), "strategy": map[string]any{"canary": map[string]any{"steps": steps}}},
			"status": map[string]any{"phase": "Paused", "currentStepIndex": index, "currentPodHash": "new", "updatedReplicas": int64(1), "readyReplicas": int64(4), "availableReplicas": int64(4),
				"pauseConditions": []any{map[string]any{"reason": "CanaryPauseStep"}}},
		}}
	}
	steps := []any{map[string]any{"setWeight": int64(25)}, map[string]any{"pause": map[string]any{}}, map[string]any{"pause": map[string]any{"duration": "30s"}}}
	parked := map[string]any{}
	annotateWorkloadRollout(parked, rollout(steps, 1), nil, now)
	awaiting, _ := parked["awaiting"].(map[string]any)
	if awaiting == nil || awaiting["label"] != "Waiting for promotion" {
		t.Fatalf("rollout on an untimed pause step: %v", parked)
	}
	timed := map[string]any{}
	annotateWorkloadRollout(timed, rollout(steps, 2), nil, now)
	if timed["awaiting"] != nil || timed["rollout"] == nil {
		t.Fatalf("rollout on a timed pause step: %v", timed)
	}

	// The canary Pod of the new revision is crash-looping: the rollout is
	// stalled, as the workload page says, and nobody is asked to promote it.
	newRS := &appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: "web-new", Namespace: "apps", UID: "rs-new",
		Labels:          map[string]string{"rollouts-pod-template-hash": "new"},
		OwnerReferences: []metav1.OwnerReference{{Kind: "Rollout", Name: "web", UID: "rollout-uid", Controller: &controller}}}}
	crashing := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "web-new-1", Namespace: "apps", CreationTimestamp: metav1.Time{Time: now.Add(-10 * time.Minute)},
			OwnerReferences: []metav1.OwnerReference{{Kind: "ReplicaSet", Name: "web-new", UID: "rs-new", Controller: &controller}}},
		Status: corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{{Name: "app", RestartCount: 6,
			State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}}}}},
	}
	failing := map[string]any{}
	annotateWorkloadRollout(failing, rollout(steps, 1), newRevisionIndex(startupProvider{pods: []*corev1.Pod{crashing}, replicasets: []*appsv1.ReplicaSet{newRS}}), now)
	got, _ := failing["rollout"].(map[string]any)
	if failing["awaiting"] != nil || got == nil || got["phase"] != "stalled" || got["label"] != "New revision cannot start" {
		t.Fatalf("rollout whose new revision cannot start: %v", failing)
	}

	// A StatefulSet whose strategy waits for its Pods to be deleted: an
	// operator may be doing exactly that, so it asks no one.
	onDelete := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: "apps", Generation: 2},
		Spec:       appsv1.StatefulSetSpec{Replicas: replicas(3), UpdateStrategy: appsv1.StatefulSetUpdateStrategy{Type: appsv1.OnDeleteStatefulSetStrategyType}},
		Status:     appsv1.StatefulSetStatus{ObservedGeneration: 2, Replicas: 3, UpdatedReplicas: 1, ReadyReplicas: 3, CurrentRevision: "db-1", UpdateRevision: "db-2"},
	}
	waiting := map[string]any{}
	annotateWorkloadRollout(waiting, onDelete, nil, now)
	if waiting["awaiting"] != nil {
		t.Fatalf("an OnDelete StatefulSet asks someone to act: %v", waiting)
	}
	if waiting["rollout"] == nil {
		t.Fatalf("an OnDelete StatefulSet mid-update lost its rollout: %v", waiting)
	}
}

// The Pods of each workload's updated revision, as the shared failure rule
// needs them.
func TestRevisionIndex(t *testing.T) {
	controller := true
	owner := func(kind, name string, uid types.UID) []metav1.OwnerReference {
		return []metav1.OwnerReference{{Kind: kind, Name: name, UID: uid, Controller: &controller}}
	}
	pod := func(name string, owners []metav1.OwnerReference, labels map[string]string) *corev1.Pod {
		return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "apps", Labels: labels, OwnerReferences: owners}}
	}
	provider := startupProvider{
		replicasets: []*appsv1.ReplicaSet{
			{ObjectMeta: metav1.ObjectMeta{Name: "web-1", UID: "rs-1", Labels: map[string]string{"pod-template-hash": "one"}, Annotations: map[string]string{"deployment.kubernetes.io/revision": "1"}, OwnerReferences: owner("Deployment", "web", "deploy")}},
			{ObjectMeta: metav1.ObjectMeta{Name: "web-2", UID: "rs-2", Labels: map[string]string{"pod-template-hash": "two"}, Annotations: map[string]string{"deployment.kubernetes.io/revision": "2"}, OwnerReferences: owner("Deployment", "web", "deploy")}},
		},
		pods: []*corev1.Pod{
			pod("web-1-a", owner("ReplicaSet", "web-1", "rs-1"), map[string]string{"pod-template-hash": "one"}),
			pod("web-2-a", owner("ReplicaSet", "web-2", "rs-2"), map[string]string{"pod-template-hash": "two"}),
			pod("db-0", owner("StatefulSet", "db", "sts"), map[string]string{"controller-revision-hash": "db-1"}),
			pod("db-1", owner("StatefulSet", "db", "sts"), map[string]string{"controller-revision-hash": "db-2"}),
			pod("agent-a", owner("DaemonSet", "agent", "ds"), map[string]string{"pod-template-generation": "3"}),
			pod("agent-b", owner("DaemonSet", "agent", "ds"), map[string]string{"pod-template-generation": "4"}),
		},
	}
	index := newRevisionIndex(provider)
	names := func(pods []*corev1.Pod) []string {
		var out []string
		for _, p := range pods {
			out = append(out, p.Name)
		}
		return out
	}
	deploy := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "web", UID: "deploy"}}
	sts := &appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Name: "db", UID: "sts"}, Status: appsv1.StatefulSetStatus{UpdateRevision: "db-2"}}
	ds := &appsv1.DaemonSet{ObjectMeta: metav1.ObjectMeta{Name: "agent", UID: "ds", Annotations: map[string]string{"deprecated.daemonset.template.generation": "4"}}}
	for name, c := range map[string]struct {
		obj  any
		want string
	}{
		"Deployment, through its newest ReplicaSet": {deploy, "web-2-a"},
		"StatefulSet, by its update revision":       {sts, "db-1"},
		"DaemonSet, by its template generation":     {ds, "agent-b"},
	} {
		if got := names(index.updatedPods(c.obj)); len(got) != 1 || got[0] != c.want {
			t.Errorf("%s: %v, want [%s]", name, got, c.want)
		}
	}
	if got := index.updatedPods(&appsv1.DaemonSet{ObjectMeta: metav1.ObjectMeta{UID: "ds"}}); got != nil {
		t.Errorf("a DaemonSet with no template generation guessed its Pods: %v", names(got))
	}
}
