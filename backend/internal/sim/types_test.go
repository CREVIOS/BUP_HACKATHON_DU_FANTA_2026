package sim

import (
	"encoding/json"
	"strings"
	"testing"
)

// The JSON below is copied verbatim from the Integration Guide (§4, §5.3) so
// these tests fail loudly if a struct tag drifts from the simulator's shape.

func TestDecodeGuideExamples(t *testing.T) {
	cases := []struct {
		name string
		json string
		into func() validatable
	}{
		{"instance", `{
			"id":1,"scenario_id":"baseline","scenario_version":"1.0","seed":12345,
			"sim_time":"2026-01-01T00:00:00+00:00","tick":0,"tick_minutes":15,"status":"PAUSED"
		}`, func() validatable { return new(Instance) }},

		{"region", `{"id":"region-dhaka","name":"Dhaka Division","demand_factor":1.00}`,
			func() validatable { return new(Region) }},

		{"depot", `{
			"id":"depot-gazipur","name":"Gazipur Depot","region_id":"region-dhaka","status":"OPEN",
			"dispatch_capacity_per_tick":12000,
			"capacity":{"DIESEL":90000,"PETROL":70000,"OCTANE":45000},
			"inventory":{"DIESEL":60000,"PETROL":45000,"OCTANE":26000}
		}`, func() validatable { return new(Depot) }},

		{"station", `{
			"id":"station-mirpur","name":"Mirpur Fuel Station","region_id":"region-dhaka","status":"OPEN",
			"demand_profile":"urban_high","demand_multiplier":1.0,
			"capacity":{"DIESEL":15000,"PETROL":14000,"OCTANE":9000},
			"inventory":{"DIESEL":9000,"PETROL":9000,"OCTANE":5000}
		}`, func() validatable { return new(Station) }},

		{"route", `{
			"id":"route-gazipur-mirpur","source_depot_id":"depot-gazipur",
			"destination_station_id":"station-mirpur","transit_ticks":2,"max_shipment":7000,"status":"AVAILABLE"
		}`, func() validatable { return new(Route) }},

		{"supply-arrival", `{
			"id":"supply-001","depot_id":"depot-gazipur","fuel_type":"DIESEL","quantity":18000,
			"planned_tick":12,"actual_tick":null,"status":"SCHEDULED"
		}`, func() validatable { return new(SupplyArrival) }},

		{"event", `{
			"id":1,"type":"demand_spike","start_tick":8,"end_tick":20,"status":"RESOLVED",
			"parameters":{"region_ids":["region-dhaka"],"multiplier":1.8}
		}`, func() validatable { return new(Event) }},

		{"allocation", `{
			"id":1,"idempotency_key":"demo-001","source_depot_id":"depot-gazipur",
			"destination_station_id":"station-mirpur","route_id":"route-gazipur-mirpur","fuel_type":"DIESEL",
			"quantity":3000,"created_tick":5,"departure_tick":6,"expected_arrival_tick":8,
			"actual_arrival_tick":8,"status":"ARRIVED","failure_reason":null
		}`, func() validatable { return new(Allocation) }},

		{"demand-observation", `{
			"id":100,"station_id":"station-mirpur","fuel_type":"DIESEL","tick":12,
			"sim_time":"2026-01-01T03:00:00+00:00","demand_liters":95.123,"served_liters":95.123,"unmet_liters":0.0
		}`, func() validatable { return new(DemandObservation) }},

		{"metrics", `{
			"served_demand_liters":12345.678,"unmet_demand_liters":234.567,
			"service_level":0.981408,"allocation_liters":9800.000,"allocation_failures":2
		}`, func() validatable { return new(Metrics) }},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v := c.into()
			dec := json.NewDecoder(strings.NewReader(c.json))
			dec.DisallowUnknownFields() // catches a field the simulator sends that we forgot to model
			if err := dec.Decode(v); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if err := v.Validate(); err != nil {
				t.Fatalf("validate: %v", err)
			}
		})
	}
}

