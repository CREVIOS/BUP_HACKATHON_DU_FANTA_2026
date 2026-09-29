package ingestor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/intel"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/obs"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/policy"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	decisionsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "decisions_total", Help: "Recommendations produced, by source (intel|fallback) and verdict (auto|review).",
	}, []string{"source", "verdict"})
	fallbackTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "decision_fallback_total", Help: "Ticks decided by the in-process fallback because intel was unavailable.",
	})
	reviewQueue = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "review_queue_depth", Help: "Recommendations waiting for a human decision.",
	})
	stockoutRisk = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "stockout_probability", Help: "P(stockout within 12 h) per station and fuel.",
	}, []string{"station", "fuel"})
	cancelledDoomed = promauto.NewCounter(prometheus.CounterOpts{
		Name: "allocations_cancelled_to_prevent_loss_total", Help: "PENDING allocations cancelled because their route is disrupted at departure.",
	})
	forecastMAPE = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "forecast_mape", Help: "Mean absolute % error of next-tick demand over the last 96 ticks, by model (forecast|naive).",
	}, []string{"model"})
)

// decide runs the decision pipeline for the current tick and persists its outcome.
func (i *ingestor) decide(ctx context.Context, w sim.World) error {
	now := w.Instance.Tick
	var autoExec bool
	var threshold float64
	if err := i.db.QueryRow(ctx, `SELECT auto_execute, jev_threshold FROM settings WHERE id = 1`).Scan(&autoExec, &threshold); err != nil {
		return fmt.Errorf("settings: %w", err)
	}
	rows, err := i.db.Query(ctx, `SELECT station_id, fuel_type, tick, demand_liters FROM demand_observations
		WHERE epoch_id = $1 AND tick >= $2`, i.epochID, now-policy.DetectWindow)
	if err != nil {
		return err
	}
	recent, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (sim.DemandObservation, error) {
		var o sim.DemandObservation
		return o, r.Scan(&o.StationID, &o.FuelType, &o.Tick, &o.DemandLiters)
	})
	if err != nil {
		return err
	}

	req := intel.PlanRequest{World: w, Demand: recent, JevThreshold: threshold}
	resp, intelErr := i.callIntel(ctx, req)
	i.fellBack, i.decidedAt = intelErr != nil, time.Now()
	if intelErr != nil {
		// Decision engine unavailable -> identical policy in-process, fixed review rule, no Jev (brief §11).
		resp = intel.Evaluate(ctx, req, nil, "fallback")
		fallbackTotal.Inc()
		obs.RecordFallback(ctx, "intel")
		slog.WarnContext(ctx, "intel unavailable; fallback policy decided", "tick", now, "err", intelErr)
	}

	tx, err := i.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Proposals the operator never acted on expire after 8 ticks (2 simulated hours) or when superseded below.
	if _, err := tx.Exec(ctx, `UPDATE recommendations SET status = 'EXPIRED'
		WHERE status = 'PROPOSED' AND epoch_id = $1 AND tick < $2`, i.epochID, now-8); err != nil {
		return err
	}
	for _, r := range resp.Recommendations {
		explanation, _ := json.Marshal(r)
		status := "PROPOSED"
		if r.Verdict == "auto" && autoExec {
			status = "APPROVED"
		}
		var jevModel *string
		if r.JevPAuto != nil {
			jevModel = &resp.Jev.Model
		}
		var id int64
		err := tx.QueryRow(ctx, `INSERT INTO recommendations
			(epoch_id, tick, station_id, fuel_type, route_id, depot_id, quantity, policy_version, risk_before, risk_after,
			 explanation, rule_verdict, jev_p_auto, jev_model, verdict, source, status)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
			ON CONFLICT (epoch_id, tick, station_id, fuel_type, policy_version) DO NOTHING RETURNING id`,
			i.epochID, now, r.StationID, r.FuelType, r.RouteID, r.DepotID, r.Quantity, resp.PolicyVersion,
			clamp01(r.RiskBefore), clamp01(r.RiskAfter), explanation, r.RuleVerdict, r.JevPAuto, jevModel, r.Verdict, resp.Source, status).Scan(&id)
		if err == pgx.ErrNoRows {
			continue // already decided this tick (restart, or a status-only change)
		}
		if err != nil {
			return fmt.Errorf("insert recommendation: %w", err)
		}
		decisionsTotal.WithLabelValues(resp.Source, r.Verdict).Inc()
		if _, err := tx.Exec(ctx, `UPDATE recommendations SET status = 'EXPIRED' WHERE status = 'PROPOSED'
			AND epoch_id = $1 AND station_id = $2 AND fuel_type = $3 AND id <> $4`, i.epochID, r.StationID, r.FuelType, id); err != nil {
			return err
		}
		if status == "APPROVED" {
			reason := "rule: no review reasons"
			if r.JevPAuto != nil {
				reason = fmt.Sprintf("jev p_auto %.2f >= %.2f", *r.JevPAuto, threshold)
			}
			if _, err := tx.Exec(ctx, `INSERT INTO decisions (recommendation_id, actor, action, reason) VALUES ($1,'auto','AUTO_EXECUTE',$2)`, id, reason); err != nil {
				return err
			}
			if err := store.Enqueue(ctx, tx, i.epochID, id, r.DepotID, r.StationID, r.RouteID, r.FuelType, r.Quantity); err != nil {
				return err
			}
		}
	}
	if err := i.recordForecasts(ctx, tx, w, recent); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	for _, p := range resp.Risks {
		stockoutRisk.WithLabelValues(p.StationID, p.FuelType).Set(p.StockoutProb)
	}
	i.cancelDoomed(ctx, resp.Cancel)
	if err := i.reconcileAlerts(ctx, w, resp, intelErr); err != nil {
		return fmt.Errorf("alerts: %w", err)
	}
	var queue int
	if err := i.db.QueryRow(ctx, `SELECT count(*) FROM recommendations WHERE status = 'PROPOSED' AND epoch_id = $1`, i.epochID).Scan(&queue); err == nil {
		reviewQueue.Set(float64(queue))
	}
	i.updateForecastError(ctx)
	return nil
}

