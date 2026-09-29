package rl

import (
	"testing"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
)

func fuels(d, p, o float64) map[string]float64 {
	return map[string]float64{"DIESEL": d, "PETROL": p, "OCTANE": o}
}

func baseline() sim.World {
	st := func(id, region, profile string, c, inv map[string]float64) sim.Station {
		return sim.Station{ID: id, RegionID: region, Status: "OPEN", DemandProfile: profile, DemandMultiplier: 1, Capacity: c, Inventory: inv}
	}
	rt := func(id, d, s string, t int, m float64) sim.Route {
		return sim.Route{ID: id, SourceDepotID: d, DestinationStationID: s, TransitTicks: t, MaxShipment: m, Status: "AVAILABLE"}
	}
	return sim.World{
		Instance: sim.Instance{Tick: 0, SimTime: "2026-01-01T00:00:00", TickMinutes: 15},
		Regions:  []sim.Region{{ID: "region-dhaka", DemandFactor: 1}, {ID: "region-chattogram", DemandFactor: 1.08}},
		Depots: []sim.Depot{
			{ID: "depot-gazipur", RegionID: "region-dhaka", Status: "OPEN", DispatchCapacityPerTick: 12000, Capacity: fuels(90000, 70000, 45000), Inventory: fuels(60000, 45000, 26000)},
			{ID: "depot-patiya", RegionID: "region-chattogram", Status: "CONSTRAINED", DispatchCapacityPerTick: 11000, Capacity: fuels(85000, 65000, 40000), Inventory: fuels(55000, 42000, 24000)},
		},
		Stations: []sim.Station{
			st("station-mirpur", "region-dhaka", "urban_high", fuels(15000, 14000, 9000), fuels(900, 9000, 5000)),
			st("station-tongi", "region-dhaka", "industrial", fuels(18000, 9000, 6000), fuels(11000, 6000, 3500)),
			st("station-karnaphuli", "region-chattogram", "highway", fuels(14000, 15000, 9000), fuels(8500, 9500, 5200)),
			st("station-coxsbazar", "region-chattogram", "regional", fuels(12000, 12000, 7000), fuels(7500, 7500, 4200)),
		},
		Routes: []sim.Route{rt("route-gazipur-mirpur", "depot-gazipur", "station-mirpur", 2, 7000), rt("route-gazipur-tongi", "depot-gazipur", "station-tongi", 2, 6500),
			rt("route-patiya-karnaphuli", "depot-patiya", "station-karnaphuli", 2, 7000), rt("route-patiya-coxsbazar", "depot-patiya", "station-coxsbazar", 3, 6000),
			rt("route-gazipur-karnaphuli", "depot-gazipur", "station-karnaphuli", 4, 5000), rt("route-patiya-mirpur", "depot-patiya", "station-mirpur", 4, 5000)},
		Events: []sim.Event{{ID: 1, Type: "demand_spike", StartTick: 4, EndTick: 10, Status: "SCHEDULED",
			Parameters: map[string]any{"multiplier": 1.8, "region_ids": []any{"region-dhaka"}}}},
	}
}

func TestSnapshotConversion(t *testing.T) {
	s, _, _, err := Snapshot(baseline(), 3, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !s.DepotOpen[1] {
		t.Error("CONSTRAINED depot must stay open (the simulator still dispatches from it)")
	}
	if got := s.Events[0].Stations; len(got) != 2 || got[0] != 0 || got[1] != 1 {
		t.Errorf("region-dhaka spike must reach Mirpur and Tongi, got %v", got)
	}
	if s.Stock[0][0] != 900 || s.Dispatch[0] != 12000 || s.Epoch != 3 || s.Minute != 0 {
		t.Errorf("bad conversion %+v", s)
	}
	w := baseline()
	w.Stations = w.Stations[:3]
	if _, _, _, err := Snapshot(w, 3, nil, nil); err == nil {
		t.Error("a topology the model was not trained on must be rejected")
	}
}

func TestDecideLiveWorld(t *testing.T) {
	a, err := LoadActor()
	if err != nil {
		t.Fatal(err)
	}
	d, err := a.Decide(baseline(), 1, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !d.Mask[d.Action] || !d.Mask[0] {
		t.Fatalf("chose masked action %d (mask %v)", d.Action, d.Mask)
	}
	for _, s := range d.Shipments {
		if s.Quantity <= 0 || s.RouteID == "" {
			t.Fatalf("bad shipment %+v", s)
		}
	}
	w := baseline()
	w.Stale = true
	if _, err := a.Decide(w, 1, nil, nil); err == nil {
		t.Fatal("stale data must not be trusted")
	}
}