// TestAllocationRequestMatchesGuide decodes the POST /v1/allocations request body
// verbatim from guide §5.1 with DisallowUnknownFields, then re-marshals it and
// asserts the wire shape is exactly the six documented keys — proving the input
// struct matches the simulator's input format, not just that it validates.
func TestAllocationRequestMatchesGuide(t *testing.T) {
	const body = `{
		"idempotency_key": "demo-001",
		"source_depot_id": "depot-gazipur",
		"destination_station_id": "station-mirpur",
		"route_id": "route-gazipur-mirpur",
		"fuel_type": "DIESEL",
		"quantity": 3000
	}`
	var req AllocationRequest
	dec := json.NewDecoder(strings.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		t.Fatalf("decode §5.1 body: %v", err)
	}
	if err := req.Validate(); err != nil {
		t.Fatalf("guide example failed validation: %v", err)
	}
	if req.FuelType != Diesel || req.Quantity != 3000 || req.IdempotencyKey != "demo-001" {
		t.Fatalf("decoded into wrong fields: %+v", req)
	}

	// Re-marshal and confirm the emitted keys are precisely §5.1's set.
	out, _ := json.Marshal(req)
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	want := []string{"idempotency_key", "source_depot_id", "destination_station_id", "route_id", "fuel_type", "quantity"}
	if len(got) != len(want) {
		t.Fatalf("emitted %d keys, want %d: %v", len(got), len(want), got)
	}
	for _, k := range want {
		if _, ok := got[k]; !ok {
			t.Errorf("missing key %q in emitted request body", k)
		}
	}
}

func TestAllocationRequestValidate(t *testing.T) {
	ok := AllocationRequest{
		IdempotencyKey: "demo-001", SourceDepotID: "depot-gazipur",
		DestinationStationID: "station-mirpur", RouteID: "route-gazipur-mirpur",
		FuelType: Diesel, Quantity: 3000,
	}
	if err := ok.Validate(); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}

	bad := map[string]AllocationRequest{
		"empty key":     mutate(ok, func(r *AllocationRequest) { r.IdempotencyKey = "" }),
		"long key":      mutate(ok, func(r *AllocationRequest) { r.IdempotencyKey = string(make([]byte, 151)) }),
		"no depot":      mutate(ok, func(r *AllocationRequest) { r.SourceDepotID = "" }),
		"no station":    mutate(ok, func(r *AllocationRequest) { r.DestinationStationID = "" }),
		"no route":      mutate(ok, func(r *AllocationRequest) { r.RouteID = "" }),
		"bad fuel":      mutate(ok, func(r *AllocationRequest) { r.FuelType = "KEROSENE" }),
		"zero quantity": mutate(ok, func(r *AllocationRequest) { r.Quantity = 0 }),
		"neg quantity":  mutate(ok, func(r *AllocationRequest) { r.Quantity = -1 }),
	}
	for name, r := range bad {
		if err := r.Validate(); err == nil {
			t.Errorf("%s: expected validation error, got nil", name)
		}
	}
}

func TestSnapshotValidateRejectsBadNested(t *testing.T) {
	s := Snapshot{
		Instance: Instance{ScenarioID: "baseline", Tick: 0, Status: Paused, SimTime: "2026-01-01T00:00:00"},
		Metrics:  Metrics{ServiceLevel: 1.0},
		Depots:   []Depot{{ID: "depot-x", RegionID: "r", Status: DepotOpen}},
		Routes:   []Route{{ID: "route-x", SourceDepotID: "d", DestinationStationID: "s", MaxShipment: -5, Status: RouteAvailable}},
	}
	if err := s.Validate(); err == nil {
		t.Fatal("expected snapshot with negative max_shipment to fail")
	}
}

func TestEnumValidity(t *testing.T) {
	if Diesel.Valid() != true || FuelType("KEROSENE").Valid() != false {
		t.Fatal("FuelType.Valid wrong")
	}
	if (FuelMap{Diesel: 1, "BOGUS": 2}).valid() == nil {
		t.Fatal("FuelMap.valid should reject an unknown fuel key")
	}
	if SimStatus("STOPPED").Valid() || !Running.Valid() {
		t.Fatal("SimStatus.Valid wrong")
	}
}

func mutate(r AllocationRequest, f func(*AllocationRequest)) AllocationRequest {
	f(&r)
	return r
}
