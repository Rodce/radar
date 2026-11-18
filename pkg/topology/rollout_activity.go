package topology

import (
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"

	"github.com/skyhook-io/radar/pkg/conditions"
	"github.com/skyhook-io/radar/pkg/gitops"
	"github.com/skyhook-io/radar/pkg/health"
	"github.com/skyhook-io/radar/pkg/k8score"
)

// Change in flight: what a node's controller is doing right now, kept on the
// node as data beside its status. Status and conditions stay what they are;
// these only let a surface show work as work.

// annotateWorkloadRollout puts a workload's rollout on its node the way the
// workload page and the applications list read it: health.WorkloadRollout,
// and a rollout whose updated revision has a Pod that cannot run is stalled
// (health.UpdatedRevisionFailure), whatever its controller still calls it.
// The node gets a spinner and moving edges while the rollout moves. Emitted
// only while there is a rollout to show.
//
// An Argo Rollout parked until someone promotes it also gets data.awaiting,
// the request a surface highlights. No other kind does: a workload whose
// strategy waits for its Pods to be deleted (OnDelete) may have an operator
// doing exactly that, and Radar can't tell whether anyone is waiting.
func annotateWorkloadRollout(data map[string]any, obj any, revisions *revisionIndex, now time.Time) {
	if data == nil {
		return
	}
	activity := health.WorkloadRollout(obj)
	if !activity.Active && activity.Phase != health.RolloutStalled {
		return
	}
	activity = health.UpdatedRevisionFailure(activity, revisions.updatedPods(obj), now)
	data["rollout"] = map[string]any{
		"phase":  string(activity.Phase),
		"active": activity.Active,
		"manual": activity.Manual,
		"label":  activity.Label,
		"detail": activity.Detail,
	}
	if rollout, ok := obj.(*unstructured.Unstructured); ok && activity.Active && activity.Manual &&
		rollout.GetKind() == "Rollout" && rollout.GroupVersionKind().Group == "argoproj.io" && rollout.GetDeletionTimestamp() == nil {
		awaiting := map[string]any{"label": activity.Label, "detail": activity.Detail}
		if activity.Gate != "" {
			awaiting["gate"] = activity.Gate
		}
		data["awaiting"] = awaiting
	}
}

// revisionIndex finds the Pods of a workload's updated revision, for
// health.UpdatedRevisionFailure: a Deployment's and an Argo Rollout's through
// their current ReplicaSet, a StatefulSet's by its update revision, a
// DaemonSet's by its template generation. Built on first use, once per
// topology build, so a cluster with no rollout under way never pays for it.
type revisionIndex struct {
	provider       ResourceProvider
	built          bool
	podsByOwner    map[types.UID][]*corev1.Pod
	rsByOwner      map[types.UID][]*appsv1.ReplicaSet
	deploymentHash map[types.UID]string
}

func newRevisionIndex(provider ResourceProvider) *revisionIndex {
	return &revisionIndex{provider: provider}
}

func (r *revisionIndex) build() {
	if r.built {
		return
	}
	r.built = true
	r.podsByOwner = map[types.UID][]*corev1.Pod{}
	r.rsByOwner = map[types.UID][]*appsv1.ReplicaSet{}
	if r.provider == nil {
		return
	}
	pods, _ := r.provider.Pods()
	for _, pod := range pods {
		if pod == nil || pod.DeletionTimestamp != nil {
			continue
		}
		if owner := metav1.GetControllerOf(pod); owner != nil {
			r.podsByOwner[owner.UID] = append(r.podsByOwner[owner.UID], pod)
		}
	}
	replicaSets, _ := r.provider.ReplicaSets()
	for _, rs := range replicaSets {
		if rs == nil {
			continue
		}
		if owner := metav1.GetControllerOf(rs); owner != nil {
			r.rsByOwner[owner.UID] = append(r.rsByOwner[owner.UID], rs)
		}
	}
	r.deploymentHash = k8score.CurrentDeploymentRevisionPodHashes(replicaSets)
}

