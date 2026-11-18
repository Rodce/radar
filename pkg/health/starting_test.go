package health

import (
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// startingTestPod is a JVM app mid-rollout: Running, its container up for 15s
// and not ready yet, with a startup probe that allows 10s + 12×5s = 70s.
func startingTestPod(now time.Time, mutate func(*corev1.Pod)) *corev1.Pod {
	started := metav1.NewTime(now.Add(-20 * time.Second))
	p := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "api-7c9f-x2k", CreationTimestamp: metav1.NewTime(now.Add(-25 * time.Second))},
		Spec: corev1.PodSpec{Containers: []corev1.Container{{
			Name:           "app",
			StartupProbe:   &corev1.Probe{InitialDelaySeconds: 10, PeriodSeconds: 5, FailureThreshold: 12},
			ReadinessProbe: &corev1.Probe{PeriodSeconds: 5},
		}}},
		Status: corev1.PodStatus{
			Phase:      corev1.PodRunning,
			StartTime:  &started,
			Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionFalse, LastTransitionTime: started}},
			ContainerStatuses: []corev1.ContainerStatus{{
				Name:  "app",
				State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: metav1.NewTime(now.Add(-15 * time.Second))}},
			}},
		},
	}
	if mutate != nil {
		mutate(p)
	}
	return p
}

