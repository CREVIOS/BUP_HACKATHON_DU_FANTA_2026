package rl

import (
	"fmt"
	"time"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/planner"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
)

// Fixed topology order of the planner contract (training/world.py). The model supports exactly this network.
var (
	Stations = []string{"station-mirpur", "station-tongi", "station-karnaphuli", "station-coxsbazar"}
	Depots   = []string{"depot-gazipur", "depot-patiya"}
	Fuels    = []string{"DIESEL", "PETROL", "OCTANE"}
	Routes   = []string{"route-gazipur-mirpur", "route-gazipur-tongi", "route-patiya-karnaphuli",
		"route-patiya-coxsbazar", "route-gazipur-karnaphuli", "route-patiya-mirpur"}
)

// Strategy names action a: 0 waits; 1–12 = coverage target (8/24/48 ticks) × planning mode.
func Strategy(a int) string {
	if a <= 0 || a >= actions {
		return "wait"
	}
	target := []string{"2h", "6h", "12h"}[(a-1)/4]
	mode := []string{"urgency", "captive-priority", "depot-headroom", "scarcity-aware"}[(a-1)%4]
	return target + " cover, " + mode
}

// Reservation is an allocation we approved but have not submitted yet (our outbox), so the planner does not
// plan the same fuel twice.
type Reservation struct {
	Key                                   string
	StationID, FuelType, RouteID, DepotID string
	Quantity                              float64
}

// Shipment is one planned allocation in simulator ids.
type Shipment struct {
	StationID string  `json:"station_id"`
	FuelType  string  `json:"fuel_type"`
	DepotID   string  `json:"depot_id"`
	RouteID   string  `json:"route_id"`
	Quantity  float64 `json:"quantity"`
}

// Decision is what the policy would do this tick, next to the planner's own rule-based baseline.
type Decision struct {
	Tick              int              `json:"tick"`
	Action            int              `json:"action"`
	Strategy          string           `json:"strategy"`
	Shipments         []Shipment       `json:"shipments"`
	BaselineAction    int              `json:"baseline_action"`
	BaselineStrategy  string           `json:"baseline_strategy"`
	BaselineShipments []Shipment       `json:"baseline_shipments"`
	Mask              [actions]bool    `json:"mask"`
	Logits            [actions]float32 `json:"logits"`
	Liters            float64          `json:"liters"`
	LatencyMicros     int64            `json:"latency_us"`
}

// Decide builds the planner input from the live world and chooses a plan. epoch must be > 0 (the planner refuses
// untrusted snapshots: stale data, unsupported clock). history is recent demand; the planner uses the last 8 ticks.
func (a *Actor) Decide(w sim.World, epoch int64, history []sim.DemandObservation, pending []Reservation) (Decision, error) {
	start := time.Now()
	snap, hist, res, err := Snapshot(w, epoch, history, pending)
	if err != nil {
		return Decision{}, err
	}
	in, err := planner.Prepare(snap, hist, res)
	if err != nil {
		return Decision{}, fmt.Errorf("planner: %w", err)
	}
	plans, mask, err := planner.Candidates(in)
	if err != nil {
		return Decision{}, fmt.Errorf("planner candidates: %w", err)
	}
	obs, err := planner.Features(in, plans, mask)
	if err != nil {
		return Decision{}, fmt.Errorf("planner features: %w", err)
	}
	action, logits, err := a.Choose(obs, mask)
	if err != nil {
		return Decision{}, err
	}
	base := planner.Baseline(in, plans, mask, 8)
	d := Decision{Tick: w.Instance.Tick, Action: action, Strategy: Strategy(action), Shipments: named(plans[action]),
		BaselineAction: base, BaselineStrategy: Strategy(base), BaselineShipments: named(plans[base]),
		Mask: mask, Logits: logits, Liters: plans[action].Summary.Liters}
	d.LatencyMicros = time.Since(start).Microseconds()
	return d, nil
}

func named(p planner.Plan) []Shipment {
	out := []Shipment{}
	for _, s := range p.Shipments {
		out = append(out, Shipment{StationID: Stations[s.Station], FuelType: Fuels[s.Fuel], DepotID: Depots[s.Depot],
			RouteID: Routes[s.Route], Quantity: s.Quantity})
	}
	return out
}

