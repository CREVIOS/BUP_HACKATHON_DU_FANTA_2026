package policy

import (
	"math/rand/v2"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
)

// Projection is the forward view of one (station, fuel) series from the current tick.
type Projection struct {
	StationID      string  `json:"station_id"`
	FuelType       string  `json:"fuel_type"`
	OnHand         float64 `json:"on_hand"`
	InTransit      float64 `json:"in_transit"` // PENDING (not doomed) + IN_TRANSIT to this station
	Capacity       float64 `json:"capacity"`
	DemandHorizon  float64 `json:"demand_horizon"`   // expected demand over the horizon
	TimeToStockout int     `json:"time_to_stockout"` // ticks until expected shortfall on the mean path; -1 = none in horizon
	StockoutProb   float64 `json:"stockout_prob"`    // P(any unmet demand within horizon), uniform-noise ensemble
	// ExpectedShortfall is the demand left unserved over the horizon on the mean path (liters). Unlike the
	// probability it still moves when a shortage is certain: a shipment that cannot prevent it still shrinks it.
	ExpectedShortfall float64 `json:"expected_shortfall"`
	arrivals          map[int]float64
}

// Position is on-hand plus everything already on its way.
func (p Projection) Position() float64 { return p.OnHand + p.InTransit }

type seriesKey struct{ station, fuel string }

// inbound returns arrivals per series (tick -> liters) for allocations that will actually arrive,
// plus PENDING allocations that are doomed: their route is disrupted at their departure tick, so the
// engine will mark them FAILED and the depot fuel is lost (no refund). Those must be cancelled.
func inbound(w sim.World, routes map[string]sim.Route) (map[seriesKey]map[int]float64, []sim.Allocation) {
	now := w.Instance.Tick
	out := map[seriesKey]map[int]float64{}
	var doomed []sim.Allocation
	for _, a := range w.Allocations {
		var at int
		switch a.Status {
		case "IN_TRANSIT":
			if a.ExpectedArrivalTick == nil {
				continue
			}
			at = *a.ExpectedArrivalTick
		case "PENDING":
			dep := max(a.CreatedTick, now)
			if RouteDisruptedAt(w, a.RouteID, dep) {
				doomed = append(doomed, a)
				continue
			}
			at = dep + routes[a.RouteID].TransitTicks
		default:
			continue
		}
		k := seriesKey{a.DestinationStationID, a.FuelType}
		if out[k] == nil {
			out[k] = map[int]float64{}
		}
		out[k][at] += a.Quantity
	}
	return out, doomed
}

// RouteDisruptedAt reports whether route id is unusable for a departure on tick t. Event windows are
// inclusive (the engine resolves events after departures on end_tick). Route events only affect the ids
// they list: an empty route_ids list disrupts nothing (contrary to the guide).
func RouteDisruptedAt(w sim.World, id string, t int) bool {
	for _, e := range w.Events {
		if e.Type != "route_disruption" || !contains(strParam(e.Parameters, "route_ids"), id) {
			continue
		}
		if (e.Status == "SCHEDULED" || e.Status == "ACTIVE") && t >= e.StartTick && t <= e.EndTick {
			return true
		}
	}
	if t == w.Instance.Tick {
		for _, r := range w.Routes {
			if r.ID == id && r.Status != "AVAILABLE" {
				return true
			}
		}
	}
	return false
}

// project simulates one series for horizon ticks: mean path for time-to-stockout, plus `runs` noisy paths
// (independent uniform jitter per tick, as the engine does) for the stockout probability.
// extra adds a hypothetical arrival (tick -> liters) to evaluate a recommendation's impact.
func project(f *Forecaster, s sim.Station, fuel string, arrivals map[int]float64, extra map[int]float64,
	horizon, runs int, rng *rand.Rand) Projection {
	p := Projection{
		StationID: s.ID, FuelType: fuel, OnHand: s.Inventory[fuel], Capacity: s.Capacity[fuel],
		TimeToStockout: -1, arrivals: arrivals,
	}
	for _, q := range arrivals {
		p.InTransit += q
	}
	demand := make([]float64, horizon)
	for k := range demand {
		if s.Status != "OPEN" {
			continue // outage: nothing is served, inventory is not consumed
		}
		demand[k] = f.Expected(s, fuel, f.now+k)
		p.DemandHorizon += demand[k]
	}
	cap := s.Capacity[fuel]
	step := func(inv float64, k int, d float64) float64 {
		t := f.now + k
		inv = min(cap, inv+arrivals[t]+extra[t]) // the engine clips arrivals at capacity
		return inv - d
	}
	inv := p.OnHand
	for k, d := range demand {
		if inv = step(inv, k, d); inv < 0 {
			if p.TimeToStockout < 0 {
				p.TimeToStockout = k
			}
			p.ExpectedShortfall -= inv
		}
		inv = max(inv, 0)
	}
	noise := Noise(s)
	stockouts := 0
	for range runs {
		inv := p.OnHand
		for k, d := range demand {
			if inv = step(inv, k, d*(1+noise*(2*rng.Float64()-1))); inv < 0 {
				stockouts++
				break
			}
		}
	}
	if runs > 0 {
		p.StockoutProb = float64(stockouts) / float64(runs)
	}
	return p
}
