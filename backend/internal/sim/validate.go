package sim

import "fmt"

// This file layers typed validation over the simulator resource structs in
// types.go. The structs mirror the wire shapes (loose string fields); the
// helpers and Validate() methods here enforce the guide's enums and bounds so
// a malformed simulator response can be rejected (brief §11) and so the one
// domain write, AllocationRequest, is fully typed and validated client-side
// before it reaches the outbox (guide §5.1).

// FuelType is one of the three fuels (guide §5.1, §8). It is a typed string so
// the write path (AllocationRequest) carries a checked value, while the wire
// structs keep plain-string fields for lossless decoding.
type FuelType string

const (
	Diesel FuelType = "DIESEL"
	Petrol FuelType = "PETROL"
	Octane FuelType = "OCTANE"
)

func (f FuelType) Valid() bool { return f == Diesel || f == Petrol || f == Octane }

// validFuel reports whether a raw wire string is a known fuel.
func validFuel(s string) bool { return FuelType(s).Valid() }

func oneOf(v string, allowed ...string) bool {
	for _, a := range allowed {
		if v == a {
			return true
		}
	}
	return false
}

// isNaNOrInf reports whether f is NaN or +/-Inf without importing math.
func isNaNOrInf(f float64) bool { return f != f || f > 1e308 || f < -1e308 }

func nonneg(f float64) bool { return f >= 0 && !isNaNOrInf(f) }

// fuelMapOK checks capacity/inventory maps: known fuel keys, finite non-negative values.
func fuelMapOK(kind, id string, m map[string]float64) error {
	for k, v := range m {
		if !validFuel(k) {
			return fmt.Errorf("%s %s: unknown fuel %q", kind, id, k)
		}
		if !nonneg(v) {
			return fmt.Errorf("%s %s: fuel %s bad quantity %v", kind, id, k, v)
		}
	}
	return nil
}

func field(kind, name, why string) error { return fmt.Errorf("%s.%s: %s", kind, name, why) }

// --- Validate() on each wire resource ---------------------------------------

func (v Instance) Validate() error {
	if v.ScenarioID == "" {
		return field("instance", "scenario_id", "empty")
	}
	if v.Tick < 0 {
		return field("instance", "tick", "negative")
	}
	if !oneOf(v.Status, "PAUSED", "RUNNING") {
		return field("instance", "status", v.Status)
	}
	if _, err := ParseSimTime(v.SimTime); err != nil {
		return field("instance", "sim_time", v.SimTime)
	}
	return nil
}

func (v Region) Validate() error {
	if v.ID == "" {
		return field("region", "id", "empty")
	}
	if !nonneg(v.DemandFactor) {
		return field("region", "demand_factor", "negative or non-finite")
	}
	return nil
}

func (v Depot) Validate() error {
	if v.ID == "" || v.RegionID == "" {
		return field("depot", "id/region_id", "empty")
	}
	if !oneOf(v.Status, "OPEN", "CONSTRAINED") {
		return field("depot", "status", v.Status)
	}
	if !nonneg(v.DispatchCapacityPerTick) {
		return field("depot", "dispatch_capacity_per_tick", "negative or non-finite")
	}
	if err := fuelMapOK("depot", v.ID, v.Capacity); err != nil {
		return err
	}
	return fuelMapOK("depot", v.ID, v.Inventory)
}

func (v Station) Validate() error {
	if v.ID == "" || v.RegionID == "" {
		return field("station", "id/region_id", "empty")
	}
	if !oneOf(v.Status, "OPEN", "OUTAGE") {
		return field("station", "status", v.Status)
	}
	if !nonneg(v.DemandMultiplier) {
		return field("station", "demand_multiplier", "negative or non-finite")
	}
	if err := fuelMapOK("station", v.ID, v.Capacity); err != nil {
		return err
	}
	return fuelMapOK("station", v.ID, v.Inventory)
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
	if !oneOf(v.Status, "AVAILABLE", "DISRUPTED") {
		return field("route", "status", v.Status)
	}
	return nil
}

func (v SupplyArrival) Validate() error {
	if v.ID == "" || v.DepotID == "" {
		return field("supply_arrival", "id/depot_id", "empty")
	}
	if !validFuel(v.FuelType) {
		return field("supply_arrival", "fuel_type", v.FuelType)
	}
	if !nonneg(v.Quantity) {
		return field("supply_arrival", "quantity", "negative or non-finite")
	}
	if !oneOf(v.Status, "SCHEDULED", "DELAYED", "ARRIVED") {
		return field("supply_arrival", "status", v.Status)
	}
	return nil
}

func (v Event) Validate() error {
	if v.Type == "" {
		return field("event", "type", "empty")
	}
	if v.StartTick < 0 || v.EndTick < 0 {
		return field("event", "tick", "negative")
	}
	if !oneOf(v.Status, "SCHEDULED", "ACTIVE", "RESOLVED") {
		return field("event", "status", v.Status)
	}
	return nil
}

func (v Allocation) Validate() error {
	if !validFuel(v.FuelType) {
		return field("allocation", "fuel_type", v.FuelType)
	}
	if !oneOf(v.Status, "PENDING", "IN_TRANSIT", "ARRIVED", "FAILED", "CANCELLED") {
		return field("allocation", "status", v.Status)
	}
	if v.Quantity <= 0 || isNaNOrInf(v.Quantity) {
		return field("allocation", "quantity", "not positive or non-finite")
	}
	return nil
}

func (v DemandObservation) Validate() error {
	if v.StationID == "" {
		return field("demand_observation", "station_id", "empty")
	}
	if !validFuel(v.FuelType) {
		return field("demand_observation", "fuel_type", v.FuelType)
	}
	if v.DemandLiters < 0 || v.ServedLiters < 0 || v.UnmetLiters < 0 {
		return field("demand_observation", "liters", "negative")
	}
	return nil
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

// Validate checks every element of a world snapshot, so a corrupt simulator
// response is rejected as a unit before it is persisted.
func (w World) Validate() error {
	if err := w.Instance.Validate(); err != nil {
		return err
	}
	for i, r := range w.Regions {
		if err := r.Validate(); err != nil {
			return fmt.Errorf("regions[%d]: %w", i, err)
		}
	}
	for i, d := range w.Depots {
		if err := d.Validate(); err != nil {
			return fmt.Errorf("depots[%d]: %w", i, err)
		}
	}
	for i, s := range w.Stations {
		if err := s.Validate(); err != nil {
			return fmt.Errorf("stations[%d]: %w", i, err)
		}
	}
	for i, r := range w.Routes {
		if err := r.Validate(); err != nil {
			return fmt.Errorf("routes[%d]: %w", i, err)
		}
	}
	for i, e := range w.Events {
		if err := e.Validate(); err != nil {
			return fmt.Errorf("events[%d]: %w", i, err)
		}
	}
	for i, a := range w.Allocations {
		if err := a.Validate(); err != nil {
			return fmt.Errorf("allocations[%d]: %w", i, err)
		}
	}
	for i, s := range w.Supply {
		if err := s.Validate(); err != nil {
			return fmt.Errorf("supply_arrivals[%d]: %w", i, err)
		}
	}
	return nil
}

// --- The one domain write (guide §5.1) --------------------------------------

// AllocationRequest is the POST /v1/allocations body: the only input this system
// writes to the simulator, fully typed and validated before it reaches the outbox.
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
