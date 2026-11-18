package health

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestFlaggerContract(t *testing.T) {
	raw, err := os.ReadFile("testdata/flagger.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name   string
		Object unstructured.Unstructured
		Level  Level
		Text   string
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			v := FlaggerCanary(&tc.Object)
			if v.Level != tc.Level || v.Reason != tc.Text {
				t.Fatalf("got %+v, want %s/%s", v, tc.Level, tc.Text)
			}
		})
	}
}

func TestFlaggerCanaryActivity(t *testing.T) {
	canary := func(phase string, suspend bool) *unstructured.Unstructured {
		return &unstructured.Unstructured{Object: map[string]any{"spec": map[string]any{"suspend": suspend}, "status": map[string]any{"phase": phase}}}
	}
	for phase, want := range map[string][2]bool{
		"Progressing": {true, false}, "Promoting": {true, false}, "Finalising": {true, false}, "Initializing": {true, false},
		"Waiting": {false, true}, "WaitingPromotion": {false, true},
		"Succeeded": {false, false}, "Failed": {false, false}, "Initialized": {false, false},
	} {
		if _, moving, awaiting, _ := FlaggerCanaryActivity(canary(phase, false)); moving != want[0] || awaiting != want[1] {
			t.Errorf("%s: moving=%v awaiting=%v, want %v", phase, moving, awaiting, want)
		}
	}
	if _, moving, awaiting, _ := FlaggerCanaryActivity(canary("WaitingPromotion", true)); moving || awaiting {
		t.Error("a suspended Canary is neither moving nor waiting on anyone")
	}
	deleting := canary("Progressing", false)
	deleting.SetDeletionTimestamp(&metav1.Time{Time: time.Now()})
	if _, moving, awaiting, _ := FlaggerCanaryActivity(deleting); moving || awaiting {
		t.Error("a Canary being deleted reads as moving")
	}
	reported := canary("Progressing", false)
	reported.Object["status"].(map[string]any)["lastTransitionTime"] = "2026-11-18T10:00:00Z"
	if _, _, _, since := FlaggerCanaryActivity(reported); !since.Equal(time.Date(2026, 11, 18, 10, 0, 0, 0, time.UTC)) {
		t.Errorf("since = %v, want the Canary's last transition", since)
	}
}
