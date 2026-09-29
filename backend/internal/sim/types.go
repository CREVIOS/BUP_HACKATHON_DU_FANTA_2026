// Package sim's types.go mirrors every simulator resource shape from the
// Integration Guide (§4, §5) as a Go struct, and gives each one a Validate()
// so an invalid simulator response can be rejected instead of stored
// (brief §11: "Invalid simulator response -> Reject input + raise alert").
//
// Enums are typed strings with a Valid() method; the zero value is never valid,
// so a missing field in a decoded payload fails validation rather than passing
// silently.
package sim

import (
	"fmt"
	"strings"
	"time"
)

// FuelType is one of the three fuels the world trades in (guide §5.1, §8).
type FuelType string

const (
	Diesel FuelType = "DIESEL"
	Petrol FuelType = "PETROL"
	Octane FuelType = "OCTANE"
)

// AllFuels is the canonical set, in a stable order for iteration.
var AllFuels = []FuelType{Diesel, Petrol, Octane}

func (f FuelType) Valid() bool { return f == Diesel || f == Petrol || f == Octane }

// FuelMap is a per-fuel quantity in liters (the shape of capacity / inventory).
type FuelMap map[FuelType]float64

// valid reports whether every key is a known fuel and every value is finite and
// non-negative. An empty map is allowed (a resource may omit a fuel).
func (m FuelMap) valid() error {
	for k, v := range m {
		if !k.Valid() {
			return fmt.Errorf("unknown fuel %q", k)
		}
		if v < 0 || isNaNOrInf(v) {
			return fmt.Errorf("fuel %s: bad quantity %v", k, v)
		}
	}
	return nil
}

// --- Enums for the simulator's status fields ---------------------------------

type SimStatus string

const (
	Paused  SimStatus = "PAUSED"
	Running SimStatus = "RUNNING"
)

func (s SimStatus) Valid() bool { return s == Paused || s == Running }

type DepotStatus string

const (
	DepotOpen        DepotStatus = "OPEN"
	DepotConstrained DepotStatus = "CONSTRAINED"
)

func (s DepotStatus) Valid() bool { return s == DepotOpen || s == DepotConstrained }

type StationStatus string

const (
	StationOpen   StationStatus = "OPEN"
	StationOutage StationStatus = "OUTAGE"
)

func (s StationStatus) Valid() bool { return s == StationOpen || s == StationOutage }

type RouteStatus string

const (
	RouteAvailable RouteStatus = "AVAILABLE"
	RouteDisrupted RouteStatus = "DISRUPTED"
)

func (s RouteStatus) Valid() bool { return s == RouteAvailable || s == RouteDisrupted }

type SupplyStatus string

const (
	SupplyScheduled SupplyStatus = "SCHEDULED"
	SupplyDelayed   SupplyStatus = "DELAYED"
	SupplyArrived   SupplyStatus = "ARRIVED"
)

func (s SupplyStatus) Valid() bool {
	return s == SupplyScheduled || s == SupplyDelayed || s == SupplyArrived
}

type EventStatus string

const (
	EventScheduled EventStatus = "SCHEDULED"
	EventActive    EventStatus = "ACTIVE"
	EventResolved  EventStatus = "RESOLVED"
)

func (s EventStatus) Valid() bool {
	return s == EventScheduled || s == EventActive || s == EventResolved
}

type AllocationStatus string

const (
	AllocPending   AllocationStatus = "PENDING"
	AllocInTransit AllocationStatus = "IN_TRANSIT"
	AllocArrived   AllocationStatus = "ARRIVED"
	AllocFailed    AllocationStatus = "FAILED"
	AllocCancelled AllocationStatus = "CANCELLED"
)

func (s AllocationStatus) Valid() bool {
	switch s {
	case AllocPending, AllocInTransit, AllocArrived, AllocFailed, AllocCancelled:
		return true
	}
	return false
}

// --- Resource structs (guide §4, §5) -----------------------------------------

// Instance mirrors GET /v1/instance.
type Instance struct {
	ID              int       `json:"id"`
	ScenarioID      string    `json:"scenario_id"`
	ScenarioVersion string    `json:"scenario_version"`
	Seed            int64     `json:"seed"`
	SimTime         string    `json:"sim_time"`
	Tick            int       `json:"tick"`
	TickMinutes     int       `json:"tick_minutes"`
	Status          SimStatus `json:"status"`
}

