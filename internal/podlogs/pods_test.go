package podlogs

import (
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestBuildPodInfoMarksNativeSidecars(t *testing.T) {
	always := corev1.ContainerRestartPolicyAlways
	pod := &corev1.Pod{
		Spec: corev1.PodSpec{
			InitContainers: []corev1.Container{{Name: "proxy", RestartPolicy: &always}, {Name: "wait-gcs-ready"}},
			Containers:     []corev1.Container{{Name: "ray-worker"}},
		},
		Status: corev1.PodStatus{
			Phase:                 corev1.PodPending,
			InitContainerStatuses: []corev1.ContainerStatus{{Name: "proxy"}, {Name: "wait-gcs-ready"}},
			ContainerStatuses:     []corev1.ContainerStatus{{Name: "ray-worker"}},
		},
	}
	got := map[string]ContainerInfo{}
	for _, status := range BuildPodInfo(pod, time.Now()).ContainerStatuses {
		got[status.Name] = status
	}
	if !got["proxy"].Init || !got["proxy"].Sidecar {
		t.Fatalf("proxy = %+v, want an init sidecar", got["proxy"])
	}
	if !got["wait-gcs-ready"].Init || got["wait-gcs-ready"].Sidecar {
		t.Fatalf("wait-gcs-ready = %+v, want a regular init container", got["wait-gcs-ready"])
	}
	if got["ray-worker"].Init || got["ray-worker"].Sidecar {
		t.Fatalf("ray-worker = %+v, want an application container", got["ray-worker"])
	}
}

func TestBuildPodInfoReportsContainerStates(t *testing.T) {
	started := true
	pod := &corev1.Pod{
		Spec: corev1.PodSpec{
			InitContainers: []corev1.Container{{Name: "storage-initializer"}},
			Containers:     []corev1.Container{{Name: "kserve-container"}},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodPending,
			InitContainerStatuses: []corev1.ContainerStatus{{
				Name:                 "storage-initializer",
				State:                corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}},
				LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Error", ExitCode: 1}},
			}},
			ContainerStatuses: []corev1.ContainerStatus{{
				Name:  "kserve-container",
				State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "PodInitializing"}},
			}},
		},
	}
	got := BuildPodInfo(pod, time.Now()).ContainerStatuses
	want := []ContainerInfo{
		{Name: "storage-initializer", Init: true, State: "waiting", Reason: "CrashLoopBackOff"},
		{Name: "kserve-container", State: "waiting", Reason: "PodInitializing"},
	}
	if len(got) != len(want) {
		t.Fatalf("statuses=%+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("status %d = %+v, want %+v", i, got[i], want[i])
		}
	}

	pod.Status.InitContainerStatuses[0] = corev1.ContainerStatus{Name: "storage-initializer", State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Completed"}}}
	pod.Status.ContainerStatuses[0] = corev1.ContainerStatus{Name: "kserve-container", Ready: true, Started: &started, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}
	got = BuildPodInfo(pod, time.Now()).ContainerStatuses
	if got[0].State != "terminated" || got[0].Reason != "Completed" || got[1].State != "running" || !got[1].Started {
		t.Fatalf("initialized statuses=%+v", got)
	}
}

func TestBuildPodInfoMarksStartingPods(t *testing.T) {
	now := time.Now()
	started := metav1.NewTime(now.Add(-20 * time.Second))
	pod := &corev1.Pod{
		Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "app", StartupProbe: &corev1.Probe{PeriodSeconds: 10, FailureThreshold: 30}}}},
		Status: corev1.PodStatus{
			Phase:             corev1.PodRunning,
			StartTime:         &started,
			ContainerStatuses: []corev1.ContainerStatus{{Name: "app", State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: started}}}},
		},
	}
	if info := BuildPodInfo(pod, now); !info.Starting || info.Ready {
		t.Fatalf("pod inside its startup probe budget = %+v, want starting", info)
	}
	pod.Status.ContainerStatuses[0].Ready = true
	if info := BuildPodInfo(pod, now); info.Starting || !info.Ready {
		t.Fatalf("ready pod = %+v, want ready and not starting", info)
	}
}

// The workload page reads the revision verdict off each Pod rather than
// deciding it again: a crash-looping Pod that passes its probes between
// restarts fails its revision, and a Pod being deleted does not.
func TestBuildPodInfoCarriesTheRevisionVerdict(t *testing.T) {
	now := time.Date(2026, 11, 18, 10, 0, 0, 0, time.UTC)
	restarted := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "web-3", CreationTimestamp: metav1.Time{Time: now.Add(-10 * time.Minute)}},
		Status: corev1.PodStatus{Phase: corev1.PodRunning,
			Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}},
			ContainerStatuses: []corev1.ContainerStatus{{Name: "web", Ready: true, RestartCount: 5,
				State:                corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: metav1.Time{Time: now.Add(-5 * time.Second)}}},
				LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 1, Reason: "Error", FinishedAt: metav1.Time{Time: now.Add(-15 * time.Second)}}},
			}}},
	}
	if info := BuildPodInfo(restarted, now); !info.RevisionFailing || info.HealthLevel == "unhealthy" {
		t.Fatalf("crash-looping Pod between crashes = %+v, want revisionFailing without an unhealthy level", info)
	}
	deleting := restarted.DeepCopy()
	deleting.DeletionTimestamp = &metav1.Time{Time: now.Add(-time.Second)}
	if info := BuildPodInfo(deleting, now); info.RevisionFailing {
		t.Fatalf("Pod being deleted = %+v, want no revision verdict", info)
	}
}

func TestSentPodInfoReportsOnlyChanges(t *testing.T) {
	waiting := PodInfo{Name: "p-0", ContainerStatuses: []ContainerInfo{{Name: "app", State: "waiting", Reason: "PodInitializing"}}}
	sent := NewSentPodInfo([]PodInfo{waiting})
	if sent.Changed(waiting) {
		t.Fatal("unchanged info reported as changed")
	}
	running := PodInfo{Name: "p-0", ContainerStatuses: []ContainerInfo{{Name: "app", State: "running", Started: true}}}
	if !sent.Changed(running) || sent.Changed(running) {
		t.Fatal("a status change must be reported once")
	}
	if !sent.Changed(PodInfo{Name: "p-1"}) {
		t.Fatal("a Pod not sent before must be reported")
	}
}
