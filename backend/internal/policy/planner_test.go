package policy

import (
	"testing"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
)

func fuels(d, p, o float64) map[string]float64 {
	return map[string]float64{"DIESEL": d, "PETROL": p, "OCTANE": o}
}

// baselineWorld is the published baseline scenario at tick 0 (simulator guide §8).
func baselineWorld() sim.World {
	return sim.World{
		Instance: sim.Instance{ScenarioID: "baseline", Seed: 12345, SimTime: "2026-01-01T00:00:00", TickMinutes: 15, Status: "PAUSED"},
		Regions:  []sim.Region{{ID: "region-dhaka", DemandFactor: 1.0}, {ID: "region-chattogram", DemandFactor: 1.08}},
		Depots: []sim.Depot{
			{ID: "depot-gazipur", RegionID: "region-dhaka", Status: "OPEN", DispatchCapacityPerTick: 12000, Capacity: fuels(90000, 70000, 45000), Inventory: fuels(60000, 45000, 26000)},
			{ID: "depot-patiya", RegionID: "region-chattogram", Status: "OPEN", DispatchCapacityPerTick: 11000, Capacity: fuels(85000, 65000, 40000), Inventory: fuels(55000, 42000, 24000)},
		},
		Stations: []sim.Station{
			{ID: "station-mirpur", RegionID: "region-dhaka", Status: "OPEN", DemandProfile: "urban_high", DemandMultiplier: 1, Capacity: fuels(15000, 14000, 9000), Inventory: fuels(9000, 9000, 5000)},
			{ID: "station-tongi", RegionID: "region-dhaka", Status: "OPEN", DemandProfile: "industrial", DemandMultiplier: 1, Capacity: fuels(18000, 9000, 6000), Inventory: fuels(11000, 6000, 3500)},
			{ID: "station-karnaphuli", RegionID: "region-chattogram", Status: "OPEN", DemandProfile: "highway", DemandMultiplier: 1, Capacity: fuels(14000, 15000, 9000), Inventory: fuels(8500, 9500, 5200)},
			{ID: "station-coxsbazar", RegionID: "region-chattogram", Status: "OPEN", DemandProfile: "regional", DemandMultiplier: 1, Capacity: fuels(12000, 12000, 7000), Inventory: fuels(7500, 7500, 4200)},
		},
		Routes: []sim.Route{
			{ID: "route-gazipur-mirpur", SourceDepotID: "depot-gazipur", DestinationStationID: "station-mirpur", TransitTicks: 2, MaxShipment: 7000, Status: "AVAILABLE"},
			{ID: "route-gazipur-tongi", SourceDepotID: "depot-gazipur", DestinationStationID: "station-tongi", TransitTicks: 2, MaxShipment: 6500, Status: "AVAILABLE"},
			{ID: "route-patiya-karnaphuli", SourceDepotID: "depot-patiya", DestinationStationID: "station-karnaphuli", TransitTicks: 2, MaxShipment: 7000, Status: "AVAILABLE"},
			{ID: "route-patiya-coxsbazar", SourceDepotID: "depot-patiya", DestinationStationID: "station-coxsbazar", TransitTicks: 3, MaxShipment: 6000, Status: "AVAILABLE"},
			{ID: "route-gazipur-karnaphuli", SourceDepotID: "depot-gazipur", DestinationStationID: "station-karnaphuli", TransitTicks: 4, MaxShipment: 5000, Status: "AVAILABLE"},
			{ID: "route-patiya-mirpur", SourceDepotID: "depot-patiya", DestinationStationID: "station-mirpur", TransitTicks: 4, MaxShipment: 5000, Status: "AVAILABLE"},
		},
	}
}

func station(w *sim.World, id string) *sim.Station {
	for i := range w.Stations {
		if w.Stations[i].ID == id {
			return &w.Stations[i]
		}
	}
	panic(id)
}

func find(p Plan, st, fuel string) *Recommendation {
	for i := range p.Recommendations {
		if p.Recommendations[i].StationID == st && p.Recommendations[i].FuelType == fuel {
			return &p.Recommendations[i]
		}
	}
	return nil
}

func TestLowStationGetsDirectRouteWithinRoom(t *testing.T) {
	w := baselineWorld()
	station(&w, "station-mirpur").Inventory["PETROL"] = 1000
	r := find(MakePlan(w, DefaultOptions), "station-mirpur", "PETROL")
	if r == nil {
		t.Fatal("no recommendation for depleted Mirpur PETROL")
	}
	if r.RouteID != "route-gazipur-mirpur" || r.Quantity > 7000 || r.Quantity > 14000-1000 {
		t.Fatalf("got %+v", r)
	}
	if r.RiskAfter > r.RiskBefore {
		t.Fatalf("risk went up: %v -> %v", r.RiskBefore, r.RiskAfter)
	}
}

