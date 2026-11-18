package conditions

import (
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Progress is what a controller reports about work it has not finished: the
// reason of the condition that says so, its message, and since when.
type Progress struct {
	Reason  string
	Message string
	// Since is the condition's lastTransitionTime; zero when it carries none.
	Since time.Time
}

// ProgressWindow is how long a controller's "still working" is taken at its
// word, counted from the transition of the condition that says so. Nothing in
// the conditions contract ends a pass that never finishes: a certificate
// waiting on an issuer that cannot answer keeps Issuing=True for days. Past
// the window the object reads by its underlying status again, as it would
// without this reading. Ten minutes is the bound Radar already puts on a Helm
// release stuck in a pending state.
const ProgressWindow = 10 * time.Minute

// InProgress reports an object whose controller says it is still working
// toward its desired state, as opposed to settled or failing, and started
// within ProgressWindow. It reads the conditions the generic checks read, by
// the same still-reconciling reasons the issue detectors use
// (IsInProgressForIssues), so a Ready=False that the issue queue holds back
// as not-yet-settled is what reads as work here, and one it reports does not.
//
// In order:
//   - an object being deleted, a suspended one (spec.suspend) and one its
//     controller gave up on (kstatus Stalled=True) are not in progress;
//   - cert-manager's Issuing=True is, on its own word: the controller turns it
//     False the moment an issuance fails. Not for a certificate that has
//     already expired (Ready=False, Expired): that one is broken now, however
//     hard cert-manager is working on it;
//   - a health condition that is False for any other reason is a failure, and
//     a failure outranks activity: a controller that retries after one keeps
//     Reconciling=True for as long as it retries;
//   - otherwise kstatus's Reconciling=True, or a health condition that is
//     False or Unknown for a still-reconciling reason, is.
//
// Progressing is not read: Deployments, and the kinds that copy them, keep
// Progressing=True long after the rollout is complete. A condition with no
// transition time cannot be placed inside the window and does not count.
func InProgress(obj *unstructured.Unstructured) (Progress, bool) {
	return InProgressAt(obj, time.Now())
}

// InProgressAt is InProgress against a given clock.
func InProgressAt(obj *unstructured.Unstructured, now time.Time) (Progress, bool) {
	progress, ok := reportedProgress(obj)
	if !ok || progress.Since.IsZero() || now.Sub(progress.Since) > ProgressWindow {
		return Progress{}, false
	}
	return progress, true
}

// healthConditionTypes is DefaultFalseConditionTypes as a set.
var healthConditionTypes = func() map[string]bool {
	set := make(map[string]bool, len(DefaultFalseConditionTypes))
	for _, t := range DefaultFalseConditionTypes {
		set[t] = true
	}
	return set
}()

// reportedProgress is what the controller reports, whenever it started.
func reportedProgress(obj *unstructured.Unstructured) (Progress, bool) {
	if obj == nil || obj.GetDeletionTimestamp() != nil {
		return Progress{}, false
	}
	if spec, _ := obj.Object["spec"].(map[string]any); spec != nil {
		if suspended, _ := spec["suspend"].(bool); suspended {
			return Progress{}, false
		}
	}
	var issuing, reconciling, pending *Progress
	failing, expired := false, false
	for _, cond := range objectConditions(obj) {
		typ, _ := cond["type"].(string)
		status, _ := cond["status"].(string)
		reason, _ := cond["reason"].(string)
		if typ == "Ready" && status == "False" && reason == "Expired" {
			expired = true
		}
		switch {
		case typ == "Stalled" && status == "True":
			return Progress{}, false
		case typ == "Issuing" && status == "True" && issuing == nil:
			issuing = progressOf(cond)
		case typ == "Reconciling" && status == "True" && reconciling == nil:
			reconciling = progressOf(cond)
		case healthConditionTypes[typ] && status == "False" && !IsInProgressForIssues(reason):
			failing = true
		case healthConditionTypes[typ] && (status == "False" || status == "Unknown") && IsInProgressForIssues(reason) && pending == nil:
			pending = progressOf(cond)
		}
	}
	switch {
	case issuing != nil && !expired:
		return *issuing, true
	case failing:
		return Progress{}, false
	case reconciling != nil:
		return *reconciling, true
	case pending != nil:
		return *pending, true
	}
	return Progress{}, false
}

// objectConditions lists status.v1beta2.conditions before status.conditions,
// the precedence Find and FindFalseCondition keep. It reads the object in
// place: this runs for every custom resource on every topology build.
func objectConditions(obj *unstructured.Unstructured) []map[string]any {
	status, _ := obj.Object["status"].(map[string]any)
	if status == nil {
		return nil
	}
	var out []map[string]any
	add := func(raw any) {
		list, _ := raw.([]any)
		for _, c := range list {
			if cond, ok := c.(map[string]any); ok {
				out = append(out, cond)
			}
		}
	}
	if v1beta2, _ := status["v1beta2"].(map[string]any); v1beta2 != nil {
		add(v1beta2["conditions"])
	}
	add(status["conditions"])
	return out
}

func progressOf(cond map[string]any) *Progress {
	p := &Progress{}
	p.Reason, _ = cond["reason"].(string)
	p.Message, _ = cond["message"].(string)
	if ts, _ := cond["lastTransitionTime"].(string); ts != "" {
		if t, err := time.Parse(time.RFC3339, ts); err == nil {
			p.Since = t
		}
	}
	return p
}