// updatedPods returns the Pods of obj's updated revision; nil when it can't
// tell which revision that is.
func (r *revisionIndex) updatedPods(obj any) []*corev1.Pod {
	if r == nil {
		return nil
	}
	switch w := obj.(type) {
	case *appsv1.Deployment:
		r.build()
		return r.replicaSetPods(w.UID, appsv1.DefaultDeploymentUniqueLabelKey, r.deploymentHash[w.UID])
	case *appsv1.StatefulSet:
		r.build()
		return r.ownPods(w.UID, appsv1.ControllerRevisionHashLabelKey, w.Status.UpdateRevision)
	case *appsv1.DaemonSet:
		// The DaemonSet controller labels each Pod with the template
		// generation it was created from, kept on the DaemonSet as this
		// annotation.
		r.build()
		return r.ownPods(w.UID, "pod-template-generation", w.Annotations["deprecated.daemonset.template.generation"])
	case *unstructured.Unstructured:
		if w.GetKind() != "Rollout" || w.GroupVersionKind().Group != "argoproj.io" {
			return nil
		}
		hash, _, _ := unstructured.NestedString(w.Object, "status", "currentPodHash")
		r.build()
		return r.replicaSetPods(w.GetUID(), "rollouts-pod-template-hash", hash)
	}
	return nil
}

func (r *revisionIndex) replicaSetPods(owner types.UID, label, value string) []*corev1.Pod {
	if value == "" {
		return nil
	}
	var pods []*corev1.Pod
	for _, rs := range r.rsByOwner[owner] {
		if rs.Labels[label] == value {
			pods = append(pods, r.podsByOwner[rs.UID]...)
		}
	}
	return pods
}

func (r *revisionIndex) ownPods(owner types.UID, label, value string) []*corev1.Pod {
	if value == "" {
		return nil
	}
	var pods []*corev1.Pod
	for _, pod := range r.podsByOwner[owner] {
		if pod.Labels[label] == value {
			pods = append(pods, pod)
		}
	}
	return pods
}

// AnnotateResourceProgress marks a custom resource whose controller is at
// work, in its own words and from its own clock: inProgress, inProgressSince,
// inProgressMessage, and inProgressUntil, the moment the reading lapses
// (conditions.ProgressWindow after the controller last said so), so a
// surface that does not rebuild for a while can still let it go on time.
// conditions.InProgress decides for most kinds (a cert-manager Certificate
// being issued, a Crossplane resource being created). A Flagger Canary is
// read by its phase: moving by itself, under the same window counted from
// the Canary's last status report, or parked on a confirmation hook
// (data.awaiting), which only someone outside Flagger can answer.
//
// The node's status is left as it is: other readers of topology (the issue
// queue, MCP, the Argo CD tree) rely on it. Exported for the GitOps tree,
// which reads the same objects outside topology.
func AnnotateResourceProgress(data map[string]any, obj *unstructured.Unstructured, now time.Time) {
	if data == nil || obj == nil || obj.GetDeletionTimestamp() != nil {
		return
	}
	if obj.GroupVersionKind().Group == "flagger.app" && obj.GetKind() == "Canary" {
		phase, moving, awaiting, since := health.FlaggerCanaryActivity(obj)
		switch {
		case moving && !since.IsZero() && now.Sub(since) <= conditions.ProgressWindow:
			markProgress(data, "Flagger: "+phase, since)
		case awaiting:
			label := "Waiting for rollout confirmation"
			if phase == "WaitingPromotion" {
				label = "Waiting for promotion"
			}
			data["awaiting"] = map[string]any{"label": label, "detail": "Flagger is waiting for a confirmation hook to approve"}
		}
		return
	}
	if _, set := data["inProgress"]; set {
		return
	}
	if progress, ok := conditions.InProgressAt(obj, now); ok {
		markProgress(data, firstNonEmptyString(progress.Message, progress.Reason), progress.Since)
	}
}