func TestInTransitCountsTowardRoom(t *testing.T) {
	w := baselineWorld()
	station(&w, "station-mirpur").Inventory["PETROL"] = 1000
	at := 2
	w.Allocations = []sim.Allocation{{ID: 1, RouteID: "route-gazipur-mirpur", DestinationStationID: "station-mirpur",
		SourceDepotID: "depot-gazipur", FuelType: "PETROL", Quantity: 12500, Status: "IN_TRANSIT", ExpectedArrivalTick: &at}}
	if r := find(MakePlan(w, DefaultOptions), "station-mirpur", "PETROL"); r != nil {
		t.Fatalf("would overflow: 1000 on hand + 12500 in transit, cap 14000, still proposed %v", r.Quantity)
	}
}

func TestDisruptionAtDepartureUsesAlternateAndCancelsDoomedPending(t *testing.T) {
	w := baselineWorld()
	station(&w, "station-mirpur").Inventory["DIESEL"] = 500
	w.Events = []sim.Event{{ID: 9, Type: "route_disruption", StartTick: 0, EndTick: 10, Status: "SCHEDULED",
		Parameters: map[string]any{"route_ids": []any{"route-gazipur-mirpur"}}}}
	w.Allocations = []sim.Allocation{{ID: 3, RouteID: "route-gazipur-mirpur", DestinationStationID: "station-mirpur",
		SourceDepotID: "depot-gazipur", FuelType: "OCTANE", Quantity: 1000, Status: "PENDING"}}
	p := MakePlan(w, DefaultOptions)
	r := find(p, "station-mirpur", "DIESEL")
	if r == nil || r.RouteID != "route-patiya-mirpur" || !r.ReviewRequired {
		t.Fatalf("want patiya-mirpur with review, got %+v", r)
	}
	if len(p.Cancel) != 1 || p.Cancel[0].ID != 3 {
		t.Fatalf("doomed pending not flagged: %+v", p.Cancel)
	}
}

func TestEmptyRouteIDsDisruptsNothing(t *testing.T) {
	w := baselineWorld()
	w.Events = []sim.Event{{Type: "route_disruption", StartTick: 0, EndTick: 5, Status: "SCHEDULED", Parameters: map[string]any{}}}
	if RouteDisruptedAt(w, "route-gazipur-mirpur", 0) {
		t.Fatal("empty route_ids must not disrupt (matches engine)")
	}
}

func TestDispatchCapAcrossFuels(t *testing.T) {
	w := baselineWorld()
	for _, f := range sim.FuelTypes {
		station(&w, "station-mirpur").Inventory[f] = 0
		station(&w, "station-tongi").Inventory[f] = 0
	}
	sent := map[string]float64{}
	for _, r := range MakePlan(w, DefaultOptions).Recommendations {
		sent[r.DepotID] += r.Quantity
	}
	if sent["depot-gazipur"] > 12000 {
		t.Fatalf("gazipur dispatch %v > 12000/tick", sent["depot-gazipur"])
	}
}

func TestCaptiveReserveProtectsTongi(t *testing.T) {
	w := baselineWorld()
	w.Depots[0].Inventory["DIESEL"] = 3000               // Gazipur nearly out of diesel
	station(&w, "station-tongi").Inventory["DIESEL"] = 0 // Tongi (Gazipur-only) empty
	station(&w, "station-karnaphuli").Inventory["DIESEL"] = 0
	w.Depots[1].Inventory["DIESEL"] = 0 // Patiya empty: Karnaphuli could only draw from Gazipur
	p := MakePlan(w, DefaultOptions)
	if r := find(p, "station-karnaphuli", "DIESEL"); r != nil && r.DepotID == "depot-gazipur" {
		t.Fatalf("Karnaphuli took Gazipur diesel reserved for captive Tongi: %+v", r)
	}
	if r := find(p, "station-tongi", "DIESEL"); r == nil || r.Quantity < 500 {
		t.Fatalf("Tongi not served: %+v", r)
	}
}

func TestForecastMatchesPublishedModel(t *testing.T) {
	w := baselineWorld()
	f := NewForecaster(w)
	// Tongi (industrial) at 00:00 is off-peak: 14000/96 * 0.45 * 1.0
	if got, want := f.Expected(w.Stations[1], "DIESEL", 0), 14000.0/96*0.45; got < want-1e-9 || got > want+1e-9 {
		t.Fatalf("got %v want %v", got, want)
	}
	// tick 28 = 07:00 -> busy
	if got, want := f.Expected(w.Stations[1], "DIESEL", 28), 14000.0/96*1.55; got < want-1e-9 || got > want+1e-9 {
		t.Fatalf("got %v want %v", got, want)
	}
}
