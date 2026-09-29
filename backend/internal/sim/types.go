package sim

import (
	"strings"
	"time"
)

// Fuel types, in the simulator's canonical order.
var FuelTypes = []string{"DIESEL", "PETROL", "OCTANE"}

// Instance mirrors GET /v1/instance.
type Instance struct {
	ID              int    `json:"id"`
	ScenarioID      string `json:"scenario_id"`
	ScenarioVersion string `json:"scenario_version"`
	Seed            int64  `json:"seed"`
	SimTime         string `json:"sim_time"`
	Tick            int    `json:"tick"`
	TickMinutes     int    `json:"tick_minutes"`
	Status          string `json:"status"` // PAUSED | RUNNING
}

type Region struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	DemandFactor float64 `json:"demand_factor"`
}

type Depot struct {
	ID                      string             `json:"id"`
	Name                    string             `json:"name"`
	RegionID                string             `json:"region_id"`
	Status                  string             `json:"status"` // OPEN | CONSTRAINED (cosmetic: no capacity change)
	DispatchCapacityPerTick float64            `json:"dispatch_capacity_per_tick"`
	Capacity                map[string]float64 `json:"capacity"`
	Inventory               map[string]float64 `json:"inventory"`
}

type Station struct {
	ID               string             `json:"id"`
	Name             string             `json:"name"`
	RegionID         string             `json:"region_id"`
	Status           string             `json:"status"` // OPEN | OUTAGE
	DemandProfile    string             `json:"demand_profile"`
	DemandMultiplier float64            `json:"demand_multiplier"`
	Capacity         map[string]float64 `json:"capacity"`
	Inventory        map[string]float64 `json:"inventory"`
}

type Route struct {
	ID                   string  `json:"id"`
	SourceDepotID        string  `json:"source_depot_id"`
	DestinationStationID string  `json:"destination_station_id"`
	TransitTicks         int     `json:"transit_ticks"`
	MaxShipment          float64 `json:"max_shipment"`
	Status               string  `json:"status"` // AVAILABLE | DISRUPTED
}

type SupplyArrival struct {
	ID          string  `json:"id"`
	DepotID     string  `json:"depot_id"`
	FuelType    string  `json:"fuel_type"`
	Quantity    float64 `json:"quantity"`
	PlannedTick int     `json:"planned_tick"`
	ActualTick  *int    `json:"actual_tick"`
	Status      string  `json:"status"` // SCHEDULED | DELAYED | ARRIVED
}

// Event is a domain (crisis) event. Effects cover ticks StartTick..EndTick INCLUSIVE:
// the engine resolves events after departures and demand on EndTick.
type Event struct {
	ID         int            `json:"id"`
	Type       string         `json:"type"`
	StartTick  int            `json:"start_tick"`
	EndTick    int            `json:"end_tick"`
	Status     string         `json:"status"` // SCHEDULED | ACTIVE | RESOLVED
	Parameters map[string]any `json:"parameters"`
}

type Allocation struct {
	ID                   int     `json:"id"`
	IdempotencyKey       string  `json:"idempotency_key"`
	SourceDepotID        string  `json:"source_depot_id"`
	DestinationStationID string  `json:"destination_station_id"`
	RouteID              string  `json:"route_id"`
	FuelType             string  `json:"fuel_type"`
	Quantity             float64 `json:"quantity"`
	CreatedTick          int     `json:"created_tick"`
	DepartureTick        *int    `json:"departure_tick"`
	ExpectedArrivalTick  *int    `json:"expected_arrival_tick"`
	ActualArrivalTick    *int    `json:"actual_arrival_tick"`
	Status               string  `json:"status"` // PENDING | IN_TRANSIT | ARRIVED | FAILED | CANCELLED
	FailureReason        *string `json:"failure_reason"`
}

type DemandObservation struct {
	ID           int64   `json:"id"`
	StationID    string  `json:"station_id"`
	FuelType     string  `json:"fuel_type"`
	Tick         int     `json:"tick"`
	SimTime      string  `json:"sim_time"`
	DemandLiters float64 `json:"demand_liters"`
	ServedLiters float64 `json:"served_liters"`
	UnmetLiters  float64 `json:"unmet_liters"`
}

type Metrics struct {
	ServedDemandLiters float64 `json:"served_demand_liters"`
	UnmetDemandLiters  float64 `json:"unmet_demand_liters"`
	ServiceLevel       float64 `json:"service_level"`
	AllocationLiters   float64 `json:"allocation_liters"`
	AllocationFailures int     `json:"allocation_failures"`
}

// World is one tick-consistent snapshot of every simulator resource.
type World struct {
	Instance    Instance        `json:"instance"`
	Regions     []Region        `json:"regions"`
	Depots      []Depot         `json:"depots"`
	Stations    []Station       `json:"stations"`
	Routes      []Route         `json:"routes"`
	Events      []Event         `json:"events"`
	Allocations []Allocation    `json:"allocations"`
	Supply      []SupplyArrival `json:"supply_arrivals"`
	Stale       bool            `json:"stale"` // any response carried X-Simulator-Stale
}

// ParseSimTime parses sim_time. The simulator emits it WITHOUT a UTC offset
// (SQLite drops tz info) even though the guide shows "+00:00"; both are accepted as UTC.
func ParseSimTime(s string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC(), nil
	}
	return time.ParseInLocation("2006-01-02T15:04:05.999999999", strings.TrimSpace(s), time.UTC)
}
