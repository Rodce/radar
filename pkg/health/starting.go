package health

import (
	"time"

	corev1 "k8s.io/api/core/v1"
)

// defaultStartupBudget is the startup a container gets when it declares no
// startup or readiness probe: the five minutes classifyPodLevel already gives
// a Pending pod before grading it degraded.
const defaultStartupBudget = 5 * time.Minute

// IsPodStarting reports a pod that is not ready only because it is still
// coming up: Pending while its containers are created or initialized, or
// Running with a container that has not passed its probes yet — with no
// restart, no container waiting for any other reason or exited with an error,
// and still inside its startup budget (podStartupBudget).
//
// The classifier grades such a pod healthy inside its startup grace, which
// can't tell "not ready yet" from "not ready". This can, and it never
// contradicts that grade: a pod the classifier flags is not starting.
func IsPodStarting(pod *corev1.Pod, now time.Time) bool {
	if pod == nil || pod.DeletionTimestamp != nil || PodHasSchedulingGates(pod) || IsPodUnschedulable(pod) {
		return false
	}
	switch pod.Status.Phase {
	case corev1.PodPending:
	case corev1.PodRunning:
		if containersReady(pod) || lostReadiness(pod) {
			return false
		}
	default:
		return false
	}
	return containersStartingCleanly(pod) && withinStartupBudget(pod, now) && Rank(classifyPodLevel(pod, now)) == 0
}

// containersReady matches the workload pod list's ready flag: every regular
// container ready, init containers and readiness gates aside.
func containersReady(pod *corev1.Pod) bool {
	for i := range pod.Status.ContainerStatuses {
		if !pod.Status.ContainerStatuses[i].Ready {
			return false
		}
	}
	return true
}

// lostReadiness reports a pod that was ready since its containers started and
// is not now: its Ready condition turned away from True after the last of them
// started. A pod coming up has been not ready since before its containers ran
// (the kubelet records that first, then starts them), so its Ready transition
// is older than any container's start. Being ready needs every container
// started, so a pod that was ready and lost it transitioned later than all of
// them.
func lostReadiness(pod *corev1.Pod) bool {
	var lastStart time.Time
	for i := range pod.Status.ContainerStatuses {
		if running := pod.Status.ContainerStatuses[i].State.Running; running != nil && running.StartedAt.After(lastStart) {
			lastStart = running.StartedAt.Time
		}
	}
	if lastStart.IsZero() {
		return false
	}
	for i := range pod.Status.Conditions {
		if c := &pod.Status.Conditions[i]; c.Type == corev1.PodReady {
			return c.Status != corev1.ConditionTrue && c.LastTransitionTime.After(lastStart)
		}
	}
	return false
}

func containersStartingCleanly(pod *corev1.Pod) bool {
	for i := range pod.Status.InitContainerStatuses {
		if !containerStartingCleanly(&pod.Status.InitContainerStatuses[i], true) {
			return false
		}
	}
	for i := range pod.Status.ContainerStatuses {
		if !containerStartingCleanly(&pod.Status.ContainerStatuses[i], false) {
			return false
		}
	}
	return true
}

func containerStartingCleanly(cs *corev1.ContainerStatus, init bool) bool {
	if cs.RestartCount > 0 {
		return false
	}
	if w := cs.State.Waiting; w != nil {
		return isStartupWaitingReason(w.Reason)
	}
	if t := cs.State.Terminated; t != nil {
		// A finished init container is a step done; a regular container that
		// exited is not starting, whatever its exit code.
		return init && t.ExitCode == 0
	}
	return true
}

// isStartupWaitingReason allows rather than denies: every other waiting
// reason is a failure or a back-off, so one this doesn't know is never read
// as starting.
func isStartupWaitingReason(reason string) bool {
	return reason == "ContainerCreating" || reason == "PodInitializing"
}

// withinStartupBudget counts from when the kubelet took the pod on (its
// creation until that is reported), so image pulls and init containers count
// against the budget and it errs toward ending early. A pod with neither time
// can't be placed in its window and gets none.
func withinStartupBudget(pod *corev1.Pod, now time.Time) bool {
	start := pod.CreationTimestamp.Time
	if pod.Status.StartTime != nil && !pod.Status.StartTime.IsZero() {
		start = pod.Status.StartTime.Time
	}
	return !start.IsZero() && now.Sub(start) < podStartupBudget(pod)
}

// podStartupBudget is the longest startup a regular container still coming up
// declares; one already ready is done starting, so a sidecar without probes
// doesn't stretch the app's budget to its five minutes. A startup probe bounds
// a container's own — the kubelet restarts it once that runs out. Without one
// the readiness probe stands in, and without either the container gets
// defaultStartupBudget.
func podStartupBudget(pod *corev1.Pod) time.Duration {
	ready := map[string]bool{}
	for i := range pod.Status.ContainerStatuses {
		if cs := &pod.Status.ContainerStatuses[i]; cs.Ready {
			ready[cs.Name] = true
		}
	}
	var budget time.Duration
	for i := range pod.Spec.Containers {
		c := &pod.Spec.Containers[i]
		if ready[c.Name] {
			continue
		}
		switch {
		case c.StartupProbe != nil:
			budget = max(budget, probeBudget(c.StartupProbe))
		case c.ReadinessProbe != nil:
			budget = max(budget, probeBudget(c.ReadinessProbe))
		default:
			budget = max(budget, defaultStartupBudget)
		}
	}
	return budget
}

// probeBudget is how long a probe may keep failing before the kubelet counts
// it failed: the initial delay plus failureThreshold periods. Unset fields
// take the API server's defaults.
func probeBudget(p *corev1.Probe) time.Duration {
	period, threshold := p.PeriodSeconds, p.FailureThreshold
	if period <= 0 {
		period = 10
	}
	if threshold <= 0 {
		threshold = 3
	}
	return time.Duration(p.InitialDelaySeconds)*time.Second + time.Duration(threshold)*time.Duration(period)*time.Second
}
