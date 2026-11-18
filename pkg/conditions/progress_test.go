package conditions

import (
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func withConditions(spec map[string]any, conds ...map[string]any) *unstructured.Unstructured {
	raw := make([]any, 0, len(conds))
	for _, c := range conds {
		raw = append(raw, c)
	}
	obj := map[string]any{"status": map[string]any{"conditions": raw}}
	if spec != nil {
		obj["spec"] = spec
	}
	return &unstructured.Unstructured{Object: obj}
}

// condition dates each type differently, so a test can tell which condition
// the reading took its words and its time from.
func condition(typ, status, reason string) map[string]any {
	minute := map[string]string{"Ready": "00", "Issuing": "01", "Reconciling": "02", "Synced": "03", "Stalled": "04", "Available": "05", "Progressing": "06"}[typ]
	return map[string]any{"type": typ, "status": status, "reason": reason, "message": typ + " " + reason, "lastTransitionTime": "2026-11-18T10:" + minute + ":00Z"}
}

// In progress is the controller's own word for it, never a failure that keeps
// being retried and never a pause.
func TestInProgress(t *testing.T) {
	cases := []struct {
		name string
		obj  *unstructured.Unstructured
		want string // type and reason of the condition that says so; "" = not in progress
	}{
		{"cert-manager issuing a first certificate", withConditions(nil, condition("Ready", "False", "DoesNotExist"), condition("Issuing", "True", "DoesNotExist")), "Issuing DoesNotExist"},
		{"cert-manager renewing a valid certificate", withConditions(nil, condition("Ready", "True", "Ready"), condition("Issuing", "True", "Renewing")), "Issuing Renewing"},
		{"cert-manager issuance failed", withConditions(nil, condition("Ready", "False", "DoesNotExist"), condition("Issuing", "False", "Failed")), ""},
		{"crossplane creating the external resource", withConditions(nil, condition("Synced", "True", "ReconcileSuccess"), condition("Ready", "False", "Creating")), "Ready Creating"},
		{"crossplane cannot reconcile", withConditions(nil, condition("Ready", "False", "Creating"), condition("Synced", "False", "ReconcileError")), ""},
		{"kstatus reconciling", withConditions(nil, condition("Ready", "Unknown", "Progressing"), condition("Reconciling", "True", "Progressing")), "Reconciling Progressing"},
		{"kstatus retrying after a failure", withConditions(nil, condition("Reconciling", "True", "ProgressingWithRetry"), condition("Ready", "False", "InstallFailed")), ""},
		{"kstatus stalled", withConditions(nil, condition("Stalled", "True", "Failed"), condition("Reconciling", "True", "Progressing")), ""},
		{"ready unknown for a still-reconciling reason", withConditions(nil, condition("Ready", "Unknown", "Pending")), "Ready Pending"},
		{"suspended", withConditions(map[string]any{"suspend": true}, condition("Ready", "False", "Creating")), ""},
		{"settled", withConditions(nil, condition("Ready", "True", "Available")), ""},
		{"cert-manager re-issuing an expired certificate", withConditions(nil, condition("Ready", "False", "Expired"), condition("Issuing", "True", "Expired")), ""},
		{"a Deployment-style Progressing=True long after the rollout", withConditions(nil, condition("Available", "True", "MinimumReplicasAvailable"), condition("Progressing", "True", "NewReplicaSetAvailable")), ""},
	}
	now := time.Date(2026, 11, 18, 10, 2, 0, 0, time.UTC)
	for _, c := range cases {
		got, ok := InProgressAt(c.obj, now)
		if ok != (c.want != "") || got.Message != c.want {
			t.Errorf("%s: got (%q, %v), want %q", c.name, got.Message, ok, c.want)
			continue
		}
		if !ok {
			continue
		}
		// The time is the speaking condition's own, not another's.
		for _, raw := range c.obj.Object["status"].(map[string]any)["conditions"].([]any) {
			cond := raw.(map[string]any)
			if cond["message"] == c.want && got.Since.Format(time.RFC3339) != cond["lastTransitionTime"] {
				t.Errorf("%s: since %v, want %v", c.name, got.Since, cond["lastTransitionTime"])
			}
		}
	}
	if _, ok := InProgressAt(nil, now); ok {
		t.Error("nil object reads as in progress")
	}
	deleting := withConditions(nil, condition("Ready", "Unknown", "Progressing"), condition("Reconciling", "True", "Progressing"))
	deleting.SetDeletionTimestamp(&metav1.Time{Time: now})
	if _, ok := InProgressAt(deleting, now); ok {
		t.Error("an object being deleted reads as work toward its desired state")
	}
}

// A controller's "still working" is taken at its word for ProgressWindow and
// no longer: a pass that never ends must not read as progress forever, and one
// that cannot be dated cannot be bounded.
func TestInProgressIsBounded(t *testing.T) {
	issuing := withConditions(nil, condition("Ready", "False", "DoesNotExist"), condition("Issuing", "True", "DoesNotExist"))
	started := time.Date(2026, 11, 18, 10, 1, 0, 0, time.UTC) // Issuing's transition
	if _, ok := InProgressAt(issuing, started.Add(ProgressWindow)); !ok {
		t.Error("work inside the window does not read as in progress")
	}
	if _, ok := InProgressAt(issuing, started.Add(ProgressWindow+time.Second)); ok {
		t.Error("work past the window still reads as in progress")
	}
	undated := withConditions(nil, map[string]any{"type": "Ready", "status": "False", "reason": "Creating"})
	if _, ok := InProgressAt(undated, started); ok {
		t.Error("a condition with no transition time reads as in progress")
	}
}
