package ingestor

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/intel"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var alertsOpen = promauto.NewGaugeVec(prometheus.GaugeOpts{
	Name: "alerts_open", Help: "Open alerts by severity.",
}, []string{"severity"})

// Alert is one condition that currently holds. Kind+subject identify it; it stays open while it holds.
type Alert struct {
	Kind, Subject, Severity string
	Detail                  map[string]any
}

// Alerts derives every alert condition from the current world and decision output. Pure, so it is testable.
func Alerts(w sim.World, resp intel.PlanResponse, first map[string]sim.SupplyArrival, intelErr error) []Alert {
	now := w.Instance.Tick
	var out []Alert
	open := map[string]bool{}
	for _, s := range w.Stations {
		open[s.ID] = s.Status == "OPEN"
		if s.Status != "OPEN" {
			out = append(out, Alert{"station_outage", s.ID, "CRITICAL", map[string]any{
				"status": s.Status, "message": "station closed: all its demand is unmet and it cannot receive new allocations"}})
		}
	}
	for _, p := range resp.Risks {
		tts := p.TimeToStockout
		// Same grading as the api's risk_level: warn from 6 h out (or near-certain within 12 h), critical from 2 h.
		if !open[p.StationID] || !((tts >= 0 && tts <= 24) || p.StockoutProb >= 0.9) {
			continue
		}
		sev := "WARN"
		if tts >= 0 && tts <= 8 {
			sev = "CRITICAL"
		}
		d := map[string]any{"stockout_prob": p.StockoutProb, "on_hand": p.OnHand, "in_transit": p.InTransit,
			"demand_next_12h": p.DemandHorizon, "time_to_stockout_ticks": tts}
		if tts >= 0 {
			d["time_to_stockout_hours"] = float64(tts) * float64(max(w.Instance.TickMinutes, 1)) / 60
		}
		out = append(out, Alert{"stockout_risk", p.StationID + ":" + p.FuelType, sev, d})
	}
	for _, a := range resp.Anomalies {
		sev, msg := "WARN", "demand departs from normal with no visible cause: investigate"
		if a.ExplainedBy != "" {
			sev, msg = "INFO", "demand departs from normal: "+a.ExplainedBy
		}
		out = append(out, Alert{"demand_anomaly", a.StationID + ":" + a.FuelType, sev, map[string]any{
			"direction": a.Direction, "ratio": a.Ratio, "threshold": a.Threshold, "window_ticks": a.Window, "message": msg}})
	}
	for _, e := range w.Events {
		subject := fmt.Sprintf("event-%d", e.ID)
		d := map[string]any{"type": e.Type, "start_tick": e.StartTick, "end_tick": e.EndTick, "parameters": e.Parameters}
		switch {
		case e.Status == "ACTIVE":
			sev := "WARN"
			if e.Type == "route_disruption" || e.Type == "station_outage" {
				sev = "CRITICAL"
			}
			out = append(out, Alert{"disruption", subject, sev, d})
		case e.Status == "SCHEDULED" && e.StartTick <= now+8:
			d["starts_in_ticks"] = e.StartTick - now
			out = append(out, Alert{"disruption_upcoming", subject, "INFO", d})
		}
	}
	for _, s := range w.Supply {
		f, ok := first[s.ID]
		if !ok || s.Status == "ARRIVED" {
			continue
		}
		if s.PlannedTick > f.PlannedTick {
			out = append(out, Alert{"supply_delay", s.ID, "WARN", map[string]any{"depot_id": s.DepotID, "fuel_type": s.FuelType,
				"original_tick": f.PlannedTick, "planned_tick": s.PlannedTick, "delay_ticks": s.PlannedTick - f.PlannedTick}})
		}
		if s.Quantity < f.Quantity-0.5 {
			out = append(out, Alert{"supply_shortfall", s.ID, "WARN", map[string]any{"depot_id": s.DepotID, "fuel_type": s.FuelType,
				"original_liters": f.Quantity, "liters": s.Quantity, "missing_liters": f.Quantity - s.Quantity}})
		}
	}
	for _, d := range w.Depots {
		for _, fuel := range sim.FuelTypes {
			if c := d.Capacity[fuel]; c > 0 && d.Inventory[fuel]/c < 0.1 {
				out = append(out, Alert{"depot_low", d.ID + ":" + fuel, "WARN", map[string]any{
					"inventory": d.Inventory[fuel], "capacity": c, "fill": d.Inventory[fuel] / c}})
			}
		}
	}
	for _, a := range w.Allocations {
		if a.Status == "FAILED" {
			out = append(out, Alert{"allocation_failed", fmt.Sprintf("allocation-%d", a.ID), "CRITICAL", map[string]any{
				"route_id": a.RouteID, "liters": a.Quantity, "fuel_type": a.FuelType, "reason": a.FailureReason,
				"message": "the simulator failed this allocation at departure; its depot fuel was not refunded"}})
		}
	}
	if w.Stale {
		out = append(out, Alert{"stale_data", "simulator", "WARN", map[string]any{
			"message": "simulator flagged its data stale: auto-execution is blocked, every recommendation needs review"}})
	}
	if intelErr != nil {
		out = append(out, Alert{"decision_engine_fallback", "intel", "WARN", map[string]any{
			"error": intelErr.Error(), "message": "intel unavailable: fallback policy with the fixed review rule is deciding"}})
	}
	if resp.PolicyFallback != "" {
		out = append(out, Alert{"rl_fallback", "rl", "WARN", map[string]any{
			"error": resp.PolicyFallback, "message": "the RL policy could not decide this tick: the greedy heuristic decided instead"}})
	}
	if resp.Jev.Error != "" {
		out = append(out, Alert{"jev_unavailable", "jev", "INFO", map[string]any{
			"error": resp.Jev.Error, "message": "Jev unavailable: the fixed review rule decides auto vs review"}})
	}
	return out
}

