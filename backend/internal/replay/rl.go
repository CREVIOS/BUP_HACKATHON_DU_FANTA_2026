package replay

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/planner"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/rl"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
)

// RLConfig drives a THROWAWAY simulator with the trained RL policy end to end: live REST world → rl.Snapshot →
// shared planner → Go actor → POST the chosen plan's shipments → /admin/step. With Reference set, every tick is
// compared against the offline SB3 run of the same scenario (the exporter's parity-full.json).
type RLConfig struct {
	Ticks     int
	Policy    string // rl | rl-baseline (the planner's rule-based action)
	Scenario  string // label only; the simulator process must already be running this scenario
	Reference string // parity-full.json; empty = no comparison
	Case      string // rl/export_cases.py case.json: events to inject at reveal ticks + per-tick reference checksums
}

// caseFile is one exported held-out case (rl/export_cases.py).
type caseFile struct {
	ID     string `json:"id"`
	Family string `json:"family"`
	Inject []struct {
		At   int            `json:"at"`
		Body map[string]any `json:"body"`
	} `json:"inject"`
	Ticks []struct {
		A int     `json:"a"`
		M int     `json:"m"`
		S float64 `json:"s"`
		N float64 `json:"n"`
	} `json:"ticks"`
	Metrics struct {
		Served, Unmet, Requests, Lost float64
	} `json:"metrics"`
}

type RLTick struct {
	Tick        int     `json:"tick"`
	Action      int     `json:"action"`
	RefAction   int     `json:"ref_action"`
	MaxObsDiff  float64 `json:"max_obs_diff"`
	WorstFeat   int     `json:"worst_feature"`
	Shipments   int     `json:"shipments"`
	Rejected    int     `json:"rejected"`
	MaskMatches bool    `json:"mask_matches"`
}

type RLResult struct {
	Scenario       string   `json:"scenario"`
	Policy         string   `json:"policy"`
	Ticks          int      `json:"ticks"`
	Compared       int      `json:"compared"`
	ActionMatches  int      `json:"action_matches"`
	MaskMatches    int      `json:"mask_matches"`
	MaxObsDiff     float64  `json:"max_obs_diff"`
	FirstDiverged  *RLTick  `json:"first_diverged,omitempty"`
	Family         string   `json:"family,omitempty"`
	RefServed      float64  `json:"ref_served,omitempty"`
	RefUnmet       float64  `json:"ref_unmet,omitempty"`
	RefRequests    float64  `json:"ref_requests,omitempty"`
	ServedLiters   float64  `json:"served_liters"`
	Shipments      int      `json:"shipments_posted"`
	Rejected       int      `json:"shipments_rejected"`
	ServiceLevel   float64  `json:"service_level"`
	UnmetLiters    float64  `json:"unmet_liters"`
	Failures       int      `json:"allocation_failures"`
	ShipTicks      int      `json:"ticks_with_shipments"`
	ActionsHistory []RLTick `json:"-"`
}

// ObsTolerance is the per-feature difference allowed between the live and reference observation: the simulator
// and the offline world round inventories to 1e-3 L, which moves normalized features by ~1e-7.
const ObsTolerance = 1e-5

