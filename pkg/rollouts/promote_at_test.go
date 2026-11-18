package rollouts

import (
	"context"
	"errors"
	"testing"
)

const pausedAt = "2026-11-18T10:00:00Z"

// A canary with two untimed pauses, waiting at the one at stepIndex.
func waitingCanary(stepIndex int64, startTime string) func(map[string]any) {
	return func(o map[string]any) {
		o["metadata"].(map[string]any)["resourceVersion"] = "41"
		o["spec"].(map[string]any)["strategy"] = map[string]any{"canary": map[string]any{"steps": []any{
			map[string]any{"setWeight": int64(20)},
			map[string]any{"pause": map[string]any{}},
			map[string]any{"setWeight": int64(50)},
			map[string]any{"pause": map[string]any{}},
		}}}
		o["status"] = map[string]any{
			"phase":            "Paused",
			"currentStepIndex": stepIndex,
			"pauseConditions":  []any{map[string]any{"reason": "CanaryPauseStep", "startTime": startTime}},
		}
	}
}

func TestPromoteAtClearsTheConfirmedPauseOnTheCheckedVersion(t *testing.T) {
	client := newFakeRollouts(rolloutForTest("prod", "web", waitingCanary(1, pausedAt)))

	if _, err := PromoteAt(context.Background(), client, "prod", "web", "step:1@"+pausedAt); err != nil {
		t.Fatalf("PromoteAt: %v", err)
	}
	body := statusPatchBody(t, client)
	if v, present := body["status"].(map[string]any)["pauseConditions"]; !present || v != nil {
		t.Errorf("status.pauseConditions = %v, want explicit null", v)
	}
	metadata, _ := body["metadata"].(map[string]any)
	if metadata["resourceVersion"] != "41" {
		t.Errorf("patch metadata = %v, want the checked resourceVersion 41", metadata)
	}
}

// Someone else promoted the pause this one was confirmed for, and the Rollout
// now waits at the next untimed pause: still "Waiting for promotion", but not
// the pause the person saw.
func TestPromoteAtRefusesALaterPause(t *testing.T) {
	client := newFakeRollouts(rolloutForTest("prod", "web", waitingCanary(3, "2026-11-18T10:05:00Z")))

	_, err := PromoteAt(context.Background(), client, "prod", "web", "step:1@"+pausedAt)
	if !errors.Is(err, ErrPauseChanged) {
		t.Fatalf("err = %v, want ErrPauseChanged", err)
	}
	if patches := recordedPatches(t, client); len(patches) != 0 {
		t.Errorf("sent %d patches for a pause nobody confirmed", len(patches))
	}
}

// A Rollout that stopped waiting must not have its step moved: that is the
// step skip a plain promote performs on a canary with nothing paused.
func TestPromoteAtRefusesARolloutNoLongerWaiting(t *testing.T) {
	client := newFakeRollouts(rolloutForTest("prod", "web", func(o map[string]any) {
		waitingCanary(2, pausedAt)(o)
		o["status"] = map[string]any{"phase": "Progressing", "currentStepIndex": int64(2)}
	}))

	_, err := PromoteAt(context.Background(), client, "prod", "web", "step:1@"+pausedAt)
	if !errors.Is(err, ErrPauseChanged) {
		t.Fatalf("err = %v, want ErrPauseChanged", err)
	}
	if patches := recordedPatches(t, client); len(patches) != 0 {
		t.Errorf("sent %d patches to a Rollout that no longer waits", len(patches))
	}
}

func TestPromoteSendsNoResourceVersion(t *testing.T) {
	client := newFakeRollouts(rolloutForTest("prod", "web", waitingCanary(1, pausedAt)))

	if _, err := Promote(context.Background(), client, "prod", "web"); err != nil {
		t.Fatalf("Promote: %v", err)
	}
	if _, present := statusPatchBody(t, client)["metadata"]; present {
		t.Error("an unbound promote made its patch conditional")
	}
}
