package ingestor

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/intel"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/rl"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	rlDecisions = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "rl_shadow_decisions_total", Help: "RL shadow decisions by kind (wait|ship) and agreement with the planner baseline (same|different).",
	}, []string{"kind", "baseline"})
	rlErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "rl_shadow_errors_total", Help: "Ticks the RL policy could not evaluate (untrusted snapshot, topology, ...).",
	})
	rlLatency = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "rl_shadow_inference_seconds", Help: "Planner + actor time per RL shadow decision.",
		Buckets: []float64{.0005, .001, .0025, .005, .01, .025, .05},
	})
)

// shadowRL records, every decided tick, the RL policy's plan next to the planner's rule baseline and greedy's
// plan. This log is the side-by-side comparison (brief §8), whichever policy is active; it submits nothing.
func (i *ingestor) shadowRL(ctx context.Context, w sim.World, resp intel.PlanResponse) {
	if i.actor == nil {
		return
	}
	rows, err := i.db.Query(ctx, `SELECT station_id, fuel_type, tick, demand_liters, served_liters, unmet_liters
		FROM demand_observations WHERE epoch_id = $1 AND tick >= $2`, i.epochID, w.Instance.Tick-8)
	if err != nil {
		slog.WarnContext(ctx, "rl shadow: history", "err", err)
		return
	}
	history, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (sim.DemandObservation, error) {
		var o sim.DemandObservation
		return o, r.Scan(&o.StationID, &o.FuelType, &o.Tick, &o.DemandLiters, &o.ServedLiters, &o.UnmetLiters)
	})
	if err != nil {
		slog.WarnContext(ctx, "rl shadow: history", "err", err)
		return
	}
	pending, err := i.reservations(ctx)
	if err != nil {
		slog.WarnContext(ctx, "rl shadow: reservations", "err", err)
		return
	}
	greedy := []map[string]any{}
	for _, r := range resp.Greedy { // the heuristic's plan this tick, whichever policy is active
		greedy = append(greedy, map[string]any{"station_id": r.StationID, "fuel_type": r.FuelType, "route_id": r.RouteID,
			"depot_id": r.DepotID, "quantity": r.Quantity, "review_required": r.ReviewRequired})
	}
	g, _ := json.Marshal(greedy)
	d, derr := i.actor.Decide(w, i.epochID, history, pending)
	if derr != nil {
		rlErrors.Inc()
		_, err = i.db.Exec(ctx, `INSERT INTO rl_shadow (epoch_id, tick, greedy, error) VALUES ($1,$2,$3,$4)
			ON CONFLICT (epoch_id, tick) DO UPDATE SET greedy = EXCLUDED.greedy, error = EXCLUDED.error`,
			i.epochID, w.Instance.Tick, g, derr.Error())
		if err != nil {
			slog.WarnContext(ctx, "rl shadow: store", "err", err)
		}
		return
	}
	rlLatency.Observe(float64(d.LatencyMicros) / 1e6)
	kind, agree := "wait", "same"
	if d.Action != 0 {
		kind = "ship"
	}
	if d.Action != d.BaselineAction {
		agree = "different"
	}
	rlDecisions.WithLabelValues(kind, agree).Inc()
	ship, _ := json.Marshal(d.Shipments)
	base, _ := json.Marshal(d.BaselineShipments)
	mask, _ := json.Marshal(d.Mask)
	logits, _ := json.Marshal(d.Logits)
	if _, err := i.db.Exec(ctx, `INSERT INTO rl_shadow (epoch_id, tick, action, strategy, baseline_action, baseline_strategy,
			shipments, baseline_shipments, greedy, mask, logits, latency_us)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		ON CONFLICT (epoch_id, tick) DO UPDATE SET action = EXCLUDED.action, strategy = EXCLUDED.strategy,
			baseline_action = EXCLUDED.baseline_action, baseline_strategy = EXCLUDED.baseline_strategy,
			shipments = EXCLUDED.shipments, baseline_shipments = EXCLUDED.baseline_shipments, greedy = EXCLUDED.greedy,
			mask = EXCLUDED.mask, logits = EXCLUDED.logits, latency_us = EXCLUDED.latency_us, error = NULL`,
		i.epochID, w.Instance.Tick, d.Action, d.Strategy, d.BaselineAction, d.BaselineStrategy, ship, base, g, mask, logits, d.LatencyMicros); err != nil {
		slog.WarnContext(ctx, "rl shadow: store", "err", err)
	}
}

// reservations are our approved allocations not yet accepted by the simulator (outbox PENDING), so the policy
// does not plan fuel we have already committed.
func (i *ingestor) reservations(ctx context.Context) ([]rl.Reservation, error) {
	rows, err := i.db.Query(ctx, `SELECT o.body FROM outbox o JOIN recommendations r ON r.id = o.recommendation_id
		WHERE o.status = 'PENDING' AND r.epoch_id = $1`, i.epochID)
	if err != nil {
		return nil, err
	}
	bodies, err := pgx.CollectRows(rows, pgx.RowTo[[]byte])
	if err != nil {
		return nil, err
	}
	var out []rl.Reservation
	for _, b := range bodies {
		var a store.AllocationRequest
		if json.Unmarshal(b, &a) == nil {
			out = append(out, rl.Reservation{Key: a.IdempotencyKey, StationID: a.DestinationStationID, FuelType: a.FuelType,
				RouteID: a.RouteID, DepotID: a.SourceDepotID, Quantity: a.Quantity})
		}
	}
	return out, nil
}
