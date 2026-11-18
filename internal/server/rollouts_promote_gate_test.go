package server

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/skyhook-io/radar/pkg/rollouts"
)

func TestReadPromoteGate(t *testing.T) {
	s := &Server{}
	cases := []struct {
		name     string
		body     string
		wantGate string
		wantOK   bool
		status   int
	}{
		// The Rollout's own page sends no body: an unbound promote.
		{name: "no body", body: "", wantOK: true},
		{name: "gate", body: `{"gate":"step:1@2026-11-18T10:00:00Z"}`, wantGate: "step:1@2026-11-18T10:00:00Z", wantOK: true},
		{name: "unknown field", body: `{"step":1}`, status: http.StatusBadRequest},
		{name: "not JSON", body: `step:1`, status: http.StatusBadRequest},
		{name: "too large", body: `{"gate":"` + strings.Repeat("x", promoteBodyLimit) + `"}`, status: http.StatusRequestEntityTooLarge},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/api/rollouts/prod/web/promote", strings.NewReader(tc.body))
			w := httptest.NewRecorder()
			gate, ok := s.readPromoteGate(w, r)
			if ok != tc.wantOK || gate != tc.wantGate {
				t.Fatalf("readPromoteGate = (%q, %t), want (%q, %t)", gate, ok, tc.wantGate, tc.wantOK)
			}
			if !ok && w.Code != tc.status {
				t.Fatalf("status = %d, want %d", w.Code, tc.status)
			}
		})
	}
}

func TestRolloutPauseChangesAnswerConflict(t *testing.T) {
	s := &Server{}
	conflict := apierrors.NewConflict(schema.GroupResource{Group: "argoproj.io", Resource: "rollouts"}, "web", errors.New("the object has been modified"))
	cases := []struct {
		name, action string
		err          error
		wantMessage  string
	}{
		{name: "pause changed before the write", action: "promote", err: fmt.Errorf("Rollout prod/web: %w", rollouts.ErrPauseChanged), wantMessage: rollouts.ErrPauseChanged.Error()},
		{name: "pause changed during the write", action: "promote", err: fmt.Errorf("failed to patch Rollout status: %w", conflict), wantMessage: rollouts.ErrPauseChanged.Error()},
		{name: "another action keeps its conflict", action: "abort", err: conflict, wantMessage: "the object has been modified"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			s.writeRolloutError(w, tc.err, tc.action, "prod", "web")
			if w.Code != http.StatusConflict {
				t.Fatalf("status = %d, want 409", w.Code)
			}
			if !strings.Contains(w.Body.String(), tc.wantMessage) {
				t.Fatalf("body = %s, want it to contain %q", w.Body.String(), tc.wantMessage)
			}
		})
	}
}
