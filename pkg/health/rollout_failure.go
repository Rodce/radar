package health

import (
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
)

// UpdatedRevisionFailure reads a rollout whose updated revision has a Pod that
// cannot run as stalled: "New revision cannot start", with that Pod's problem.
// The workload controller keeps calling such a rollout progressing until its
// deadline passes (ten minutes by default for a Deployment, never for most
// others); shown as motion, or as a rollout waiting to be promoted, it would
// claim progress that isn't happening.
//
// pods are the Pods of the updated revision only; the caller knows which
// revision that is. A rollout the controller has not observed yet is left
// alone: until it has, the "updated" revision is still the old one.
func UpdatedRevisionFailure(activity WorkloadRolloutActivity, pods []*corev1.Pod, now time.Time) WorkloadRolloutActivity {
	if (!activity.Active && activity.Phase != RolloutStalled) || activity.Phase == RolloutApplying {
		return activity
	}
	var failed *corev1.Pod
	for _, pod := range pods {
		if pod == nil || !RevisionPodFailing(pod, now) {
			continue
		}
		if failed == nil || pod.Name < failed.Name {
			failed = pod
		}
	}
	if failed == nil {
		return activity
	}
	activity.Phase = RolloutStalled
	activity.Active = false
	activity.Manual = false
	activity.Gate = ""
	activity.Label = "New revision cannot start"
	activity.Detail = fmt.Sprintf("%s · Pod %s", PodProblemReason(failed, now), failed.Name)
	return activity
}

// RevisionPodFailing reports whether a Pod of a rollout's updated revision
// shows that revision cannot run. The workload page gets the verdict on each
// Pod (podlogs.PodInfo.RevisionFailing) instead of deciding it again.
//
// A crash-looping container runs, and may even pass its probes, for a while
// after each restart. Its crash history keeps it failing across that window,
// as it does for the Pod's own health; without it the rollout would read as
// waiting for promotion between crashes.
//
// A Pod that has ended or is being deleted says nothing about whether the
// revision can run: an evicted Pod, or one stopped with its node, stays in the
// API until it is garbage-collected while its replacement runs. A revision
// whose replacements keep ending that way runs into its progress deadline.
func RevisionPodFailing(pod *corev1.Pod, now time.Time) bool {
	if pod.DeletionTimestamp != nil || pod.Status.Phase == corev1.PodFailed || pod.Status.Phase == corev1.PodSucceeded {
		return false
	}
	return Pod(pod, now).Level == LevelUnhealthy || podHasStableCrashLoop(pod, now)
}
