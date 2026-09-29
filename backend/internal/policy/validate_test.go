package policy

import (
	"strings"
	"testing"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
)

func hasViolation(v []string, substr string) bool {
	for _, s := range v {
		if strings.Contains(s, substr) {
			return true
		}
	}
	return false
}

func TestValidateCatchesSimulatorTraps(t *testing.T) {
	w := baselineWorld()
	ok := Proposal{StationID: "station-mirpur", FuelType: "DIESEL", RouteID: "route-gazipur-mirpur", Quantity: 3000}
	if v := Validate(w, ok); len(v) != 0 {
		t.Fatalf("valid proposal rejected: %v", v)
	}

	// Overflow counting in-transit: the simulator only checks on-hand and destroys the excess on arrival.
	at := 2
	w.Allocations = []sim.Allocation{{ID: 1, RouteID: "route-gazipur-mirpur", DestinationStationID: "station-mirpur",
		SourceDepotID: "depot-gazipur", FuelType: "DIESEL", Quantity: 5000, Status: "IN_TRANSIT", ExpectedArrivalTick: &at}}
	if v := Validate(w, ok); !hasViolation(v, "would overflow") {
		t.Fatalf("9000 on hand + 5000 in transit + 3000 > 15000 not caught: %v", v)
	}

	// Route disrupted at the departure tick: accepted by the simulator, then FAILED with the fuel kept.
	w = baselineWorld()
	w.Events = []sim.Event{{ID: 1, Type: "route_disruption", StartTick: 0, EndTick: 3, Status: "SCHEDULED",
		Parameters: map[string]any{"route_ids": []any{"route-gazipur-mirpur"}}}}
	if v := Validate(w, ok); !hasViolation(v, "disrupted at departure") {
		t.Fatalf("scheduled disruption at departure not caught: %v", v)
	}

	// Per-depot dispatch cap is shared across fuels within a tick.
	w = baselineWorld()
	w.Allocations = []sim.Allocation{{ID: 2, SourceDepotID: "depot-gazipur", FuelType: "PETROL", Quantity: 10000, Status: "PENDING",
		RouteID: "route-gazipur-tongi", DestinationStationID: "station-tongi"}}
	if v := Validate(w, ok); !hasViolation(v, "dispatch capacity") {
		t.Fatalf("12000 cap with 10000 already dispatched not caught: %v", v)
	}

	for name, p := range map[string]Proposal{
		"wrong station": {StationID: "station-tongi", FuelType: "DIESEL", RouteID: "route-gazipur-mirpur", Quantity: 100},
		"over max":      {StationID: "station-mirpur", FuelType: "DIESEL", RouteID: "route-gazipur-mirpur", Quantity: 7001},
		"bad fuel":      {StationID: "station-mirpur", FuelType: "KEROSENE", RouteID: "route-gazipur-mirpur", Quantity: 100},
		"zero":          {StationID: "station-mirpur", FuelType: "DIESEL", RouteID: "route-gazipur-mirpur", Quantity: 0},
	} {
		if v := Validate(baselineWorld(), p); len(v) == 0 {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestImpactOfAShipmentLowersRisk(t *testing.T) {
	w := baselineWorld()
	station(&w, "station-mirpur").Inventory["PETROL"] = 500
	before, after, err := Impact(w, Proposal{StationID: "station-mirpur", FuelType: "PETROL", RouteID: "route-gazipur-mirpur", Quantity: 7000}, DefaultOptions)
	if err != nil {
		t.Fatal(err)
	}
	if !(after.StockoutProb < before.StockoutProb) {
		t.Fatalf("risk %v -> %v, want lower", before.StockoutProb, after.StockoutProb)
	}
}

func TestDetectFlagsUnexplainedSpikeOnly(t *testing.T) {
	w := baselineWorld()
	w.Instance.Tick = 40 // 10:00
	w.Instance.SimTime = "2026-01-01T10:00:00"
	f := NewForecaster(w)
	var obs []sim.DemandObservation
	for tick := 36; tick < 40; tick++ {
		for _, s := range w.Stations {
			for _, fuel := range sim.FuelTypes {
				d := f.Baseline(s, fuel, tick)
				if s.ID == "station-mirpur" && fuel == "PETROL" {
					d *= 1.8
				}
				obs = append(obs, sim.DemandObservation{StationID: s.ID, FuelType: fuel, Tick: tick, DemandLiters: d})
			}
		}
	}
	got := Detect(w, obs)
	if len(got) != 1 || got[0].StationID != "station-mirpur" || got[0].FuelType != "PETROL" || got[0].Direction != "spike" {
		t.Fatalf("want exactly Mirpur PETROL spike, got %+v", got)
	}
	if got[0].ExplainedBy != "" {
		t.Fatalf("multiplier is 1, so the spike is unexplained; got %q", got[0].ExplainedBy)
	}
	station(&w, "station-mirpur").DemandMultiplier = 1.8
	if got := Detect(w, obs); len(got) != 1 || got[0].ExplainedBy == "" {
		t.Fatalf("visible demand_multiplier should explain it: %+v", got)
	}
}

func TestActiveSpikeExpiresInForecast(t *testing.T) {
	w := baselineWorld()
	station(&w, "station-mirpur").DemandMultiplier = 2
	w.Events = []sim.Event{{ID: 1, Type: "demand_spike", StartTick: 0, EndTick: 3, Status: "ACTIVE",
		Parameters: map[string]any{"multiplier": 2.0, "station_ids": []any{"station-mirpur"}}}}
	f := NewForecaster(w)
	s := *station(&w, "station-mirpur")
	if during, after := f.Expected(s, "DIESEL", 3), f.Expected(s, "DIESEL", 4); during != 2*f.Baseline(s, "DIESEL", 3) || after != f.Baseline(s, "DIESEL", 4) {
		t.Fatalf("spike must cover its end tick and then expire: during=%v after=%v", during, after)
	}
}

func TestRegionalSpikeForcesReview(t *testing.T) {
	w := baselineWorld()
	w.Events = []sim.Event{{ID: 7, Type: "demand_spike", StartTick: 0, EndTick: 9, Status: "ACTIVE",
		Parameters: map[string]any{"multiplier": 1.8, "region_ids": []any{"region-dhaka"}}}}
	why := ReviewReasons(w, Recommendation{StationID: "station-mirpur", RouteID: "route-gazipur-mirpur", DepotID: "depot-gazipur", Quantity: 1000}, DefaultOptions)
	if len(why) == 0 {
		t.Fatal("a regional crisis touching the station must force review")
	}
}