func TestIsPodStarting(t *testing.T) {
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	waiting := func(reason string) corev1.ContainerState {
		return corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: reason}}
	}
	pending := func(p *corev1.Pod) { p.Status.Phase = corev1.PodPending }
	startedAgo := func(p *corev1.Pod, d time.Duration) {
		at := metav1.NewTime(now.Add(-d))
		p.CreationTimestamp, p.Status.StartTime = at, &at
		p.Status.Conditions[0].LastTransitionTime = at
	}
	cases := []struct {
		name   string
		mutate func(*corev1.Pod)
		want   bool
	}{
		{name: "running inside its startup probe budget", want: true},
		{name: "pulling its image", want: true, mutate: func(p *corev1.Pod) {
			pending(p)
			p.Status.ContainerStatuses[0].State = waiting("ContainerCreating")
		}},
		{name: "running its init containers", want: true, mutate: func(p *corev1.Pod) {
			pending(p)
			p.Spec.InitContainers = []corev1.Container{{Name: "migrate"}}
			p.Status.InitContainerStatuses = []corev1.ContainerStatus{{Name: "migrate", State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}}
			p.Status.ContainerStatuses[0].State = waiting("PodInitializing")
		}},
		{name: "past a finished init container", want: true, mutate: func(p *corev1.Pod) {
			p.Status.InitContainerStatuses = []corev1.ContainerStatus{{Name: "migrate", State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Completed"}}}}
		}},
		{name: "before the kubelet reports any container", want: true, mutate: func(p *corev1.Pod) {
			pending(p)
			p.Status.StartTime, p.Status.ContainerStatuses = nil, nil
		}},
		{name: "the readiness probe stands in without a startup probe", want: true, mutate: func(p *corev1.Pod) {
			p.Spec.Containers[0].StartupProbe = nil
			p.Spec.Containers[0].ReadinessProbe = &corev1.Probe{} // defaults: 3 × 10s
		}},
		{name: "a container without probes gets five minutes", want: true, mutate: func(p *corev1.Pod) {
			pending(p)
			p.Spec.Containers[0].StartupProbe, p.Spec.Containers[0].ReadinessProbe = nil, nil
			p.Status.ContainerStatuses[0].State = waiting("ContainerCreating")
			startedAgo(p, 4*time.Minute)
		}},
		{name: "the slowest container sets the budget", want: true, mutate: func(p *corev1.Pod) {
			p.Spec.Containers = append(p.Spec.Containers, corev1.Container{Name: "warmup", StartupProbe: &corev1.Probe{PeriodSeconds: 10, FailureThreshold: 12}})
			p.Status.ContainerStatuses = append(p.Status.ContainerStatuses, corev1.ContainerStatus{Name: "warmup", State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}})
			startedAgo(p, 100*time.Second)
		}},

		{name: "ready", mutate: func(p *corev1.Pod) { p.Status.ContainerStatuses[0].Ready = true }},
		{name: "past its startup probe budget", mutate: func(p *corev1.Pod) { startedAgo(p, 2*time.Minute) }},
		{name: "past the readiness probe budget", mutate: func(p *corev1.Pod) {
			p.Spec.Containers[0].StartupProbe = nil
			p.Spec.Containers[0].ReadinessProbe = &corev1.Probe{}
			startedAgo(p, 40*time.Second)
		}},
		{name: "past five minutes without probes", mutate: func(p *corev1.Pod) {
			pending(p)
			p.Spec.Containers[0].StartupProbe, p.Spec.Containers[0].ReadinessProbe = nil, nil
			p.Status.ContainerStatuses[0].State = waiting("ContainerCreating")
			startedAgo(p, 6*time.Minute)
		}},
		{name: "restarted after its startup probe ran out", mutate: func(p *corev1.Pod) {
			cs := &p.Status.ContainerStatuses[0]
			cs.RestartCount = 1
			cs.LastTerminationState = corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Error", ExitCode: 143, FinishedAt: metav1.NewTime(now.Add(-16 * time.Second))}}
		}},
		{name: "restarted after a clean exit", mutate: func(p *corev1.Pod) {
			cs := &p.Status.ContainerStatuses[0]
			cs.RestartCount = 1
			cs.LastTerminationState = corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Completed"}}
		}},
		{name: "crashlooping", mutate: func(p *corev1.Pod) {
			p.Status.ContainerStatuses[0].RestartCount = 3
			p.Status.ContainerStatuses[0].State = waiting("CrashLoopBackOff")
		}},
		{name: "failing to pull its image", mutate: func(p *corev1.Pod) {
			pending(p)
			p.Status.ContainerStatuses[0].State = waiting("ImagePullBackOff")
		}},
		{name: "first image pull failed", mutate: func(p *corev1.Pod) {
			pending(p)
			p.Status.ContainerStatuses[0].State = waiting("ErrImagePull")
		}},
		{name: "missing its config", mutate: func(p *corev1.Pod) {
			pending(p)
			p.Status.ContainerStatuses[0].State = waiting("CreateContainerConfigError")
		}},
		{name: "waiting for a reason it does not know", mutate: func(p *corev1.Pod) {
			pending(p)
			p.Status.ContainerStatuses[0].State = waiting("ErrImageNeverPull")
		}},
		{name: "OOMKilled", mutate: func(p *corev1.Pod) {
			p.Status.ContainerStatuses[0].State = corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "OOMKilled", ExitCode: 137}}
		}},
		{name: "a failed init container", mutate: func(p *corev1.Pod) {
			pending(p)
			p.Status.InitContainerStatuses = []corev1.ContainerStatus{{Name: "migrate", State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Error", ExitCode: 1}}}}
			p.Status.ContainerStatuses[0].State = waiting("PodInitializing")
		}},
		{name: "terminating", mutate: func(p *corev1.Pod) {
			at := metav1.NewTime(now.Add(-5 * time.Second))
			p.DeletionTimestamp = &at
		}},
		{name: "unschedulable", mutate: func(p *corev1.Pod) {
			pending(p)
			p.Status.ContainerStatuses = nil
			p.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: corev1.PodReasonUnschedulable}}
		}},
		{name: "held by a scheduling gate", mutate: func(p *corev1.Pod) {
			pending(p)
			p.Spec.SchedulingGates = []corev1.PodSchedulingGate{{Name: "kueue.x-k8s.io/admission"}}
			p.Status.ContainerStatuses = nil
		}},
		{name: "without a start or creation time", mutate: func(p *corev1.Pod) {
			p.CreationTimestamp, p.Status.StartTime = metav1.Time{}, nil
		}},
		// Ready once, and lost it ten seconds ago: a failure on a fresh Pod,
		// not a start, however long its startup probe would have allowed.
		{name: "lost readiness after being ready", mutate: func(p *corev1.Pod) {
			p.Spec.Containers[0].StartupProbe = &corev1.Probe{PeriodSeconds: 10, FailureThreshold: 60}
			startedAgo(p, 2*time.Minute)
			p.Status.ContainerStatuses[0].State.Running.StartedAt = metav1.NewTime(now.Add(-2 * time.Minute))
			p.Status.Conditions[0].LastTransitionTime = metav1.NewTime(now.Add(-10 * time.Second))
		}},
		// A sidecar without probes is ready as soon as it runs; the app's own
		// 30s readiness budget is the one that counts.
		{name: "a ready sidecar does not stretch the budget", mutate: func(p *corev1.Pod) {
			p.Spec.Containers[0].StartupProbe = nil
			p.Spec.Containers[0].ReadinessProbe = &corev1.Probe{}
			p.Spec.Containers = append(p.Spec.Containers, corev1.Container{Name: "proxy"})
			p.Status.ContainerStatuses = append(p.Status.ContainerStatuses, corev1.ContainerStatus{Name: "proxy", Ready: true, State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: metav1.NewTime(now.Add(-40 * time.Second))}}})
			startedAgo(p, 40*time.Second)
		}},
		{name: "inside a long startup budget but past the readiness grace", mutate: func(p *corev1.Pod) {
			p.Spec.Containers[0].StartupProbe = &corev1.Probe{PeriodSeconds: 10, FailureThreshold: 60}
			startedAgo(p, 6*time.Minute)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := startingTestPod(now, tc.mutate)
			got := IsPodStarting(p, now)
			if got != tc.want {
				t.Fatalf("IsPodStarting = %v, want %v", got, tc.want)
			}
			if level := Pod(p, now).Level; got && Rank(level) != 0 {
				t.Fatalf("starting pod graded %q: the two must not disagree", level)
			}
		})
	}
}
