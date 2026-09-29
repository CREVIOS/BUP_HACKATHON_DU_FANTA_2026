package ingestor

import (
	"errors"
	"testing"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/intel"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/policy"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
)

func TestAlertsCoverEveryCondition(t *testing.T) {
	w := sim.World{
		Instance: sim.Instance{Tick: 10, TickMinutes: 15},
		Stale:    true,
		Stations: []sim.Station{{ID: "st-a", Status: "OPEN"}, {ID: "st-b", Status: "OUTAGE"}},
		Depots: []sim.Depot{{ID: "dp", Capacity: map[string]float64{"DIESEL": 1000, "PETROL": 1000, "OCTANE": 1000},
			Inventory: map[string]float64{"DIESEL": 50, "PETROL": 900, "OCTANE": 900}}},
		Events: []sim.Event{
			{ID: 1, Type: "route_disruption", Status: "ACTIVE", StartTick: 8, EndTick: 12},
			{ID: 2, Type: "demand_spike", Status: "SCHEDULED", StartTick: 15, EndTick: 20},
			{ID: 3, Type: "demand_spike", Status: "SCHEDULED", StartTick: 90, EndTick: 95}, // too far ahead
		},
		Supply:      []sim.SupplyArrival{{ID: "s1", PlannedTick: 20, Quantity: 500, Status: "DELAYED"}},
		Allocations: []sim.Allocation{{ID: 7, Status: "FAILED"}},
	}
	first := map[string]sim.SupplyArrival{"s1": {ID: "s1", PlannedTick: 12, Quantity: 1000}}
	resp := intel.PlanResponse{
		Risks: []policy.Projection{
			{StationID: "st-a", FuelType: "DIESEL", TimeToStockout: 4, StockoutProb: 1},    // critical: 1 h
			{StationID: "st-a", FuelType: "PETROL", TimeToStockout: -1, StockoutProb: 0.1}, // fine
			{StationID: "st-b", FuelType: "DIESEL", TimeToStockout: 1, StockoutProb: 1},    // closed: outage alert instead
		},
		Anomalies: []policy.Anomaly{{StationID: "st-a", FuelType: "OCTANE", Direction: "spike", Ratio: 1.8}},
		Jev:       intel.JevStatus{Error: "timeout"},
	}
	got := map[string]string{}
	for _, a := range Alerts(w, resp, first, errors.New("intel down")) {
		got[a.Kind+"|"+a.Subject] = a.Severity
	}
	want := map[string]string{
		"station_outage|st-b":            "CRITICAL",
		"stockout_risk|st-a:DIESEL":      "CRITICAL",
		"demand_anomaly|st-a:OCTANE":     "WARN",
		"disruption|event-1":             "CRITICAL",
		"disruption_upcoming|event-2":    "INFO",
		"supply_delay|s1":                "WARN",
		"supply_shortfall|s1":            "WARN",
		"depot_low|dp:DIESEL":            "WARN",
		"allocation_failed|allocation-7": "CRITICAL",
		"stale_data|simulator":           "WARN",
		"decision_engine_fallback|intel": "WARN",
		"jev_unavailable|jev":            "INFO",
	}
	for k, sev := range want {
		if got[k] != sev {
			t.Errorf("%s: got %q want %q", k, got[k], sev)
		}
	}
	if len(got) != len(want) {
		t.Errorf("unexpected extra alerts: %v", got)
	}
}
