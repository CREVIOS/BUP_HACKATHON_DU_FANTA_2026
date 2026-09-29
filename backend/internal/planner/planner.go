// Package planner owns the fixed BUP topology and shared train/serve action contract.
package planner

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
)

const SchemaVersion = 1

var Source = [6]int{0, 0, 1, 1, 0, 1}
var Destination = [6]int{0, 1, 2, 3, 2, 0}
var Lead = [6]int{2, 2, 2, 3, 4, 4}
var MaxShipment = [6]float64{7000, 6500, 7000, 6000, 5000, 5000}
var Daily = [4][3]float64{{8500, 10500, 5600}, {14000, 4500, 2200}, {10500, 11000, 6200}, {7200, 7600, 3600}}
var Region = [4]float64{1, 1, 1.08, 1.08}

type Allocation struct {
	Key                         string
	Depot, Station, Route, Fuel int
	Quantity                    float64
	Created, ETA                int
	Status                      string
}
type Reservation struct {
	Key                         string
	Epoch                       int64
	Depot, Station, Route, Fuel int
	Quantity                    float64
}
type Event struct {
	Kind                            string
	Start, End                      int
	Status                          string
	Stations, Routes, Depots, Fuels []int
	Multiplier, Factor              float64
	Delay                           int
}
type Supply struct {
	Depot, Fuel, Tick int
	Quantity          float64
	Status            string
}
type DemandRow struct {
	Station, Fuel, Tick   int
	Demand, Served, Unmet float64
}
type Snapshot struct {
	Epoch                     int64
	Tick, Minute, TickMinutes int
	Stale                     bool
	Stock, Capacity           [4][3]float64
	Depot, DepotCapacity      [2][3]float64
	Dispatch                  [2]float64
	StationOpen               [4]bool
	DepotOpen                 [2]bool
	RouteOpen                 [6]bool
	Multiplier                [4]float64
	Allocations               []Allocation
	Supplies                  []Supply
	Events                    []Event
}
type Input struct {
	Snapshot
	Inbound      [4][3]float64
	Available    [2][3]float64
	DispatchLeft [2]float64
	Blocked      [6]bool
	Forecast     [4][3][48]float64
	History      [4][3][2]float64
}
type Shipment struct {
	Depot, Station, Route, Fuel int
	Quantity                    float64
}
type PlanSummary struct{ Liters, Requests, LiterTransit float64 }
type Plan struct {
	ActionID  int
	Shipments []Shipment
	Summary   PlanSummary
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func validOrder(d, s, r, f int, q float64) bool {
	return d >= 0 && d < 2 && s >= 0 && s < 4 && r >= 0 && r < 6 && f >= 0 && f < 3 && finite(q) && q > 0 && Source[r] == d && Destination[r] == s
}
func includes(ids []int, v int) bool {
	for _, i := range ids {
		if i == v {
			return true
		}
	}
	return false
}
func eventStation(e Event, s int) bool { return len(e.Stations) == 0 || includes(e.Stations, s) }

func Prepare(s Snapshot, history []DemandRow, pending []Reservation) (Input, error) {
	in := Input{Snapshot: s, Available: s.Depot, DispatchLeft: s.Dispatch}
	if s.Stale || s.Epoch <= 0 || s.Tick < 0 || s.TickMinutes != 15 || s.Minute < 0 || s.Minute >= 1440 {
		return in, errors.New("untrusted snapshot or unsupported clock")
	}
	for i := range 4 {
		if !finite(s.Multiplier[i]) || s.Multiplier[i] <= 0 {
			return in, errors.New("invalid demand multiplier")
		}
		for f := range 3 {
			if !finite(s.Stock[i][f]) || !finite(s.Capacity[i][f]) || s.Stock[i][f] < 0 || s.Capacity[i][f] <= 0 || s.Stock[i][f] > s.Capacity[i][f] {
				return in, errors.New("invalid station inventory")
			}
		}
	}
	for d := range 2 {
		if !finite(s.Dispatch[d]) || s.Dispatch[d] <= 0 {
			return in, errors.New("invalid dispatch")
		}
		for f := range 3 {
			if !finite(s.Depot[d][f]) || !finite(s.DepotCapacity[d][f]) || s.Depot[d][f] < 0 || s.DepotCapacity[d][f] <= 0 || s.Depot[d][f] > s.DepotCapacity[d][f] {
				return in, errors.New("invalid depot inventory")
			}
		}
	}
	known := map[string]Allocation{}
	for _, a := range s.Allocations {
		if a.Key == "" || !validOrder(a.Depot, a.Station, a.Route, a.Fuel, a.Quantity) {
			return in, errors.New("invalid allocation")
		}
		if old, ok := known[a.Key]; ok {
			if old != a {
				return in, errors.New("conflicting allocation key")
			}
			continue
		}
		known[a.Key] = a
		switch a.Status {
		case "PENDING", "IN_TRANSIT":
			in.Inbound[a.Station][a.Fuel] += a.Quantity
			if a.Created == s.Tick {
				in.DispatchLeft[a.Depot] -= a.Quantity
			}
		case "ARRIVED", "CANCELLED", "FAILED":
		default:
			return in, errors.New("unknown allocation status")
		}
	}
	reservations := map[string]Reservation{}
	for _, r := range pending {
		if r.Epoch != s.Epoch || r.Key == "" || !validOrder(r.Depot, r.Station, r.Route, r.Fuel, r.Quantity) {
			return in, errors.New("invalid reservation")
		}
		if old, ok := reservations[r.Key]; ok {
			if old != r {
				return in, errors.New("conflicting reservation key")
			}
			continue
		}
		reservations[r.Key] = r
		if a, ok := known[r.Key]; ok {
			if a.Depot != r.Depot || a.Station != r.Station || a.Route != r.Route || a.Fuel != r.Fuel || a.Quantity != r.Quantity {
				return in, errors.New("reservation differs from accepted body")
			}
			continue
		}
		in.Available[r.Depot][r.Fuel] -= r.Quantity
		in.DispatchLeft[r.Depot] -= r.Quantity
		in.Inbound[r.Station][r.Fuel] += r.Quantity
	}
	for r := range 6 {
		in.Blocked[r] = !s.RouteOpen[r]
	}
	for _, e := range s.Events {
		if e.End < e.Start || e.Start < 0 || !finite(e.Multiplier) || !finite(e.Factor) {
			return in, errors.New("invalid event")
		}
		for _, i := range e.Stations {
			if i < 0 || i >= 4 {
				return in, errors.New("invalid event station")
			}
		}
		for _, i := range e.Routes {
			if i < 0 || i >= 6 {
				return in, errors.New("invalid event route")
			}
		}
		if e.Kind == "demand_spike" && e.Multiplier <= 0 {
			return in, errors.New("invalid event multiplier")
		}
		if e.Kind == "route_disruption" && e.Status != "RESOLVED" && e.Start <= s.Tick && s.Tick <= e.End {
			for _, r := range e.Routes {
				in.Blocked[r] = true
			}
		}
	}
	for _, a := range s.Supplies {
		if a.Depot < 0 || a.Depot >= 2 || a.Fuel < 0 || a.Fuel >= 3 || a.Tick < 0 || !finite(a.Quantity) || a.Quantity < 0 {
			return in, errors.New("invalid supply")
		}
	}
	for d := range 2 {
		if in.DispatchLeft[d] < -0.001 {
			return in, errors.New("overreserved dispatch")
		}
		for f := range 3 {
			if in.Available[d][f] < -0.001 {
				return in, errors.New("overreserved depot")
			}
		}
	}
	var sums [4][3][3]float64
	for _, h := range history {
		if h.Station < 0 || h.Station >= 4 || h.Fuel < 0 || h.Fuel >= 3 || !finite(h.Demand) || !finite(h.Unmet) || h.Demand < 0 || h.Unmet < 0 {
			return in, errors.New("invalid demand history")
		}
		if h.Tick >= s.Tick || h.Tick < s.Tick-8 {
			continue
		}
		sums[h.Station][h.Fuel][0] += h.Demand
		sums[h.Station][h.Fuel][1] += h.Unmet
		sums[h.Station][h.Fuel][2]++
	}
	for i := range 4 {
		for f := range 3 {
			if sums[i][f][2] > 0 {
				in.History[i][f][0] = sums[i][f][0] / sums[i][f][2]
				in.History[i][f][1] = sums[i][f][1]
			}
			for k := range 48 {
				mult := s.Multiplier[i]
				tick := s.Tick + k
				for _, e := range s.Events {
					if e.Kind != "demand_spike" || !eventStation(e, i) {
						continue
					}
					if e.Status == "SCHEDULED" && e.Start <= tick && tick <= e.End {
						mult *= e.Multiplier
					}
					if e.Status == "ACTIVE" && tick > e.End {
						mult /= e.Multiplier
					}
				}
				in.Forecast[i][f][k] = Daily[i][f] / 96 * Region[i] * HourFactor((s.Minute+k*15)%1440/60, i) * mult
			}
		}
	}
	return in, nil
}

func HourFactor(hour, station int) float64 {
	switch station {
	case 1:
		if hour >= 6 && hour < 18 {
			return 1.55
		}
		return .45
	case 2:
		if (hour >= 6 && hour < 10) || (hour >= 16 && hour < 21) {
			return 1.35
		}
		return .75
	case 0:
		if (hour >= 7 && hour < 10) || (hour >= 16 && hour < 21) {
			return 1.45
		}
		return .70
	default:
		if hour >= 7 && hour < 21 {
			return 1.25
		}
		return .65
	}
}
func demand(in Input, s, f, h int) float64 {
	q := 0.
	for k := 0; k < h; k++ {
		q += in.Forecast[s][f][k]
	}
	return q
}
func cover(in Input, s, f int) float64 {
	return (in.Stock[s][f] + in.Inbound[s][f]) / math.Max(demand(in, s, f, 8)/8, 1e-6)
}
func reserve(in Input, d, f, h int) float64 {
	s := 1
	if d == 1 {
		s = 3
	}
	return math.Max(0, 1.1*demand(in, s, f, h)-in.Stock[s][f]-in.Inbound[s][f])
}
func excess(in Input, d, f int) float64 {
	q := in.Depot[d][f] - in.DepotCapacity[d][f]
	for _, a := range in.Supplies {
		if a.Depot == d && a.Fuel == f && a.Status != "ARRIVED" && a.Tick <= in.Tick+24 {
			q += a.Quantity
		}
	}
	return math.Max(0, q)
}

func Candidates(in Input) ([13]Plan, [13]bool, error) {
	var plans [13]Plan
	var mask [13]bool
	seen := map[string]bool{"null": true}
	mask[0] = true
	for action := 1; action < 13; action++ {
		h := [3]int{8, 24, 48}[(action-1)/4]
		mode := (action - 1) % 4
		p := Plan{ActionID: action}
		avail := in.Available
		dispatch := in.DispatchLeft
		// The official API compares float sums strictly; reserve one milliliter
		// so SQL SUM rounding cannot reject a nominally full-capacity batch.
		for d := range 2 {
			dispatch[d] = math.Max(0, dispatch[d]-.001)
		}
		pairs := make([][2]int, 0, 12)
		for s := range 4 {
			for f := range 3 {
				pairs = append(pairs, [2]int{s, f})
			}
		}
		priority := func(pair [2]int) float64 {
			s, f := pair[0], pair[1]
			v := cover(in, s, f)
			if mode == 1 && (s == 1 || s == 3) {
				v -= 96
			}
			if mode == 2 {
				for r := range 6 {
					if Destination[r] == s && !in.Blocked[r] {
						v -= excess(in, Source[r], f) / 1000
					}
				}
			}
			return v
		}
		sort.SliceStable(pairs, func(i, j int) bool { return priority(pairs[i]) < priority(pairs[j]) })
		for _, pair := range pairs {
			s, f := pair[0], pair[1]
			if !in.StationOpen[s] {
				continue
			}
			wanted := math.Max(0, 1.1*demand(in, s, f, h)-in.Stock[s][f]-in.Inbound[s][f])
			room := math.Max(0, in.Capacity[s][f]-in.Stock[s][f]-in.Inbound[s][f])
			best := -1
			bestScore := math.Inf(1)
			quantity := 0.
			for r := range 6 {
				d := Source[r]
				if Destination[r] != s || in.Blocked[r] || !in.DepotOpen[d] {
					continue
				}
				available := avail[d][f]
				if (mode == 1 || mode == 3) && s != 1 && s != 3 {
					available = math.Max(0, available-reserve(in, d, f, h))
				}
				q := math.Floor(math.Min(wanted, math.Min(room, math.Min(MaxShipment[r], math.Min(available, dispatch[d]))))*1000+1e-7) / 1000
				if q <= 0 {
					continue
				}
				score := float64(Lead[r])
				if mode == 2 {
					score -= excess(in, d, f) / 1000
				}
				if mode == 3 {
					need := 0.
					for si := range 4 {
						for rr := range 6 {
							if Source[rr] == d && Destination[rr] == si {
								need += demand(in, si, f, 24)
								break
							}
						}
					}
					score -= 48 * available / math.Max(need, 1)
				}
				if score < bestScore {
					best = r
					bestScore = score
					quantity = q
				}
			}
			if best >= 0 {
				d := Source[best]
				a := Shipment{d, s, best, f, quantity}
				p.Shipments = append(p.Shipments, a)
				avail[d][f] -= quantity
				dispatch[d] -= quantity
				p.Summary.Liters += quantity
				p.Summary.Requests++
				p.Summary.LiterTransit += quantity * float64(Lead[best])
			}
		}
		if err := Validate(in, p); err != nil {
			return plans, mask, err
		}
		plans[action] = p
		raw, _ := json.Marshal(p.Shipments)
		key := string(raw)
		if !seen[key] {
			mask[action] = true
			seen[key] = true
		}
	}
	return plans, mask, nil
}

func Validate(in Input, p Plan) error {
	if p.ActionID < 0 || p.ActionID >= 13 || len(p.Shipments) > 12 {
		return errors.New("invalid plan")
	}
	avail, dispatch, room := in.Available, in.DispatchLeft, in.Capacity
	for s := range 4 {
		for f := range 3 {
			room[s][f] -= in.Stock[s][f] + in.Inbound[s][f]
		}
	}
	seen := map[[2]int]bool{}
	for _, a := range p.Shipments {
		if !validOrder(a.Depot, a.Station, a.Route, a.Fuel, a.Quantity) {
			return errors.New("invalid shipment")
		}
		d, s, r, f, q := a.Depot, a.Station, a.Route, a.Fuel, a.Quantity
		k := [2]int{s, f}
		if seen[k] || in.Blocked[r] || !in.StationOpen[s] || !in.DepotOpen[d] || q > MaxShipment[r]+1e-7 || q > avail[d][f]+1e-7 || q > dispatch[d]+1e-7 || q > room[s][f]+1e-7 || math.Abs(q*1000-math.Round(q*1000)) > 1e-5 {
			return fmt.Errorf("infeasible shipment %+v", a)
		}
		seen[k] = true
		avail[d][f] -= q
		dispatch[d] -= q
		room[s][f] -= q
	}
	return nil
}

func Features(in Input, plans [13]Plan, mask [13]bool) ([]float64, error) {
	x := make([]float64, 0, 700)
	add := func(v float64) { x = append(x, math.Max(-10, math.Min(10, v))) }
	flag := func(v bool) {
		if v {
			add(1)
		} else {
			add(0)
		}
	}
	add(math.Sin(float64(in.Minute) * 2 * math.Pi / 1440))
	add(math.Cos(float64(in.Minute) * 2 * math.Pi / 1440))
	for s := range 4 {
		flag(in.StationOpen[s])
		add(in.Multiplier[s] / 3)
		for f := range 3 {
			c := in.Capacity[s][f]
			add(in.Stock[s][f] / c)
			add(in.Inbound[s][f] / c)
			add(cover(in, s, f) / 96)
			for _, h := range []int{4, 8, 24, 48} {
				add(demand(in, s, f, h) / c)
			}
			add(in.History[s][f][0] / (Daily[s][f] / 96))
			add(in.History[s][f][1] / c)
			for _, h := range []int{1, 2, 4, 8} {
				q := 0.
				for _, a := range in.Allocations {
					if a.Station == s && a.Fuel == f && (a.Status == "PENDING" || a.Status == "IN_TRANSIT") {
						eta := a.ETA
						if a.Status == "PENDING" {
							eta = in.Tick + Lead[a.Route]
						}
						if eta <= in.Tick+h {
							q += a.Quantity
						}
					}
				}
				add(q / c)
			}
		}
	}
	for d := range 2 {
		flag(in.DepotOpen[d])
		add(in.DispatchLeft[d] / in.Dispatch[d])
		for f := range 3 {
			c := in.DepotCapacity[d][f]
			add(in.Available[d][f] / c)
			add((c - in.Depot[d][f]) / c)
			add(reserve(in, d, f, 24) / c)
			for _, h := range []int{4, 8, 24, 48, 96} {
				q := 0.
				for _, a := range in.Supplies {
					if a.Depot == d && a.Fuel == f && a.Status != "ARRIVED" && a.Tick <= in.Tick+h {
						q += a.Quantity
					}
				}
				add(q / c)
			}
		}
	}
	for r := range 6 {
		flag(!in.Blocked[r])
		start, end := 96., 96.
		for _, e := range in.Events {
			if e.Kind == "route_disruption" && e.Status != "RESOLVED" && includes(e.Routes, r) && float64(e.Start-in.Tick) < start {
				start = float64(e.Start - in.Tick)
				end = float64(e.End - in.Tick)
			}
		}
		add(start / 96)
		add(end / 96)
	}
	for i, p := range plans {
		flag(mask[i])
		add(p.Summary.Liters / 23000)
		add(p.Summary.Requests / 12)
		add(p.Summary.LiterTransit / 92000)
		var qty [4][3]float64
		var routes [4][3]float64
		for _, a := range p.Shipments {
			qty[a.Station][a.Fuel] = a.Quantity
			routes[a.Station][a.Fuel] = float64(a.Route+1) / 6
		}
		for s := range 4 {
			for f := range 3 {
				add(qty[s][f] / in.Capacity[s][f])
				add(routes[s][f])
			}
		}
	}
	for _, v := range x {
		if !finite(v) {
			return nil, errors.New("nonfinite feature")
		}
	}
	return x, nil
}

// Baseline uses reorder hysteresis and the same public lookahead as RL.
func Baseline(in Input, plans [13]Plan, mask [13]bool, reorder float64) int {
	need, headroom, scarce := false, false, false
	for s := range 4 {
		for f := range 3 {
			if in.StationOpen[s] && cover(in, s, f) <= reorder {
				need = true
			}
		}
	}
	for _, e := range in.Events {
		if e.Kind != "route_disruption" || e.Status != "SCHEDULED" || e.Start > in.Tick+8 || e.End < in.Tick {
			continue
		}
		for _, r := range e.Routes {
			s := Destination[r]
			for f := range 3 {
				if cover(in, s, f) < float64(e.End-in.Tick+Lead[r]+2) {
					need = true
				}
			}
		}
	}
	for d := range 2 {
		for f := range 3 {
			if excess(in, d, f) > 0 {
				headroom = true
			}
			if in.Available[d][f] < 2*reserve(in, d, f, 48) {
				scarce = true
			}
		}
	}
	if !need && !headroom {
		return 0
	}
	preferred := 9
	if scarce {
		preferred = 10
	}
	if headroom {
		preferred = 11
	}
	for _, a := range []int{preferred, 10, 9, 12, 11, 6, 5, 8, 7, 2, 1, 4, 3} {
		if mask[a] {
			return a
		}
	}
	return 0
}
