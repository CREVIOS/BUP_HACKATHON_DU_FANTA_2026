package intel

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
)

func fuels(d, p, o float64) map[string]float64 {
	return map[string]float64{"DIESEL": d, "PETROL": p, "OCTANE": o}
}

// lowMirpur is a two-station world where Mirpur PETROL is nearly empty: the planner proposes one shipment.
func lowMirpur() sim.World {
	return sim.World{
		Instance: sim.Instance{ScenarioID: "baseline", Seed: 1, SimTime: "2026-01-01T00:00:00", TickMinutes: 15},
		Regions:  []sim.Region{{ID: "region-dhaka", DemandFactor: 1}},
		Depots: []sim.Depot{{ID: "depot-gazipur", RegionID: "region-dhaka", Status: "OPEN", DispatchCapacityPerTick: 12000,
			Capacity: fuels(90000, 70000, 45000), Inventory: fuels(60000, 45000, 26000)}},
		Stations: []sim.Station{{ID: "station-mirpur", RegionID: "region-dhaka", Status: "OPEN", DemandProfile: "urban_high", DemandMultiplier: 1,
			Capacity: fuels(15000, 14000, 9000), Inventory: fuels(15000, 800, 9000)}},
		Routes: []sim.Route{{ID: "route-gazipur-mirpur", SourceDepotID: "depot-gazipur", DestinationStationID: "station-mirpur",
			TransitTicks: 2, MaxShipment: 4000, Status: "AVAILABLE"}},
	}
}

// fakeJev answers every Noul with p.
func fakeJev(t *testing.T, p float64, status int) (*Jev, *int) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer k" {
			t.Errorf("missing bearer key")
		}
		var req struct {
			Model     string                    `json:"model"`
			Questions map[string]map[string]any `json:"questions"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		if status != http.StatusOK {
			w.WriteHeader(status)
			return
		}
		answers := map[string]any{}
		for id, q := range req.Questions {
			if q["type"] != "noul" {
				t.Errorf("question %s type %v", id, q["type"])
			}
			answers[id] = map[string]any{"type": "noul", "noul": p}
		}
		json.NewEncoder(w).Encode(map[string]any{"model": "jev-1.13.0", "answers": answers})
	}))
	t.Cleanup(srv.Close)
	j := NewJev("k")
	j.url = srv.URL
	return j, &calls
}

func TestJevDecidesAutoWhenNoHardVeto(t *testing.T) {
	j, calls := fakeJev(t, 0.93, http.StatusOK)
	resp := Evaluate(context.Background(), PlanRequest{World: lowMirpur()}, j, "intel")
	if len(resp.Recommendations) != 1 {
		t.Fatalf("want 1 recommendation, got %d", len(resp.Recommendations))
	}
	r := resp.Recommendations[0]
	if *calls != 1 || r.JevPAuto == nil || *r.JevPAuto != 0.93 || r.Verdict != "auto" || resp.Jev.Model != "jev-1.13.0" {
		t.Fatalf("calls=%d rec=%+v jev=%+v", *calls, r, resp.Jev)
	}
	if r.Features["margin"] == "" || r.Features["route"] == "" {
		t.Fatalf("features not computed: %v", r.Features)
	}
}

func TestHardVetoIsNeverSentToJev(t *testing.T) {
	j, calls := fakeJev(t, 0.99, http.StatusOK)
	w := lowMirpur()
	w.Stale = true // hard veto
	r := Evaluate(context.Background(), PlanRequest{World: w}, j, "intel").Recommendations[0]
	if *calls != 0 || r.JevPAuto != nil || r.Verdict != "review" {
		t.Fatalf("stale data must force review without asking Jev: calls=%d %+v", *calls, r)
	}
}

func TestJevFailureFallsBackToFixedRule(t *testing.T) {
	j, _ := fakeJev(t, 0, http.StatusInternalServerError)
	resp := Evaluate(context.Background(), PlanRequest{World: lowMirpur()}, j, "intel")
	r := resp.Recommendations[0]
	if resp.Jev.Error == "" || r.JevPAuto != nil || r.Verdict != r.RuleVerdict {
		t.Fatalf("want rule verdict on Jev failure: jev=%+v rec=%+v", resp.Jev, r)
	}
}

func TestLowJevProbabilityRequiresReview(t *testing.T) {
	j, _ := fakeJev(t, 0.4, http.StatusOK)
	r := Evaluate(context.Background(), PlanRequest{World: lowMirpur(), JevThreshold: 0.8}, j, "intel").Recommendations[0]
	if r.Verdict != "review" {
		t.Fatalf("p_auto 0.4 < 0.8 must go to review, got %s", r.Verdict)
	}
}
