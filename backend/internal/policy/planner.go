package policy

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
)

const Version = "greedy-v1"

type Options struct {
	Horizon     int     // ticks projected for risk (48 = 12 simulated hours)
	Runs        int     // Monte Carlo paths per series
	SafetyTicks int     // reorder when position < demand over (lead + SafetyTicks)
	MinLot      float64 // never propose less than this (liters)
	ReviewQty   float64 // proposals above this always need human review
}

var DefaultOptions = Options{Horizon: 48, Runs: 64, SafetyTicks: 24, MinLot: 500, ReviewQty: 5000}

type Alternative struct {
	RouteID      string `json:"route_id"`
	DepotID      string `json:"depot_id"`
	TransitTicks int    `json:"transit_ticks"`
	Rejected     string `json:"rejected"` // why it was not chosen
}

type Recommendation struct {
	StationID      string         `json:"station_id"`
	FuelType       string         `json:"fuel_type"`
	DepotID        string         `json:"depot_id"`
	RouteID        string         `json:"route_id"`
	Quantity       float64        `json:"quantity"`
	TransitTicks   int            `json:"transit_ticks"`
	ArrivalTick    int            `json:"arrival_tick"`
	RiskBefore     float64        `json:"risk_before"`
	RiskAfter      float64        `json:"risk_after"`
	TimeToStockout int            `json:"time_to_stockout"` // -1 = none within horizon
	Binding        string         `json:"binding_constraint"`
	Signals        map[string]any `json:"signals"`
	Alternatives   []Alternative  `json:"alternatives"`
	ReviewRequired bool           `json:"review_required"`
	ReviewReasons  []string       `json:"review_reasons"`
}

type Plan struct {
	Tick            int              `json:"tick"`
	PolicyVersion   string           `json:"policy_version"`
	Recommendations []Recommendation `json:"recommendations"`
	Risks           []Projection     `json:"risks"`  // every open series, most urgent first
	Cancel          []sim.Allocation `json:"cancel"` // PENDING allocations that would FAIL and lose fuel
}

// MakePlan proposes at most one shipment per (station, fuel) for the current tick.
// Guarantees (docs/PLAN.md §2): never ships onto a route disrupted at departure; never ships more than the
// station can hold counting everything in transit (the server doesn't, and destroys overflow); respects route
// max, depot inventory and the per-depot all-fuel dispatch cap; keeps depot fuel reserved for captive stations.
func MakePlan(w sim.World, o Options) Plan {
	now := w.Instance.Tick
	f := NewForecaster(w)
	rng := seededRNG(w)
	arrivals, doomed := inbound(w, routeMap(w))
	plan := Plan{Tick: now, PolicyVersion: Version, Cancel: doomed}

	// Budgets for this tick.
	depotInv := map[string]map[string]float64{}
	for _, d := range w.Depots {
		depotInv[d.ID] = map[string]float64{}
		for k, v := range d.Inventory {
			depotInv[d.ID][k] = v
		}
	}
	dispatchLeft := dispatchLeft(w)

	// Project every open series.
	byStation := map[string]sim.Station{}
	proj := map[seriesKey]Projection{}
	for _, s := range w.Stations {
		byStation[s.ID] = s
		for _, fuel := range sim.FuelTypes {
			k := seriesKey{s.ID, fuel}
			p := project(f, s, fuel, arrivals[k], nil, o.Horizon, o.Runs, rng)
			proj[k] = p
			plan.Risks = append(plan.Risks, p)
		}
	}
	sort.SliceStable(plan.Risks, func(i, j int) bool { return urgency(plan.Risks[i]) < urgency(plan.Risks[j]) })

	reserve := captiveReserve(w, f, proj, o)
	stale := w.Stale

	for _, p := range plan.Risks {
		s := byStation[p.StationID]
		if s.Status != "OPEN" { // POST would be rejected with STATION_CLOSED
			continue
		}
		cands := routesTo(w.Routes, s.ID)
		if len(cands) == 0 {
			continue
		}
		lead := cands[0].TransitTicks
		reorder := 0.0
		for k := 0; k < lead+o.SafetyTicks; k++ {
			reorder += f.Expected(s, p.FuelType, now+k)
		}
		if p.Position() >= reorder {
			continue
		}

		var alts []Alternative
		var rec *Recommendation
		for _, r := range cands {
			alt := Alternative{RouteID: r.ID, DepotID: r.SourceDepotID, TransitTicks: r.TransitTicks}
			if RouteDisruptedAt(w, r.ID, now) {
				alt.Rejected = fmt.Sprintf("route disrupted at departure tick %d", now)
				alts = append(alts, alt)
				continue
			}
			if rec != nil {
				alt.Rejected = fmt.Sprintf("slower or already covered (chosen %s)", rec.RouteID)
				alts = append(alts, alt)
				continue
			}
			avail := depotInv[r.SourceDepotID][p.FuelType]
			if !isCaptiveOf(w.Routes, s.ID, r.SourceDepotID) {
				avail -= reserve[seriesKey{r.SourceDepotID, p.FuelType}]
			}
			limits := []struct {
				name string
				v    float64
			}{
				{"station room incl. in-transit", p.Capacity - p.Position()},
				{"route max_shipment", r.MaxShipment},
				{"depot inventory (after captive reserve)", avail},
				{"depot dispatch capacity this tick", dispatchLeft[r.SourceDepotID]},
			}
			q, binding := math.Inf(1), ""
			for _, l := range limits {
				if l.v < q {
					q, binding = l.v, l.name
				}
			}
			q = math.Floor(q)
			if q < o.MinLot {
				alt.Rejected = fmt.Sprintf("only %.0f L possible (%s)", max(q, 0), binding)
				alts = append(alts, alt)
				continue
			}
			arrive := now + r.TransitTicks
			after := project(f, s, p.FuelType, arrivals[seriesKey{s.ID, p.FuelType}], map[int]float64{arrive: q}, o.Horizon, o.Runs, rng)
			rec = &Recommendation{
				StationID: s.ID, FuelType: p.FuelType, DepotID: r.SourceDepotID, RouteID: r.ID,
				Quantity: q, TransitTicks: r.TransitTicks, ArrivalTick: arrive,
				RiskBefore: p.StockoutProb, RiskAfter: after.StockoutProb, TimeToStockout: p.TimeToStockout,
				Binding: binding,
				Signals: map[string]any{
					"on_hand": p.OnHand, "in_transit": p.InTransit, "capacity": p.Capacity,
					"reorder_point": math.Round(reorder), "demand_next_horizon": math.Round(p.DemandHorizon),
					"demand_multiplier": s.DemandMultiplier, "horizon_ticks": o.Horizon,
				},
			}
			depotInv[r.SourceDepotID][p.FuelType] -= q
			dispatchLeft[r.SourceDepotID] -= q
		}
		if rec == nil {
			continue
		}
		rec.Alternatives = alts
		rec.ReviewReasons = reviewReasons(w, *rec, stale, o)
		for _, a := range alts {
			if a.TransitTicks < rec.TransitTicks && strings.HasPrefix(a.Rejected, "route disrupted") {
				rec.ReviewReasons = append(rec.ReviewReasons, "rerouted around disrupted "+a.RouteID)
			}
		}
		rec.ReviewRequired = len(rec.ReviewReasons) > 0
		plan.Recommendations = append(plan.Recommendations, *rec)
	}
	return plan
}