func RunRL(ctx context.Context, c *sim.Client, cfg RLConfig) (RLResult, error) {
	res := RLResult{Scenario: cfg.Scenario, Policy: cfg.Policy, Ticks: cfg.Ticks}
	actor, err := rl.LoadActor()
	if err != nil {
		return res, err
	}
	var ref []struct {
		Scenario string    `json:"scenario"`
		Obs      []float64 `json:"obs"`
		Mask     []bool    `json:"mask"`
		Action   int       `json:"action"`
	}
	if cfg.Reference != "" {
		raw, err := os.ReadFile(cfg.Reference)
		if err != nil {
			return res, err
		}
		var all []struct {
			Scenario string    `json:"scenario"`
			Obs      []float64 `json:"obs"`
			Mask     []bool    `json:"mask"`
			Action   int       `json:"action"`
		}
		if err := json.Unmarshal(raw, &all); err != nil {
			return res, err
		}
		for _, r := range all {
			if r.Scenario == cfg.Scenario {
				ref = append(ref, r)
			}
		}
		if len(ref) == 0 {
			return res, fmt.Errorf("reference has no rows for scenario %q", cfg.Scenario)
		}
	}
	var cs *caseFile
	if cfg.Case != "" {
		raw, err := os.ReadFile(cfg.Case)
		if err != nil {
			return res, err
		}
		cs = &caseFile{}
		if err := json.Unmarshal(raw, cs); err != nil {
			return res, err
		}
		res.Scenario, res.Family = cs.ID, cs.Family
		res.RefServed, res.RefUnmet, res.RefRequests = cs.Metrics.Served, cs.Metrics.Unmet, cs.Metrics.Requests
	}
	for _, p := range []string{"/admin/pause", "/admin/reset", "/admin/faults/clear"} {
		if _, err := c.PostOnce(ctx, p, nil, nil); err != nil {
			return res, err
		}
	}
	for tick := 0; tick < cfg.Ticks; tick++ {
		if cs != nil { // events hidden from the policy until their reveal tick
			for _, e := range cs.Inject {
				if e.At == tick {
					b, _ := json.Marshal(e.Body)
					if _, err := c.PostOnce(ctx, "/admin/events", b, nil); err != nil {
						return res, fmt.Errorf("inject at %d: %w", tick, err)
					}
				}
			}
		}
		w, err := c.FetchWorld(ctx)
		if err != nil {
			return res, fmt.Errorf("tick %d: %w", tick, err)
		}
		if w.Instance.Tick != tick {
			return res, fmt.Errorf("simulator at tick %d, expected %d", w.Instance.Tick, tick)
		}
		hist, err := c.FetchDemand(ctx, 12*9)
		if err != nil {
			return res, err
		}
		snap, h, resv, err := rl.Snapshot(w, 1, hist, nil)
		if err != nil {
			return res, fmt.Errorf("tick %d snapshot: %w", tick, err)
		}
		in, err := planner.Prepare(snap, h, resv)
		if err != nil {
			return res, fmt.Errorf("tick %d prepare: %w", tick, err)
		}
		plans, mask, err := planner.Candidates(in)
		if err != nil {
			return res, err
		}
		obs, err := planner.Features(in, plans, mask)
		if err != nil {
			return res, err
		}
		action, _, err := actor.Choose(obs, mask)
		if err != nil {
			return res, err
		}
		if cfg.Policy == "rl-baseline" {
			action = planner.Baseline(in, plans, mask, 8)
		}
		rec := RLTick{Tick: tick, Action: action, RefAction: -1, MaskMatches: true}
		if tick < len(ref) {
			r := ref[tick]
			rec.RefAction = r.Action
			for i := range obs {
				if d := math.Abs(obs[i] - r.Obs[i]); d > rec.MaxObsDiff {
					rec.MaxObsDiff, rec.WorstFeat = d, i
				}
			}
			for i := range mask {
				if mask[i] != r.Mask[i] {
					rec.MaskMatches = false
				}
			}
			res.Compared++
			if rec.MaskMatches {
				res.MaskMatches++
			}
			if action == r.Action {
				res.ActionMatches++
			}
			res.MaxObsDiff = math.Max(res.MaxObsDiff, rec.MaxObsDiff)
			if res.FirstDiverged == nil && (action != r.Action || !rec.MaskMatches || rec.MaxObsDiff > ObsTolerance) {
				cp := rec
				res.FirstDiverged = &cp
			}
		}
		if cs != nil && tick < len(cs.Ticks) {
			r := cs.Ticks[tick]
			rec.RefAction = r.A
			sum, abs := 0.0, 0.0
			for _, v := range obs {
				sum, abs = sum+v, abs+math.Abs(v)
			}
			rec.MaxObsDiff = math.Max(math.Abs(sum-r.S), math.Abs(abs-r.N))
			m := 0
			for i, v := range mask {
				if v {
					m |= 1 << i
				}
			}
			rec.MaskMatches = m == r.M
			res.Compared++
			if rec.MaskMatches {
				res.MaskMatches++
			}
			if action == r.A {
				res.ActionMatches++
			}
			res.MaxObsDiff = math.Max(res.MaxObsDiff, rec.MaxObsDiff)
			if res.FirstDiverged == nil && (action != r.A || !rec.MaskMatches || rec.MaxObsDiff > SumTolerance) {
				cp := rec
				res.FirstDiverged = &cp
			}
		}
		for n, s := range plans[action].Shipments {
			body, _ := json.Marshal(map[string]any{
				"idempotency_key":        fmt.Sprintf("rl-%s-%d-%d", cfg.Scenario, tick, n),
				"source_depot_id":        rl.Depots[s.Depot],
				"destination_station_id": rl.Stations[s.Station],
				"route_id":               rl.Routes[s.Route],
				"fuel_type":              rl.Fuels[s.Fuel],
				"quantity":               s.Quantity,
			})
			rec.Shipments++
			if _, err := c.PostJSON(ctx, "/v1/allocations", body, nil); err != nil {
				rec.Rejected++
			}
		}
		res.Shipments += rec.Shipments
		res.Rejected += rec.Rejected
		if rec.Shipments > 0 {
			res.ShipTicks++
		}
		res.ActionsHistory = append(res.ActionsHistory, rec)
		if _, err := c.PostOnce(ctx, "/admin/step", nil, nil); err != nil {
			return res, fmt.Errorf("step %d: %w", tick, err)
		}
	}
	m, err := c.FetchMetrics(ctx)
	if err != nil {
		return res, err
	}
	res.ServiceLevel, res.UnmetLiters, res.Failures = m.ServiceLevel, m.UnmetDemandLiters, m.AllocationFailures
	res.ServedLiters = m.ServedDemandLiters
	return res, nil
}

// SumTolerance bounds the difference of the 600-feature sums (600 × ~1e-7 rounding noise).
const SumTolerance = 1e-3

// CaseExact: every decision, mask and observation checksum identical to the SB3 reference, every shipment
// accepted, and the simulator's served/unmet liters and request count equal to the reference world's.
func (r RLResult) CaseExact() bool {
	return r.Compared == r.Ticks && r.ActionMatches == r.Compared && r.MaskMatches == r.Compared &&
		r.MaxObsDiff <= SumTolerance && r.Rejected == 0 && float64(r.Shipments) == r.RefRequests &&
		math.Abs(r.ServedLiters-r.RefServed) < 1 && math.Abs(r.UnmetLiters-r.RefUnmet) < 1
}

// Exact reports whether the live run reproduced the reference decision for decision.
func (r RLResult) Exact() bool {
	return r.Compared == r.Ticks && r.ActionMatches == r.Compared && r.MaskMatches == r.Compared &&
		r.MaxObsDiff <= ObsTolerance && r.Rejected == 0
}