func (v Instance) Validate() error {
	if v.ScenarioID == "" {
		return field("instance", "scenario_id", "empty")
	}
	if v.Tick < 0 {
		return field("instance", "tick", "negative")
	}
	if !v.Status.Valid() {
		return field("instance", "status", string(v.Status))
	}
	if _, err := ParseSimTime(v.SimTime); err != nil {
		return field("instance", "sim_time", v.SimTime)
	}
	return nil
}

// Region mirrors GET /v1/regions (§4.4).
type Region struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	DemandFactor float64 `json:"demand_factor"`
}

func (v Region) Validate() error {
	if v.ID == "" {
		return field("region", "id", "empty")
	}
	if v.DemandFactor < 0 || isNaNOrInf(v.DemandFactor) {
		return field("region", "demand_factor", "negative or non-finite")
	}
	return nil
}

// Depot mirrors GET /v1/depots (§4.5).
type Depot struct {
	ID                      string      `json:"id"`
	Name                    string      `json:"name"`
	RegionID                string      `json:"region_id"`
	Status                  DepotStatus `json:"status"`
	DispatchCapacityPerTick float64     `json:"dispatch_capacity_per_tick"`
	Capacity                FuelMap     `json:"capacity"`
	Inventory               FuelMap     `json:"inventory"`
}

func (v Depot) Validate() error {
	if v.ID == "" {
		return field("depot", "id", "empty")
	}
	if v.RegionID == "" {
		return field("depot", "region_id", "empty")
	}
	if !v.Status.Valid() {
		return field("depot", "status", string(v.Status))
	}
	if v.DispatchCapacityPerTick < 0 || isNaNOrInf(v.DispatchCapacityPerTick) {
		return field("depot", "dispatch_capacity_per_tick", "negative or non-finite")
	}
	if err := v.Capacity.valid(); err != nil {
		return fmt.Errorf("depot %s capacity: %w", v.ID, err)
	}
	if err := v.Inventory.valid(); err != nil {
		return fmt.Errorf("depot %s inventory: %w", v.ID, err)
	}
	return nil
}

// Station mirrors GET /v1/stations (§4.6).
type Station struct {
	ID               string        `json:"id"`
	Name             string        `json:"name"`
	RegionID         string        `json:"region_id"`
	Status           StationStatus `json:"status"`
	DemandProfile    string        `json:"demand_profile"`
	DemandMultiplier float64       `json:"demand_multiplier"`
	Capacity         FuelMap       `json:"capacity"`
	Inventory        FuelMap       `json:"inventory"`
}

func (v Station) Validate() error {
	if v.ID == "" {
		return field("station", "id", "empty")
	}
	if v.RegionID == "" {
		return field("station", "region_id", "empty")
	}
	if !v.Status.Valid() {
		return field("station", "status", string(v.Status))
	}
	if v.DemandMultiplier < 0 || isNaNOrInf(v.DemandMultiplier) {
		return field("station", "demand_multiplier", "negative or non-finite")
	}
	if err := v.Capacity.valid(); err != nil {
		return fmt.Errorf("station %s capacity: %w", v.ID, err)
	}
	if err := v.Inventory.valid(); err != nil {
		return fmt.Errorf("station %s inventory: %w", v.ID, err)
	}
	return nil
}

// Route mirrors GET /v1/routes (§4.7).
type Route struct {
	ID                   string      `json:"id"`
	SourceDepotID        string      `json:"source_depot_id"`
	DestinationStationID string      `json:"destination_station_id"`
	TransitTicks         int         `json:"transit_ticks"`
	MaxShipment          float64     `json:"max_shipment"`
	Status               RouteStatus `json:"status"`
}

func (v Route) Validate() error {
	if v.ID == "" {
		return field("route", "id", "empty")
	}
	if v.SourceDepotID == "" || v.DestinationStationID == "" {
		return field("route", "endpoints", "empty depot or station id")
	}
	if v.TransitTicks < 0 {
		return field("route", "transit_ticks", "negative")
	}
	if v.MaxShipment <= 0 || isNaNOrInf(v.MaxShipment) {
		return field("route", "max_shipment", "not positive or non-finite")
	}
	if !v.Status.Valid() {
		return field("route", "status", string(v.Status))
	}
	return nil
}