// urgency orders series: soonest expected stockout first, then highest probability, then lowest cover.
func urgency(p Projection) float64 {
	t := float64(p.TimeToStockout)
	if p.TimeToStockout < 0 {
		t = 1e6
	}
	cover := 0.0
	if p.DemandHorizon > 0 {
		cover = p.Position() / p.DemandHorizon
	}
	return t*1e3 - p.StockoutProb*1e2 + cover
}

// routesTo lists routes to a station, fastest first.
func routesTo(all []sim.Route, station string) []sim.Route {
	var out []sim.Route
	for _, r := range all {
		if r.DestinationStationID == station {
			out = append(out, r)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].TransitTicks < out[j].TransitTicks })
	return out
}

// isCaptiveOf reports whether depot is the ONLY source for station (Tongi<-Gazipur, Cox's Bazar<-Patiya).
func isCaptiveOf(all []sim.Route, station, depot string) bool {
	rs := routesTo(all, station)
	return len(rs) > 0 && func() bool {
		for _, r := range rs {
			if r.SourceDepotID != depot {
				return false
			}
		}
		return true
	}()
}

// captiveReserve is the depot fuel held back for stations that only that depot can serve:
// their expected shortfall over the horizon given current position.
func captiveReserve(w sim.World, f *Forecaster, proj map[seriesKey]Projection, o Options) map[seriesKey]float64 {
	out := map[seriesKey]float64{}
	for _, d := range w.Depots {
		for _, s := range w.Stations {
			if !isCaptiveOf(w.Routes, s.ID, d.ID) {
				continue
			}
			for _, fuel := range sim.FuelTypes {
				p := proj[seriesKey{s.ID, fuel}]
				out[seriesKey{d.ID, fuel}] += max(0, p.DemandHorizon-p.Position())
			}
		}
	}
	return out
}

// ReviewReasons is the deterministic hard-veto rule for any shipment, whichever policy proposed it.
func ReviewReasons(w sim.World, r Recommendation, o Options) []string {
	return reviewReasons(w, r, w.Stale, o)
}

// reviewReasons is the deterministic human-review rule (brief §11/§24). Jev may only relax the default
// "auto" path; these hard reasons always force review.
func reviewReasons(w sim.World, r Recommendation, stale bool, o Options) []string {
	var why []string
	if stale {
		why = append(why, "simulator data flagged stale")
	}
	if r.Quantity > o.ReviewQty {
		why = append(why, fmt.Sprintf("large shipment (%.0f L > %.0f L)", r.Quantity, o.ReviewQty))
	}
	region := ""
	for _, s := range w.Stations {
		if s.ID == r.StationID {
			region = s.RegionID
		}
	}
	for _, e := range w.Events {
		if e.Status == "RESOLVED" {
			continue
		}
		if contains(strParam(e.Parameters, "route_ids"), r.RouteID) ||
			contains(strParam(e.Parameters, "station_ids"), r.StationID) ||
			contains(strParam(e.Parameters, "depot_ids"), r.DepotID) ||
			(region != "" && contains(strParam(e.Parameters, "region_ids"), region)) {
			why = append(why, fmt.Sprintf("%s event %d affects this shipment", e.Type, e.ID))
		}
	}
	return why
}
