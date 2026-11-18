package health

import (
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// FlaggerCanary describes the recorded rollout outcome and requested suspension.
// CanaryStatus has no observedGeneration; this is not a latest-spec guarantee.
// Promoted=False is normal during analysis, so it is not a failure on its own.
func FlaggerCanary(u *unstructured.Unstructured) Verdict {
	if u == nil {
		return Verdict{Level: LevelUnknown, Reason: "Not reported"}
	}
	phase, _, _ := unstructured.NestedString(u.Object, "status", "phase")
	if phase == "Failed" {
		return Verdict{Level: LevelUnhealthy, Reason: "Failed"}
	}
	suspended, _, _ := unstructured.NestedBool(u.Object, "spec", "suspend")
	if suspended && phase == "" {
		return Verdict{Level: LevelNeutral, Reason: "Suspend requested"}
	}
	switch phase {
	case "Succeeded":
		if suspended {
			return Verdict{Level: LevelNeutral, Reason: phase}
		}
		return Verdict{Level: LevelHealthy, Reason: phase}
	case "Initializing", "Initialized", "Waiting", "Progressing", "WaitingPromotion", "Promoting", "Finalising", "Terminating", "Terminated":
		return Verdict{Level: LevelNeutral, Reason: phase}
	case "":
		return Verdict{Level: LevelUnknown, Reason: "Not reported"}
	default:
		return Verdict{Level: LevelUnknown, Reason: phase}
	}
}

// FlaggerCanaryActivity says whether a Canary is moving by itself, or parked
// on a confirmation hook that only someone outside Flagger can answer: Waiting
// is the confirm-rollout gate, WaitingPromotion the confirm-promotion gate.
// Neither while it is suspended or being deleted. since is the Canary's
// status.lastTransitionTime, the last time Flagger reported on it; zero when
// it carries none.
func FlaggerCanaryActivity(u *unstructured.Unstructured) (phase string, moving, awaiting bool, since time.Time) {
	if u == nil || u.GetDeletionTimestamp() != nil {
		return "", false, false, time.Time{}
	}
	if suspended, _, _ := unstructured.NestedBool(u.Object, "spec", "suspend"); suspended {
		return "", false, false, time.Time{}
	}
	phase, _, _ = unstructured.NestedString(u.Object, "status", "phase")
	if ts, _, _ := unstructured.NestedString(u.Object, "status", "lastTransitionTime"); ts != "" {
		if t, err := time.Parse(time.RFC3339, ts); err == nil {
			since = t
		}
	}
	switch phase {
	case "Initializing", "Progressing", "Promoting", "Finalising":
		return phase, true, false, since
	case "Waiting", "WaitingPromotion":
		return phase, false, true, since
	}
	return phase, false, false, since
}