// SupplyArrival mirrors GET /v1/supply-arrivals (§4.8). actual_tick is null until arrival.
type SupplyArrival struct {
	ID          string       `json:"id"`
	DepotID     string       `json:"depot_id"`
	FuelType    FuelType     `json:"fuel_type"`
	Quantity    float64      `json:"quantity"`
	PlannedTick int          `json:"planned_tick"`
	ActualTick  *int         `json:"actual_tick"`
	Status      SupplyStatus `json:"status"`
}

func (v SupplyArrival) Validate() error {
	if v.ID == "" {
		return field("supply_arrival", "id", "empty")
	}
	if v.DepotID == "" {
		return field("supply_arrival", "depot_id", "empty")
	}
	if !v.FuelType.Valid() {
		return field("supply_arrival", "fuel_type", string(v.FuelType))
	}
	if v.Quantity < 0 || isNaNOrInf(v.Quantity) {
		return field("supply_arrival", "quantity", "negative or non-finite")
	}
	if !v.Status.Valid() {
		return field("supply_arrival", "status", string(v.Status))
	}
	return nil
}

// Event mirrors GET /v1/events (§4.9). parameters is left as free-form JSON.
type Event struct {
	ID         int            `json:"id"`
	Type       string         `json:"type"`
	StartTick  int            `json:"start_tick"`
	EndTick    int            `json:"end_tick"`
	Status     EventStatus    `json:"status"`
	Parameters map[string]any `json:"parameters"`
}

func (v Event) Validate() error {
	if v.Type == "" {
		return field("event", "type", "empty")
	}
	if v.StartTick < 0 || v.EndTick < 0 {
		return field("event", "tick", "negative")
	}
	if !v.Status.Valid() {
		return field("event", "status", string(v.Status))
	}
	return nil
}

// Allocation mirrors GET /v1/allocations and the 201 body (§4.10, §5.3).
// Tick fields are null before the shipment departs / arrives.
type Allocation struct {
	ID                   int              `json:"id"`
	IdempotencyKey       string           `json:"idempotency_key"`
	SourceDepotID        string           `json:"source_depot_id"`
	DestinationStationID string           `json:"destination_station_id"`
	RouteID              string           `json:"route_id"`
	FuelType             FuelType         `json:"fuel_type"`
	Quantity             float64          `json:"quantity"`
	CreatedTick          int              `json:"created_tick"`
	DepartureTick        *int             `json:"departure_tick"`
	ExpectedArrivalTick  *int             `json:"expected_arrival_tick"`
	ActualArrivalTick    *int             `json:"actual_arrival_tick"`
	Status               AllocationStatus `json:"status"`
	FailureReason        *string          `json:"failure_reason"`
}

func (v Allocation) Validate() error {
	if !v.FuelType.Valid() {
		return field("allocation", "fuel_type", string(v.FuelType))
	}
	if !v.Status.Valid() {
		return field("allocation", "status", string(v.Status))
	}
	if v.Quantity <= 0 || isNaNOrInf(v.Quantity) {
		return field("allocation", "quantity", "not positive or non-finite")
	}
	return nil
}

// DemandObservation mirrors one row of GET /v1/demand-history (§4.11).
type DemandObservation struct {
	ID           int      `json:"id"`
	StationID    string   `json:"station_id"`
	FuelType     FuelType `json:"fuel_type"`
	Tick         int      `json:"tick"`
	SimTime      string   `json:"sim_time"`
	DemandLiters float64  `json:"demand_liters"`
	ServedLiters float64  `json:"served_liters"`
	UnmetLiters  float64  `json:"unmet_liters"`
}

func (v DemandObservation) Validate() error {
	if v.StationID == "" {
		return field("demand_observation", "station_id", "empty")
	}
	if !v.FuelType.Valid() {
		return field("demand_observation", "fuel_type", string(v.FuelType))
	}
	if v.DemandLiters < 0 || v.ServedLiters < 0 || v.UnmetLiters < 0 {
		return field("demand_observation", "liters", "negative")
	}
	return nil
}

// Metrics mirrors GET /v1/metrics (§4.12).
type Metrics struct {
	ServedDemandLiters float64 `json:"served_demand_liters"`
	UnmetDemandLiters  float64 `json:"unmet_demand_liters"`
	ServiceLevel       float64 `json:"service_level"`
	AllocationLiters   float64 `json:"allocation_liters"`
	AllocationFailures int     `json:"allocation_failures"`
}

func (v Metrics) Validate() error {
	if v.ServiceLevel < 0 || v.ServiceLevel > 1 || isNaNOrInf(v.ServiceLevel) {
		return field("metrics", "service_level", "outside [0,1]")
	}
	if v.AllocationFailures < 0 {
		return field("metrics", "allocation_failures", "negative")
	}
	return nil
}