func markProgress(data map[string]any, message string, since time.Time) {
	data["inProgress"] = "reconciling"
	data["inProgressSince"] = since.UTC().Format(time.RFC3339)
	data["inProgressUntil"] = since.Add(conditions.ProgressWindow).UTC().Format(time.RFC3339)
	if message != "" {
		data["inProgressMessage"] = message
	}
}

func firstNonEmptyString(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// annotateFluxActivity marks a Flux object whose controller is at work:
// "reconciling" for a pass in flight, with the controller's own words, or
// "requested" for a reconcile it has not picked up yet. The reading the GitOps
// tree spins for (gitops.FluxInFlight, so never a failure that merely keeps
// retrying, and never a suspended object).
func annotateFluxActivity(data map[string]any, obj *unstructured.Unstructured) {
	if data == nil || obj == nil {
		return
	}
	state := gitops.FluxStatus(obj)
	if state.Health == "Suspended" {
		return
	}
	activity := gitops.FluxActivity(obj)
	inFlight := gitops.FluxInFlight(state)
	if !inFlight && !activity.Requested {
		return
	}
	if !inFlight {
		data["inProgress"] = "requested"
		return
	}
	data["inProgress"] = "reconciling"
	if activity.Since != "" {
		data["inProgressSince"] = activity.Since
	}
	if activity.Message != "" {
		data["inProgressMessage"] = activity.Message
	}
}

// podStartup counts, for one workload, the Pods that are not ready and how
// many of those are merely starting.
type podStartup struct{ notReady, starting int32 }

// podStartupTallies counts not-ready Pods per controlling workload, by UID. A
// ReplicaSet's Pods also count toward the Deployment that owns it. Pods on
// their way out and finished Pods are no replica of anything and are left out.
func (b *Builder) podStartupTallies(now time.Time) map[types.UID]podStartup {
	tallies := map[types.UID]podStartup{}
	pods, _ := b.provider.Pods()
	for _, pod := range pods {
		if pod == nil || pod.DeletionTimestamp != nil || pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed || podReady(pod) {
			continue
		}
		owner := metav1.GetControllerOf(pod)
		if owner == nil {
			continue
		}
		tally := tallies[owner.UID]
		tally.notReady++
		if health.IsPodStarting(pod, now) {
			tally.starting++
		}
		tallies[owner.UID] = tally
	}
	if len(tallies) == 0 {
		return tallies
	}
	replicasets, _ := b.provider.ReplicaSets()
	for _, rs := range replicasets {
		if rs == nil {
			continue
		}
		tally, ok := tallies[rs.UID]
		if !ok {
			continue
		}
		if owner := metav1.GetControllerOf(rs); owner != nil && owner.Kind == "Deployment" {
			sum := tallies[owner.UID]
			sum.notReady += tally.notReady
			sum.starting += tally.starting
			tallies[owner.UID] = sum
		}
	}
	return tallies
}

func podReady(pod *corev1.Pod) bool {
	for i := range pod.Status.Conditions {
		if pod.Status.Conditions[i].Type == corev1.PodReady {
			return pod.Status.Conditions[i].Status == corev1.ConditionTrue
		}
	}
	return false
}

// applyStarting grades a workload that is short of ready replicas only
// because its Pods are still starting as neutral, and says so in its data.
// The replica count alone calls that NoneReady or PartiallyReady, so every
// ordinary rollout, scale-up and first install paints its workloads red or
// amber until the Pods pass their probes. This asks for evidence instead:
// every missing replica must exist as a Pod, and every Pod that is not ready
// must be one health.IsPodStarting vouches for (no restart, no failing
// container, inside its startup budget). A ReplicaSet that can't create its
// Pods, a crash loop, an image that won't pull or a Pod past its budget keeps
// the workload's own verdict. The ready and desired counts stay on the node.
func applyStarting(node *Node, tally podStartup, missing int32) {
	if node.Status != StatusUnhealthy && node.Status != StatusDegraded {
		return
	}
	if missing <= 0 || tally.notReady < missing || tally.starting != tally.notReady {
		return
	}
	node.Status = StatusNeutral
	if node.Data == nil {
		node.Data = map[string]any{}
	}
	node.Data["starting"] = true
}
