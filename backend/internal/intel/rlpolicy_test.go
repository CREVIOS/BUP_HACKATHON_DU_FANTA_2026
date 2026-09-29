package intel

import (
	"context"
	"testing"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
)

// fullWorld is the published 4-station network with Mirpur nearly out of diesel and petrol.
func fullWorld() sim.World {
	st := func(id, region, profile string, c, inv map[string]float64) sim.Station {
		return sim.Station{ID: id, RegionID: region, Status: "OPEN", DemandProfile: profile, DemandMultiplier: 1, Capacity: c, Inventory: inv}
	}
	rt := func(id, d, s string, t int, m float64) sim.Route {
		return sim.Route{ID: id, SourceDepotID: d, DestinationStationID: s, TransitTicks: t, MaxShipment: m, Status: "AVAILABLE"}
	}
	return sim.World{
		Instance: sim.Instance{Tick: 28, SimTime: "2026-01-01T07:00:00", TickMinutes: 15, Seed: 12345},
		Regions:  []sim.Region{{ID: "region-dhaka", DemandFactor: 1}, {ID: "region-chattogram", DemandFactor: 1.08}},
		Depots: []sim.Depot{
			{ID: "depot-gazipur", RegionID: "region-dhaka", Status: "OPEN", DispatchCapacityPerTick: 12000, Capacity: fuels(90000, 70000, 45000), Inventory: fuels(60000, 45000, 26000)},
			{ID: "depot-patiya", RegionID: "region-chattogram", Status: "OPEN", DispatchCapacityPerTick: 11000, Capacity: fuels(85000, 65000, 40000), Inventory: fuels(55000, 42000, 24000)},
		},
		Stations: []sim.Station{
			st("station-mirpur", "region-dhaka", "urban_high", fuels(15000, 14000, 9000), fuels(300, 400, 5000)),
			st("station-tongi", "region-dhaka", "industrial", fuels(18000, 9000, 6000), fuels(11000, 6000, 3500)),
			st("station-karnaphuli", "region-chattogram", "highway", fuels(14000, 15000, 9000), fuels(8500, 9500, 5200)),
			st("station-coxsbazar", "region-chattogram", "regional", fuels(12000, 12000, 7000), fuels(7500, 7500, 4200)),
		},
		Routes: []sim.Route{rt("route-gazipur-mirpur", "depot-gazipur", "station-mirpur", 2, 7000), rt("route-gazipur-tongi", "depot-gazipur", "station-tongi", 2, 6500),
			rt("route-patiya-karnaphuli", "depot-patiya", "station-karnaphuli", 2, 7000), rt("route-patiya-coxsbazar", "depot-patiya", "station-coxsbazar", 3, 6000),
			rt("route-gazipur-karnaphuli", "depot-gazipur", "station-karnaphuli", 4, 5000), rt("route-patiya-mirpur", "depot-patiya", "station-mirpur", 4, 5000)},
	}
}

func TestRLPolicyProposesExplainedRecommendations(t *testing.T) {
	resp := Evaluate(context.Background(), PlanRequest{World: fullWorld(), Epoch: 1, Policy: "rl"}, nil, "intel")
	if resp.Policy != "rl" || resp.PolicyVersion != RLVersion || resp.PolicyFallback != "" {
		t.Fatalf("rl should decide: policy=%s version=%s fallback=%q", resp.Policy, resp.PolicyVersion, resp.PolicyFallback)
	}
	if resp.RL == nil || resp.RL.Confidence <= 0 || resp.RL.Confidence > 1 || len(resp.RL.Options) == 0 || resp.RL.Strategy == "" {
		t.Fatalf("missing model explanation: %+v", resp.RL)
	}
	sum := 0.0
	for _, o := range resp.RL.Options {
		sum += o.Probability
	}
	if sum < 0.999 || sum > 1.001 {
		t.Fatalf("option probabilities sum to %v", sum)
	}
	if len(resp.Greedy) == 0 {
		t.Fatal("greedy must still be computed for comparison")
	}
	if resp.RL.Action == 0 {
		t.Skipf("policy chose WAIT here (valid); explanation checks above passed")
	}
	if len(resp.Recommendations) != resp.RL.PlanShipments {
		t.Fatalf("%d cards for a %d-shipment plan", len(resp.Recommendations), resp.RL.PlanShipments)
	}
	for _, r := range resp.Recommendations {
		if r.RL == nil || r.Signals["model_confidence"] == nil || r.Binding == "" || r.Quantity <= 0 {
			t.Fatalf("card lacks §9 evidence: %+v", r)
		}
		if r.RL.Confidence < LowConfidence && !r.ReviewRequired {
			t.Fatalf("low-confidence RL shipment must require review: %+v", r.ReviewReasons)
		}
	}
}

func TestRLFallsBackToGreedyWhenItCannotDecide(t *testing.T) {
	w := fullWorld()
	w.Stale = true // the RL planner refuses untrusted snapshots
	resp := Evaluate(context.Background(), PlanRequest{World: w, Epoch: 1, Policy: "rl"}, nil, "intel")
	if resp.Policy != "greedy" || resp.PolicyFallback == "" || resp.RL != nil {
		t.Fatalf("want greedy fallback with a reason, got policy=%s fallback=%q", resp.Policy, resp.PolicyFallback)
	}
	for _, r := range resp.Recommendations {
		if r.Verdict != "review" {
			t.Fatalf("stale data must force review: %+v", r)
		}
	}
	if Evaluate(context.Background(), PlanRequest{World: lowMirpur(), Epoch: 1}, nil, "intel").PolicyFallback == "" {
		t.Fatal("a topology the model was not trained on must fall back")
	}
}

func TestGreedyPolicyStillSelectable(t *testing.T) {
	resp := Evaluate(context.Background(), PlanRequest{World: fullWorld(), Epoch: 1, Policy: "greedy"}, nil, "intel")
	if resp.Policy != "greedy" || resp.RL != nil || resp.PolicyFallback != "" {
		t.Fatalf("greedy requested: policy=%s", resp.Policy)
	}
}
