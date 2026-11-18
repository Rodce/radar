package server

import (
	"context"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/skyhook-io/radar/pkg/gitops"
	"github.com/skyhook-io/radar/pkg/packages"
)

// enrichRowsWithFluxStatus gives a row delivered by a Flux HelmRelease or
// Kustomization its source's delivery state and rolls it into the row's
// health, as enrichRowsWithArgoStatus does for an Argo CD Application.
func enrichRowsWithFluxStatus(ctx context.Context, cache resourceLister, rows []appRow) {
	objects := gitOpsSourceObjects(ctx, cache, rows, "fluxcd")
	for i := range rows {
		ref := rows[i].SourceRef
		if ref == nil || ref.Type != "gitops" || ref.Tool != "fluxcd" {
			continue
		}
		obj := objects[sourceObjectKey(ref.Group, ref.Kind, ref.Namespace, ref.Name)]
		if obj == nil {
			continue
		}
		status := fluxSourceStatus(obj)
		if status == nil {
			continue
		}
		rows[i].SourceStatus = status
		if status.Sync != "" || status.Health != "" {
			rows[i].Health = string(packages.WorseHealth(packages.Health(rows[i].RuntimeHealth), argoDeliveryHealth(status.Sync, status.Health)))
		}
	}
}

// withLiveSourceActivity refreshes each GitOps-sourced row's delivery state
// from the live controller object, at response time. Rows are cached for
// applicationsCacheTTL and the page polls slower still, so a 30s upgrade read
// at build time would show late or not at all. Runs on the caller's copy,
// after sources the caller can't read were withheld
// (filterApplicationSources): it never mutates the shared rows, and it leaves
// the health rollup to the build.
func withLiveSourceActivity(ctx context.Context, cache resourceLister, rows []appRow) []appRow {
	objects := gitOpsSourceObjects(ctx, cache, rows, "")
	if len(objects) == 0 {
		return rows
	}
	out := append([]appRow(nil), rows...)
	for i := range out {
		ref := out[i].SourceRef
		if ref == nil || ref.Type != "gitops" {
			continue
		}
		obj := objects[sourceObjectKey(ref.Group, ref.Kind, ref.Namespace, ref.Name)]
		if obj == nil {
			continue
		}
		switch ref.Tool {
		case "fluxcd":
			out[i].SourceStatus = fluxSourceStatus(obj)
		case "argocd":
			out[i].SourceStatus = argoSourceStatus(obj)
		}
	}
	return out
}

// readOnlyResourceLister lists the cached objects themselves, without the
// copy ListDynamicWithGroup makes of each (k8s.ResourceCache).
type readOnlyResourceLister interface {
	ListDynamicWithGroupReadOnly(ctx context.Context, kind, namespace, group string) ([]*unstructured.Unstructured, error)
}

// gitOpsSourceObjects lists the controller objects the rows' GitOps sources
// name, one list per kind in use. tool narrows it to one tool's sources; ""
// takes both.
//
// The lists are cluster-wide and run on every applications request (the live
// refresh is outside the row cache), so they read the cached objects without
// copying them: a large Argo CD install holds thousands of Applications, each
// with its status.resources and history. Every caller only reads them, within
// the request.
func gitOpsSourceObjects(ctx context.Context, cache resourceLister, rows []appRow, tool string) map[string]*unstructured.Unstructured {
	list := cache.ListDynamicWithGroup
	if readOnly, ok := cache.(readOnlyResourceLister); ok {
		list = readOnly.ListDynamicWithGroupReadOnly
	}
	wanted := map[string]bool{}
	for _, row := range rows {
		if ref := row.SourceRef; ref != nil && ref.Type == "gitops" && (tool == "" || ref.Tool == tool) {
			wanted[ref.Group+"/"+ref.Kind] = true
		}
	}
	objects := map[string]*unstructured.Unstructured{}
	for _, source := range []struct{ group, kind string }{
		{"helm.toolkit.fluxcd.io", "HelmRelease"},
		{"kustomize.toolkit.fluxcd.io", "Kustomization"},
		{"argoproj.io", "Application"},
	} {
		if !wanted[source.group+"/"+source.kind] {
			continue
		}
		items, err := list(ctx, source.kind, "", source.group)
		if err != nil {
			continue
		}
		for _, item := range items {
			if item != nil {
				objects[sourceObjectKey(source.group, source.kind, item.GetNamespace(), item.GetName())] = item
			}
		}
	}
	return objects
}

func sourceObjectKey(group, kind, namespace, name string) string {
	return group + "/" + kind + "/" + namespace + "/" + name
}

// fluxSourceStatus is a Flux source's delivery state: nil when there is
// nothing to say.
//
// The verdict joins the row only when it is news: failing, out of sync, in
// progress or paused. A settled Synced and Healthy source adds nothing the
// runtime verdict doesn't already say, and rolling it into the row's health
// would turn every scaled-to-zero app from idle to healthy.
//
// A pass in flight is gitops.FluxInFlight, so a source that fails and keeps
// retrying shows its failure, not motion.
func fluxSourceStatus(obj *unstructured.Unstructured) *appSourceStatus {
	state := gitops.FluxStatus(obj)
	if state.Health == "Suspended" {
		return &appSourceStatus{Sync: state.Sync, Health: state.Health, Suspended: true}
	}
	var status appSourceStatus
	news := state.Health == "Degraded" || state.Health == "Progressing" || state.Sync == "OutOfSync" || state.Sync == "Reconciling"
	if news {
		status.Sync, status.Health = state.Sync, state.Health
	}
	activity := gitops.FluxActivity(obj)
	if gitops.FluxInFlight(state) {
		status.Reconciling = true
		status.Since = activity.Since
	}
	status.ReconcileRequested = activity.Requested
	if status == (appSourceStatus{}) {
		return nil
	}
	status.Message = activity.Message
	if status.Reconciling || status.ReconcileRequested {
		status.Timeout = activity.Timeout
	}
	return &status
}

// argoSourceStatus is an Argo CD Application's sync and health, plus a sync
// operation in flight and a suspension Radar made. Nil when the Application
// reports nothing yet.
func argoSourceStatus(obj *unstructured.Unstructured) *appSourceStatus {
	var status appSourceStatus
	status.Sync, _, _ = unstructured.NestedString(obj.Object, "status", "sync", "status")
	status.Health, _, _ = unstructured.NestedString(obj.Object, "status", "health", "status")
	status.Suspended = gitops.ArgoSuspendedByRadar(obj)
	if gitops.ArgoOperationInProgress(obj) {
		status.Reconciling = true
		status.Since, _, _ = unstructured.NestedString(obj.Object, "status", "operationState", "startedAt")
		status.Message, _, _ = unstructured.NestedString(obj.Object, "status", "operationState", "message")
	}
	if status == (appSourceStatus{}) {
		return nil
	}
	return &status
}
