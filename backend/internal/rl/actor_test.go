package rl

import (
	"encoding/json"
	"os"
	"testing"
)

type parityRow struct {
	Scenario string    `json:"scenario"`
	Obs      []float64 `json:"obs"`
	Mask     []bool    `json:"mask"`
	Action   int       `json:"action"`
	Gap      float64   `json:"gap"`
}

// checkParity asserts the Go actor picks exactly the action SB3's choose() picked.
func checkParity(t *testing.T, path string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("no parity file: %v", err)
	}
	var rows []parityRow
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	a, err := LoadActor()
	if err != nil {
		t.Fatal(err)
	}
	for i, r := range rows {
		var mask [actions]bool
		copy(mask[:], r.Mask)
		got, logits, err := a.Choose(r.Obs, mask)
		if err != nil {
			t.Fatal(err)
		}
		if got != r.Action {
			t.Errorf("row %d (%s, gap %.2g): Go chose %d, SB3 chose %d; logits %v", i, r.Scenario, r.Gap, got, r.Action, logits)
		}
	}
	t.Logf("%d/%d decisions identical to SB3", len(rows), len(rows))
}

// TestActorMatchesSB3 covers the 24 closest decisions plus 24 spread over the four exact scenarios.
func TestActorMatchesSB3(t *testing.T) { checkParity(t, "testdata/parity.json") }

// TestActorMatchesSB3Full checks every decision of 4 full episodes (2,304) when RL_PARITY_FULL points at the
// exporter's parity-full.json (kept with the downloaded package; too large to commit).
func TestActorMatchesSB3Full(t *testing.T) {
	p := os.Getenv("RL_PARITY_FULL")
	if p == "" {
		t.Skip("set RL_PARITY_FULL to the exporter's parity-full.json")
	}
	checkParity(t, p)
}

func TestActorProvenance(t *testing.T) {
	a, err := LoadActor()
	if err != nil {
		t.Fatal(err)
	}
	if a.Meta.Seed != 11 || a.Meta.Promotion || a.Meta.Revision == "" {
		t.Fatalf("unexpected provenance %+v", a.Meta)
	}
}