// --- The one domain write (guide §5.1) ---------------------------------------

// AllocationRequest is the POST /v1/allocations body. It is the only input this
// system writes to the simulator, so it is validated client-side before it ever
// reaches the outbox (§5.1 constraint table; §9 "Validate your payload
// client-side first").
type AllocationRequest struct {
	IdempotencyKey       string   `json:"idempotency_key"`
	SourceDepotID        string   `json:"source_depot_id"`
	DestinationStationID string   `json:"destination_station_id"`
	RouteID              string   `json:"route_id"`
	FuelType             FuelType `json:"fuel_type"`
	Quantity             float64  `json:"quantity"`
}

// Validate enforces every statically checkable §5.1 constraint. The route-relative
// bound (quantity <= route.max_shipment) is not checkable here; the caller must
// compare against the current /v1/routes snapshot before enqueueing.
func (r AllocationRequest) Validate() error {
	if n := len(r.IdempotencyKey); n < 1 || n > 150 {
		return field("allocation_request", "idempotency_key", "length must be 1-150")
	}
	if r.SourceDepotID == "" {
		return field("allocation_request", "source_depot_id", "empty")
	}
	if r.DestinationStationID == "" {
		return field("allocation_request", "destination_station_id", "empty")
	}
	if r.RouteID == "" {
		return field("allocation_request", "route_id", "empty")
	}
	if !r.FuelType.Valid() {
		return field("allocation_request", "fuel_type", string(r.FuelType))
	}
	if r.Quantity <= 0 || isNaNOrInf(r.Quantity) {
		return field("allocation_request", "quantity", "must be > 0 and finite")
	}
	return nil
}

// --- Aggregate snapshot -------------------------------------------------------

// Snapshot is the full world read the ingestor persists into snapshots.payload.
// Validate() checks every element so a corrupt simulator response is rejected as
// a unit before it is stored.
type Snapshot struct {
	Instance       Instance        `json:"instance"`
	Regions        []Region        `json:"regions"`
	Depots         []Depot         `json:"depots"`
	Stations       []Station       `json:"stations"`
	Routes         []Route         `json:"routes"`
	SupplyArrivals []SupplyArrival `json:"supply_arrivals"`
	Events         []Event         `json:"events"`
	Allocations    []Allocation    `json:"allocations"`
	Metrics        Metrics         `json:"metrics"`
}

// validatable is implemented by every resource struct above.
type validatable interface{ Validate() error }

func (s Snapshot) Validate() error {
	groups := []struct {
		name  string
		items []validatable
	}{
		{"instance", []validatable{s.Instance}},
		{"metrics", []validatable{s.Metrics}},
		{"regions", asValidatable(s.Regions)},
		{"depots", asValidatable(s.Depots)},
		{"stations", asValidatable(s.Stations)},
		{"routes", asValidatable(s.Routes)},
		{"supply_arrivals", asValidatable(s.SupplyArrivals)},
		{"events", asValidatable(s.Events)},
		{"allocations", asValidatable(s.Allocations)},
	}
	for _, g := range groups {
		for i, it := range g.items {
			if err := it.Validate(); err != nil {
				return fmt.Errorf("%s[%d]: %w", g.name, i, err)
			}
		}
	}
	return nil
}

func asValidatable[T validatable](in []T) []validatable {
	out := make([]validatable, len(in))
	for i := range in {
		out[i] = in[i]
	}
	return out
}

// --- helpers ------------------------------------------------------------------

func field(kind, name, why string) error {
	return fmt.Errorf("%s.%s: %s", kind, name, why)
}

// isNaNOrInf reports whether f is NaN or +/-Inf, without importing math into hot
// paths elsewhere. JSON decodes those from "NaN"/"Infinity" only in non-strict
// modes, but a divide-derived value upstream can still produce them.
func isNaNOrInf(f float64) bool { return f != f || f > 1e308 || f < -1e308 }

// ParseSimTime parses sim_time. The simulator emits it WITHOUT a UTC offset
// (SQLite drops tz info) even though the guide shows "+00:00"; both are accepted as UTC.
func ParseSimTime(s string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC(), nil
	}
	return time.ParseInLocation("2006-01-02T15:04:05.999999999", strings.TrimSpace(s), time.UTC)
}