func (i *ingestor) callIntel(ctx context.Context, req intel.PlanRequest) (intel.PlanResponse, error) {
	var out intel.PlanResponse
	body, err := json.Marshal(req)
	if err != nil {
		return out, err
	}
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, i.intelURL+"/v1/plan", bytes.NewReader(body))
	if err != nil {
		return out, err
	}
	hreq.Header.Set("Content-Type", "application/json")
	resp, err := i.intel.Do(hreq)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("intel status %d", resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return out, fmt.Errorf("intel: invalid body: %w", err)
	}
	if out.Tick != req.World.Instance.Tick { // validate the dependency's answer before acting on it
		return out, fmt.Errorf("intel answered for tick %d, asked %d", out.Tick, req.World.Instance.Tick)
	}
	return out, nil
}

// cancelDoomed cancels PENDING allocations whose route is disrupted at departure: left alone, the simulator
// marks them FAILED and keeps the depot fuel. Cancelling refunds it. No human is needed to prevent a loss.
func (i *ingestor) cancelDoomed(ctx context.Context, doomed []sim.Allocation) {
	for _, a := range doomed {
		if _, err := i.sim.PostJSON(ctx, fmt.Sprintf("/v1/allocations/%d/cancel", a.ID), nil, nil); err != nil {
			slog.WarnContext(ctx, "cancel doomed allocation failed", "allocation", a.ID, "err", err)
			continue
		}
		cancelledDoomed.Inc()
		slog.InfoContext(ctx, "cancelled allocation to prevent fuel loss", "allocation", a.ID, "route", a.RouteID, "liters", a.Quantity)
		i.oneShotAlert(ctx, "loss_prevented", fmt.Sprintf("allocation-%d", a.ID), "INFO", map[string]any{
			"allocation_id": a.ID, "route_id": a.RouteID, "liters": a.Quantity, "fuel_type": a.FuelType,
			"message": "cancelled: its route is disrupted at departure, so the simulator would have failed it and kept the fuel",
		})
	}
}

// recordForecasts stores the expected demand for the tick about to be simulated, and the naive
// "same as last tick" baseline, so prediction error can be measured once the tick's demand is observed.
func (i *ingestor) recordForecasts(ctx context.Context, tx pgx.Tx, w sim.World, recent []sim.DemandObservation) error {
	now := w.Instance.Tick
	last := map[[2]string]float64{}
	for _, o := range recent {
		if o.Tick == now-1 {
			last[[2]string{o.StationID, o.FuelType}] = o.DemandLiters
		}
	}
	f := policy.NewForecaster(w)
	b := &pgx.Batch{}
	for _, s := range w.Stations {
		for _, fuel := range sim.FuelTypes {
			var naive *float64
			if v, ok := last[[2]string{s.ID, fuel}]; ok {
				naive = &v
			}
			b.Queue(`INSERT INTO forecasts (epoch_id, tick, station_id, fuel_type, expected, naive) VALUES ($1,$2,$3,$4,$5,$6)
				ON CONFLICT DO NOTHING`, i.epochID, now, s.ID, fuel, f.Expected(s, fuel, now), naive)
		}
	}
	return tx.SendBatch(ctx, b).Close()
}

func (i *ingestor) updateForecastError(ctx context.Context) {
	var fc, naive *float64
	err := i.db.QueryRow(ctx, `SELECT avg(abs(o.demand_liters - f.expected) / o.demand_liters),
			avg(abs(o.demand_liters - f.naive) / o.demand_liters)
		FROM forecasts f JOIN demand_observations o USING (epoch_id, tick, station_id, fuel_type)
		WHERE f.epoch_id = $1 AND f.tick > (SELECT max(tick) FROM forecasts WHERE epoch_id = $1) - 96 AND o.demand_liters > 0`,
		i.epochID).Scan(&fc, &naive)
	if err != nil {
		return
	}
	if fc != nil {
		forecastMAPE.WithLabelValues("forecast").Set(*fc)
	}
	if naive != nil {
		forecastMAPE.WithLabelValues("naive").Set(*naive)
	}
}

func clamp01(v float64) float64 { return min(max(v, 0), 1) }