// reconcileAlerts opens alerts for conditions that now hold, refreshes their details, and resolves the rest.
func (i *ingestor) reconcileAlerts(ctx context.Context, w sim.World, resp intel.PlanResponse, intelErr error) error {
	// New supply ids are baselined when first seen.
	for _, s := range w.Supply {
		if _, ok := i.firstSupply[s.ID]; !ok {
			i.firstSupply[s.ID] = s
		}
	}
	conds := Alerts(w, resp, i.firstSupply, intelErr)
	tx, err := i.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	keys := make([]string, 0, len(conds))
	for _, c := range conds {
		detail, _ := json.Marshal(c.Detail)
		if _, err := tx.Exec(ctx, `INSERT INTO alerts (epoch_id, tick, kind, severity, subject, detail) VALUES ($1,$2,$3,$4,$5,$6)
			ON CONFLICT (epoch_id, kind, subject) WHERE resolved_at IS NULL
			DO UPDATE SET severity = EXCLUDED.severity, detail = EXCLUDED.detail`,
			i.epochID, w.Instance.Tick, c.Kind, c.Severity, c.Subject, detail); err != nil {
			return err
		}
		keys = append(keys, c.Kind+"|"+c.Subject)
	}
	if _, err := tx.Exec(ctx, `UPDATE alerts SET resolved_at = now()
		WHERE resolved_at IS NULL AND (epoch_id IS DISTINCT FROM $1 OR NOT (kind || '|' || subject = ANY($2)))`, i.epochID, keys); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	counts := map[string]float64{"INFO": 0, "WARN": 0, "CRITICAL": 0}
	for _, c := range conds {
		counts[c.Severity]++
	}
	for s, n := range counts {
		alertsOpen.WithLabelValues(s).Set(n)
	}
	return nil
}

// oneShotAlert records something that happened (not a standing condition): stored already resolved,
// so it appears in the alert history without lingering as open.
func (i *ingestor) oneShotAlert(ctx context.Context, kind, subject, severity string, detail map[string]any) {
	d, _ := json.Marshal(detail)
	if _, err := i.db.Exec(ctx, `INSERT INTO alerts (epoch_id, tick, kind, severity, subject, detail, resolved_at)
		VALUES ($1,$2,$3,$4,$5,$6, now())`, i.epochID, i.world.Instance.Tick, kind, severity, subject, d); err != nil {
		slog.WarnContext(ctx, "record alert", "kind", kind, "err", err)
	}
}
