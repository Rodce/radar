package health

import (
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// A rollout whose new Pods cannot run is stalled, whatever its controller
// still calls it; one whose new Pods are fine, or that has not been applied
// yet, keeps its own reading.
func TestUpdatedRevisionFailure(t *testing.T) {
	now := time.Date(2026, 11, 18, 10, 0, 0, 0, time.UTC)
	crashing := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "web-2", CreationTimestamp: metav1.Time{Time: now.Add(-10 * time.Minute)}},
		Status: corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{{
			Name: "web", RestartCount: 5,
			State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}},
		}}},
	}
	running := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "web-1", CreationTimestamp: metav1.Time{Time: now.Add(-10 * time.Minute)}},
		Status: corev1.PodStatus{Phase: corev1.PodRunning,
			Conditions:        []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}},
			ContainerStatuses: []corev1.ContainerStatus{{Name: "web", Ready: true, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}}},
	}
	parked := WorkloadRolloutActivity{Phase: RolloutPaused, Active: true, Manual: true, Label: "Waiting for promotion"}

	got := UpdatedRevisionFailure(parked, []*corev1.Pod{running, crashing}, now)
	if got.Phase != RolloutStalled || got.Active || got.Manual || got.Label != "New revision cannot start" || got.Detail == "" {
		t.Fatalf("a rollout waiting for promotion over a crashing Pod: %+v", got)
	}
	if got := UpdatedRevisionFailure(parked, []*corev1.Pod{running}, now); got != parked {
		t.Fatalf("healthy new Pods changed the reading: %+v", got)
	}
	// Between crashes the restarted container runs and is ready; its crash
	// history still says the revision cannot run.
	restarted := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "web-3", CreationTimestamp: metav1.Time{Time: now.Add(-10 * time.Minute)}},
		Status: corev1.PodStatus{Phase: corev1.PodRunning,
			Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}},
			ContainerStatuses: []corev1.ContainerStatus{{Name: "web", Ready: true, RestartCount: 5,
				State:                corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: metav1.Time{Time: now.Add(-5 * time.Second)}}},
				LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 1, Reason: "Error", FinishedAt: metav1.Time{Time: now.Add(-15 * time.Second)}}},
			}}},
	}
	if got := UpdatedRevisionFailure(parked, []*corev1.Pod{running, restarted}, now); got.Phase != RolloutStalled || got.Manual {
		t.Fatalf("a crash-looping Pod between crashes let the rollout wait for promotion: %+v", got)
	}
	// One that crashed once and has run cleanly since is no failure.
	settled := restarted.DeepCopy()
	settled.Status.ContainerStatuses[0].State.Running.StartedAt = metav1.Time{Time: now.Add(-20 * time.Minute)}
	settled.Status.ContainerStatuses[0].LastTerminationState.Terminated.FinishedAt = metav1.Time{Time: now.Add(-20*time.Minute - 10*time.Second)}
	if got := UpdatedRevisionFailure(parked, []*corev1.Pod{running, settled}, now); got != parked {
		t.Fatalf("a Pod that crashed once, long ago, stalled the rollout: %+v", got)
	}
	// An evicted Pod stays in the API beside its running replacement; a Pod
	// being deleted is on its way out. Neither says the revision cannot run.
	evicted := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "web-0", CreationTimestamp: metav1.Time{Time: now.Add(-2 * time.Hour)}},
		Status:     corev1.PodStatus{Phase: corev1.PodFailed, Reason: "Evicted", Message: "The node was low on resource: memory."},
	}
	deleting := crashing.DeepCopy()
	deleting.DeletionTimestamp = &metav1.Time{Time: now.Add(-time.Second)}
	if got := UpdatedRevisionFailure(parked, []*corev1.Pod{evicted, deleting, running}, now); got != parked {
		t.Fatalf("an evicted or deleted Pod stalled the rollout: %+v", got)
	}
	applying := WorkloadRolloutActivity{Phase: RolloutApplying, Active: true, Label: "Applying change"}
	if got := UpdatedRevisionFailure(applying, []*corev1.Pod{crashing}, now); got != applying {
		t.Fatalf("a change the controller has not observed was blamed on the old revision: %+v", got)
	}
	idle := WorkloadRolloutActivity{Phase: RolloutIdle, Label: "Stable"}
	if got := UpdatedRevisionFailure(idle, []*corev1.Pod{crashing}, now); got != idle {
		t.Fatalf("a settled workload turned into a stalled rollout: %+v", got)
	}
}
