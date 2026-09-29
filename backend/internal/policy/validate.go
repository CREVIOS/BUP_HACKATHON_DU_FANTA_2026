package policy

import (
	"fmt"
	"math"
	"math/rand/v2"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
)

// Proposal is one candidate shipment, from the planner or from an operator.
type Proposal struct {
	StationID string  `json:"station_id"`
	FuelType  string  `json:"fuel_type"`
	RouteID   string  `json:"route_id"`
	Quantity  float64 `json:"quantity"`
}

// Validate lists every reason p must not be submitted at the current tick: what the simulator would reject
// (409s), plus what it would accept and then silently lose fuel on (route disrupted at the departure tick,
// station overflow counting fuel already in transit). Empty means safe to submit.
func Validate(w sim.World, p Proposal) []string {
	route, ok := findRoute(w, p.RouteID)
	if !ok {
		return []string{fmt.Sprintf("unknown route %q", p.RouteID)}
	}
	st, ok := findStation(w, p.StationID)
	if !ok {
		return []string{fmt.Sprintf("unknown station %q", p.StationID)}
	}
	if _, ok := st.Capacity[p.FuelType]; !ok {
		return []string{fmt.Sprintf("unknown fuel type %q", p.FuelType)}
	}
	if math.IsNaN(p.Quantity) || math.IsInf(p.Quantity, 0) || p.Quantity <= 0 {
		return []string{"quantity must be a positive number of liters"}
	}
	var why []string
	if route.DestinationStationID != st.ID {
		why = append(why, fmt.Sprintf("route %s does not serve %s", route.ID, st.ID))
	}
	now := w.Instance.Tick
	if st.Status != "OPEN" {
		why = append(why, fmt.Sprintf("station is %s", st.Status))
	}
	if RouteDisruptedAt(w, route.ID, now) {
		why = append(why, fmt.Sprintf("route disrupted at departure tick %d: the simulator would FAIL it and keep the fuel", now))
	}
	if p.Quantity > route.MaxShipment {
		why = append(why, fmt.Sprintf("%.0f L exceeds route max shipment %.0f L", p.Quantity, route.MaxShipment))
	}
	if d, ok := findDepot(w, route.SourceDepotID); ok {
		if inv := d.Inventory[p.FuelType]; inv < p.Quantity {
			why = append(why, fmt.Sprintf("depot %s has only %.0f L %s", d.ID, inv, p.FuelType))
		}
		if left := dispatchLeft(w)[d.ID]; left < p.Quantity {
			why = append(why, fmt.Sprintf("depot %s dispatch capacity left this tick is %.0f L (all fuels)", d.ID, left))
		}
	}
	inTransit := sum(InTransit(w)[st.ID][p.FuelType])
	if room := st.Capacity[p.FuelType] - st.Inventory[p.FuelType] - inTransit; p.Quantity > room {
		why = append(why, fmt.Sprintf("would overflow %s: room %.0f L counting %.0f L in transit (the simulator destroys overflow)",
			st.ID, max(room, 0), inTransit))
	}
	return why
}

// Impact projects the proposal's series without and with p, on common random numbers,
// so the difference between the two is the effect of p alone.
func Impact(w sim.World, p Proposal, o Options) (before, after Projection, err error) {
	st, ok := findStation(w, p.StationID)
	route, rok := findRoute(w, p.RouteID)
	if !ok || !rok {
		return before, after, fmt.Errorf("unknown station or route")
	}
	f := NewForecaster(w)
	arrivals, _ := inbound(w, routeMap(w))
	k := seriesKey{st.ID, p.FuelType}
	extra := map[int]float64{w.Instance.Tick + route.TransitTicks: p.Quantity}
	before = project(f, st, p.FuelType, arrivals[k], nil, o.Horizon, o.Runs, seededRNG(w))
	after = project(f, st, p.FuelType, arrivals[k], extra, o.Horizon, o.Runs, seededRNG(w))
	return before, after, nil
}

// Risks projects every (station, fuel) series, most urgent first. It is the same view the planner uses.
func Risks(w sim.World, o Options) []Projection { return MakePlan(w, o).Risks }

// InTransit is fuel that will still arrive, by station and fuel: arrival tick -> liters.
// PENDING allocations whose route is disrupted at departure are excluded (they will FAIL).
func InTransit(w sim.World) map[string]map[string]map[int]float64 {
	arrivals, _ := inbound(w, routeMap(w))
	out := map[string]map[string]map[int]float64{}
	for k, v := range arrivals {
		if out[k.station] == nil {
			out[k.station] = map[string]map[int]float64{}
		}
		out[k.station][k.fuel] = v
	}
	return out
}

// DispatchLeft is each depot's remaining all-fuel dispatch capacity for the current tick.
func DispatchLeft(w sim.World) map[string]float64 { return dispatchLeft(w) }

func dispatchLeft(w sim.World) map[string]float64 {
	left := map[string]float64{}
	for _, d := range w.Depots {
		left[d.ID] = d.DispatchCapacityPerTick
	}
	for _, a := range w.Allocations {
		if a.CreatedTick == w.Instance.Tick && (a.Status == "PENDING" || a.Status == "IN_TRANSIT") {
			left[a.SourceDepotID] -= a.Quantity
		}
	}
	return left
}

func seededRNG(w sim.World) *rand.Rand {
	return rand.New(rand.NewPCG(uint64(w.Instance.Seed), uint64(w.Instance.Tick)))
}

func routeMap(w sim.World) map[string]sim.Route {
	m := map[string]sim.Route{}
	for _, r := range w.Routes {
		m[r.ID] = r
	}
	return m
}

func findRoute(w sim.World, id string) (sim.Route, bool) {
	for _, r := range w.Routes {
		if r.ID == id {
			return r, true
		}
	}
	return sim.Route{}, false
}

func findStation(w sim.World, id string) (sim.Station, bool) {
	for _, s := range w.Stations {
		if s.ID == id {
			return s, true
		}
	}
	return sim.Station{}, false
}

func findDepot(w sim.World, id string) (sim.Depot, bool) {
	for _, d := range w.Depots {
		if d.ID == id {
			return d, true
		}
	}
	return sim.Depot{}, false
}

func sum(m map[int]float64) float64 {
	t := 0.0
	for _, v := range m {
		t += v
	}
	return t
}