// Snapshot converts the live world to the planner contract. It rejects any topology the model was not trained on.
func Snapshot(w sim.World, epoch int64, history []sim.DemandObservation, pending []Reservation) (planner.Snapshot, []planner.DemandRow, []planner.Reservation, error) {
	var s planner.Snapshot
	st, dp, fu, rt := index(Stations), index(Depots), index(Fuels), index(Routes)
	if len(w.Stations) != len(Stations) || len(w.Depots) != len(Depots) || len(w.Routes) != len(Routes) {
		return s, nil, nil, fmt.Errorf("topology mismatch: the model supports exactly 4 stations, 2 depots, 6 routes")
	}
	t, err := sim.ParseSimTime(w.Instance.SimTime)
	if err != nil {
		return s, nil, nil, fmt.Errorf("sim_time: %w", err)
	}
	s.Epoch, s.Tick, s.Minute, s.TickMinutes, s.Stale = epoch, w.Instance.Tick, t.Hour()*60+t.Minute(), w.Instance.TickMinutes, w.Stale
	regionStations := map[string][]int{}
	for _, x := range w.Stations {
		i, ok := st[x.ID]
		if !ok {
			return s, nil, nil, fmt.Errorf("unknown station %q", x.ID)
		}
		regionStations[x.RegionID] = append(regionStations[x.RegionID], i)
		s.StationOpen[i], s.Multiplier[i] = x.Status == "OPEN", x.DemandMultiplier
		for f, name := range Fuels {
			s.Stock[i][f], s.Capacity[i][f] = x.Inventory[name], x.Capacity[name]
		}
	}
	for _, x := range w.Depots {
		i, ok := dp[x.ID]
		if !ok {
			return s, nil, nil, fmt.Errorf("unknown depot %q", x.ID)
		}
		// CONSTRAINED is a label in the simulator: it still accepts allocations.
		s.DepotOpen[i], s.Dispatch[i] = x.Status == "OPEN" || x.Status == "CONSTRAINED", x.DispatchCapacityPerTick
		for f, name := range Fuels {
			s.Depot[i][f], s.DepotCapacity[i][f] = x.Inventory[name], x.Capacity[name]
		}
	}
	for _, x := range w.Routes {
		i, ok := rt[x.ID]
		if !ok || planner.Source[i] != dp[x.SourceDepotID] || planner.Destination[i] != st[x.DestinationStationID] {
			return s, nil, nil, fmt.Errorf("unknown or re-wired route %q", x.ID)
		}
		s.RouteOpen[i] = x.Status == "AVAILABLE"
	}
	for _, a := range w.Allocations {
		if a.Status != "PENDING" && a.Status != "IN_TRANSIT" {
			continue
		}
		eta := 0
		if a.ExpectedArrivalTick != nil {
			eta = *a.ExpectedArrivalTick
		}
		s.Allocations = append(s.Allocations, planner.Allocation{Key: a.IdempotencyKey, Depot: dp[a.SourceDepotID],
			Station: st[a.DestinationStationID], Route: rt[a.RouteID], Fuel: fu[a.FuelType], Quantity: a.Quantity,
			Created: a.CreatedTick, ETA: eta, Status: a.Status})
	}
	for _, x := range w.Supply {
		s.Supplies = append(s.Supplies, planner.Supply{Depot: dp[x.DepotID], Fuel: fu[x.FuelType], Tick: x.PlannedTick, Quantity: x.Quantity, Status: x.Status})
	}
	for _, e := range w.Events {
		ev := planner.Event{Kind: e.Type, Start: e.StartTick, End: e.EndTick, Status: e.Status,
			Routes: ids(e.Parameters["route_ids"], rt), Depots: ids(e.Parameters["depot_ids"], dp), Fuels: ids(e.Parameters["fuel_types"], fu),
			Stations: ids(e.Parameters["station_ids"], st), Multiplier: num(e.Parameters, "multiplier", 1.5),
			Factor: num(e.Parameters, "factor", 0.5), Delay: int(num(e.Parameters, "delay_ticks", 2))}
		// A region-scoped spike reaches every station of the region; the planner only knows stations.
		for _, r := range strs(e.Parameters["region_ids"]) {
			ev.Stations = append(ev.Stations, regionStations[r]...)
		}
		s.Events = append(s.Events, ev)
	}
	var hist []planner.DemandRow
	for _, h := range history {
		i, ok1 := st[h.StationID]
		f, ok2 := fu[h.FuelType]
		if ok1 && ok2 {
			hist = append(hist, planner.DemandRow{Station: i, Fuel: f, Tick: h.Tick, Demand: h.DemandLiters, Served: h.ServedLiters, Unmet: h.UnmetLiters})
		}
	}
	var res []planner.Reservation
	for _, r := range pending {
		res = append(res, planner.Reservation{Key: r.Key, Epoch: epoch, Depot: dp[r.DepotID], Station: st[r.StationID],
			Route: rt[r.RouteID], Fuel: fu[r.FuelType], Quantity: r.Quantity})
	}
	return s, hist, res, nil
}

func index(xs []string) map[string]int {
	m := map[string]int{}
	for i, x := range xs {
		m[x] = i
	}
	return m
}

func strs(v any) []string {
	raw, _ := v.([]any)
	var out []string
	for _, x := range raw {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func ids(v any, m map[string]int) []int {
	var out []int
	for _, s := range strs(v) {
		if i, ok := m[s]; ok {
			out = append(out, i)
		}
	}
	return out
}

func num(p map[string]any, k string, def float64) float64 {
	if v, ok := p[k].(float64); ok {
		return v
	}
	return def
}
