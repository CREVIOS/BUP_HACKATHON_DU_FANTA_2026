// Package replay drives a (dedicated, throwaway) simulator deterministically with /admin/step, executing
// a policy every tick, and reports decision quality: service level, failed allocations and overflow liters.
// It is the evaluation harness (docs/PLAN.md §9) and the CI regression gate. Never point it at a shared sim:
// it calls /admin/reset.
package replay

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/policy"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
)

type Config struct {
	Ticks      int
	Checkpoint []int  // report service level at these ticks
	Policy     string // "greedy" | "none"
	Events     string // "" | "final_combined" (inject that scenario's crisis events)
}

type Result struct {
	Policy        string          `json:"policy"`
	Events        string          `json:"events"`
	Ticks         int             `json:"ticks"`
	ServiceLevel  float64         `json:"service_level"`
	Checkpoints   map[int]float64 `json:"checkpoints"`
	Allocations   int             `json:"allocations"`
	Failed        int             `json:"failed_allocations"`
	OverflowL     float64         `json:"overflow_liters"`
	Cancelled     int             `json:"cancelled_doomed"`
	Rejected409   map[string]int  `json:"rejected_409"`
	UnmetLiters   float64         `json:"unmet_liters"`
	AllocatedL    float64         `json:"allocated_liters"`
	ServedLiters  float64         `json:"served_liters"`
	LastTickRisky int             `json:"series_at_risk_last_tick"`
}

// final_combined's preloaded events (scenarios/final_combined.yaml), injectable into the baseline world.
var finalCombined = []map[string]any{
	{"type": "demand_spike", "start_tick": 8, "duration_ticks": 16, "parameters": map[string]any{"region_ids": []string{"region-dhaka"}, "multiplier": 1.7}},
	{"type": "shipment_delay", "start_tick": 10, "duration_ticks": 1, "parameters": map[string]any{"depot_ids": []string{"depot-gazipur"}, "fuel_types": []string{"DIESEL", "PETROL"}, "delay_ticks": 8}},
	{"type": "route_disruption", "start_tick": 14, "duration_ticks": 10, "parameters": map[string]any{"route_ids": []string{"route-gazipur-mirpur"}}},
}

func Run(ctx context.Context, c *sim.Client, cfg Config) (Result, error) {
	res := Result{Policy: cfg.Policy, Events: cfg.Events, Ticks: cfg.Ticks, Checkpoints: map[int]float64{}, Rejected409: map[string]int{}}
	if _, err := c.PostJSON(ctx, "/admin/pause", nil, nil); err != nil {
		return res, err
	}
	if _, err := c.PostJSON(ctx, "/admin/reset", nil, nil); err != nil {
		return res, err
	}
	if _, err := c.PostJSON(ctx, "/admin/faults/clear", nil, nil); err != nil {
		return res, err
	}
	if cfg.Events == "final_combined" {
		for _, e := range finalCombined {
			b, _ := json.Marshal(e)
			if _, err := c.PostJSON(ctx, "/admin/events", b, nil); err != nil {
				return res, fmt.Errorf("inject event: %w", err)
			}
		}
	}
	checkpoints := map[int]bool{}
	for _, t := range cfg.Checkpoint {
		checkpoints[t] = true
	}

	for tick := 0; tick < cfg.Ticks; tick++ {
		if cfg.Policy == "greedy" {
			w, err := c.FetchWorld(ctx)
			if err != nil {
				return res, fmt.Errorf("tick %d: %w", tick, err)
			}
			plan := policy.MakePlan(w, policy.DefaultOptions)
			res.LastTickRisky = 0
			for _, p := range plan.Risks {
				if p.StockoutProb > 0.2 {
					res.LastTickRisky++
				}
			}
			for _, a := range plan.Cancel {
				if _, err := c.PostJSON(ctx, fmt.Sprintf("/v1/allocations/%d/cancel", a.ID), nil, nil); err == nil {
					res.Cancelled++
				}
			}
			for _, r := range plan.Recommendations {
				body, _ := json.Marshal(map[string]any{
					"idempotency_key":        fmt.Sprintf("replay:%d:%s:%s:%s", tick, r.StationID, r.FuelType, r.RouteID),
					"source_depot_id":        r.DepotID,
					"destination_station_id": r.StationID,
					"route_id":               r.RouteID,
					"fuel_type":              r.FuelType,
					"quantity":               r.Quantity,
				})
				if _, err := c.PostJSON(ctx, "/v1/allocations", body, nil); err != nil {
					if apiErr, ok := err.(*sim.APIError); ok {
						res.Rejected409[apiErr.Code]++
						continue
					}
					return res, err
				}
				res.Allocations++
			}
		}
		if _, err := c.PostJSON(ctx, "/admin/step", nil, nil); err != nil {
			return res, fmt.Errorf("step %d: %w", tick, err)
		}
		if err := countOverflow(ctx, c, &res); err != nil {
			return res, err
		}
		if checkpoints[tick+1] {
			m, err := c.FetchMetrics(ctx)
			if err != nil {
				return res, err
			}
			res.Checkpoints[tick+1] = m.ServiceLevel
		}
	}
	m, err := c.FetchMetrics(ctx)
	if err != nil {
		return res, err
	}
	res.ServiceLevel, res.Failed = m.ServiceLevel, m.AllocationFailures
	res.UnmetLiters, res.ServedLiters, res.AllocatedL = m.UnmetDemandLiters, m.ServedDemandLiters, m.AllocationLiters
	return res, nil
}

// countOverflow reads this tick's allocation.arrived audit rows: received < quantity means fuel was destroyed.
func countOverflow(ctx context.Context, c *sim.Client, res *Result) error {
	var rows []struct {
		Action   string         `json:"action"`
		EntityID string         `json:"entity_id"`
		Meta     map[string]any `json:"metadata_json"`
	}
	if _, err := c.GetJSON(ctx, "/admin/audit?limit=100", &rows); err != nil {
		return err
	}
	var allocs []sim.Allocation
	qty := map[string]float64{}
	ticks := 0
	for _, r := range rows { // id-desc: this tick's simulation.tick row, its arrivals, then the previous tick
		if r.Action == "simulation.tick" {
			if ticks++; ticks > 1 {
				break
			}
			continue
		}
		if r.Action != "allocation.arrived" {
			continue
		}
		if len(allocs) == 0 {
			if _, err := c.GetJSON(ctx, "/v1/allocations", &allocs); err != nil {
				return err
			}
			for _, a := range allocs {
				qty[fmt.Sprint(a.ID)] = a.Quantity
			}
		}
		if recv, ok := r.Meta["received"].(float64); ok {
			res.OverflowL += max(0, qty[r.EntityID]-recv)
		}
	}
	return nil
}

func (r Result) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "policy=%s events=%q ticks=%d service_level=%.6f checkpoints=%v allocations=%d failed=%d overflow_L=%.1f cancelled=%d rejected=%v",
		r.Policy, r.Events, r.Ticks, r.ServiceLevel, r.Checkpoints, r.Allocations, r.Failed, r.OverflowL, r.Cancelled, r.Rejected409)
	return b.String()
}
