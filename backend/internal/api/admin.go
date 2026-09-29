package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"time"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/httpx"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/intel"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/policy"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
	"github.com/jackc/pgx/v5"
)

// Scenario control. The api never calls the simulator: it validates and queues a command, the ingestor
// (sole simulator client) executes it, and the api waits briefly for the result.

func (s *server) simStep(w http.ResponseWriter, r *http.Request) {
	body := struct {
		Count int `json:"count"`
	}{Count: 1}
	if r.ContentLength != 0 && !decode(w, r, &body) {
		return
	}
	if body.Count < 1 || body.Count > 96 {
		writeErr(w, http.StatusBadRequest, "INVALID_BODY", "count must be 1–96 (one simulated day)")
		return
	}
	s.queueAndWait(w, r, "step", body)
}

func (s *server) simSimple(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { s.queueAndWait(w, r, kind, map[string]any{}) }
}

type eventBody struct {
	Type          string         `json:"type"`
	StartTick     *int           `json:"start_tick"` // absolute tick; omit to start at the current tick + start_in
	StartIn       int            `json:"start_in"`
	DurationTicks int            `json:"duration_ticks"`
	Parameters    map[string]any `json:"parameters"`
}

// simEvent injects a crisis event. Inputs are checked against the live world because the simulator
// silently ignores unknown ids, treats empty id lists as "nothing" for route/station/depot events, and a
// demand_spike multiplier of 0 crashes its tick loop permanently (division by zero on resolve).
func (s *server) simEvent(w http.ResponseWriter, r *http.Request) {
	var b eventBody
	if !decode(w, r, &b) {
		return
	}
	snap, ok := s.snapshot(w, r)
	if !ok {
		return
	}
	if b.Parameters == nil {
		b.Parameters = map[string]any{} // the simulator rejects null with a 422
	}
	if errs := validateEvent(snap.World, b); len(errs) > 0 {
		writeErr(w, http.StatusBadRequest, "INVALID_EVENT", "event rejected before reaching the simulator", errs...)
		return
	}
	s.queueAndWait(w, r, "event", b)
}

func validateEvent(wd sim.World, b eventBody) []string {
	var errs []string
	if b.DurationTicks < 1 || b.DurationTicks > 2000 {
		errs = append(errs, "duration_ticks must be 1–2000")
	}
	if b.StartTick != nil && *b.StartTick < 0 {
		errs = append(errs, "start_tick must be >= 0")
	}
	if b.StartIn < 0 || b.StartIn > 2000 {
		errs = append(errs, "start_in must be 0–2000")
	}
	known := map[string]map[string]bool{"route_ids": {}, "station_ids": {}, "depot_ids": {}, "region_ids": {}, "fuel_types": {}}
	for _, x := range wd.Routes {
		known["route_ids"][x.ID] = true
	}
	for _, x := range wd.Stations {
		known["station_ids"][x.ID] = true
	}
	for _, x := range wd.Depots {
		known["depot_ids"][x.ID] = true
	}
	for _, x := range wd.Regions {
		known["region_ids"][x.ID] = true
	}
	for _, f := range sim.FuelTypes {
		known["fuel_types"][f] = true
	}
	allowed := map[string][]string{
		"demand_spike":     {"multiplier", "station_ids", "region_ids"},
		"route_disruption": {"route_ids"},
		"station_outage":   {"station_ids"},
		"depot_constraint": {"depot_ids"},
		"shipment_delay":   {"delay_ticks", "depot_ids", "fuel_types"},
		"supply_shortfall": {"factor", "depot_ids", "fuel_types"},
	}
	keys, ok := allowed[b.Type]
	if !ok {
		return append(errs, fmt.Sprintf("unknown type %q", b.Type))
	}
	for k, v := range b.Parameters {
		if !contains(keys, k) {
			errs = append(errs, fmt.Sprintf("parameter %q is not used by %s (allowed: %v)", k, b.Type, keys))
			continue
		}
		if ids, isList := known[k]; isList {
			list, okList := v.([]any)
			if !okList {
				errs = append(errs, k+" must be a list")
				continue
			}
			for _, x := range list {
				if id, _ := x.(string); !ids[id] {
					errs = append(errs, fmt.Sprintf("%s: unknown id %v", k, x))
				}
			}
		}
	}
	num := func(k string, lo, hi float64, def float64) {
		v, present := b.Parameters[k]
		f, isNum := v.(float64)
		if !present {
			f, isNum = def, true
		}
		if !isNum || math.IsNaN(f) || f < lo || f > hi {
			errs = append(errs, fmt.Sprintf("%s must be a number in [%g, %g]", k, lo, hi))
		}
	}
	switch b.Type {
	case "demand_spike":
		num("multiplier", 0.05, 10, 1.5)
	case "shipment_delay":
		num("delay_ticks", 1, 500, 2)
	case "supply_shortfall":
		num("factor", 0, 1, 0.5)
	case "route_disruption", "station_outage", "depot_constraint":
		key := map[string]string{"route_disruption": "route_ids", "station_outage": "station_ids", "depot_constraint": "depot_ids"}[b.Type]
		if l, _ := b.Parameters[key].([]any); len(l) == 0 {
			errs = append(errs, key+" must list at least one id: the simulator ignores an empty list (it does NOT mean all)")
		}
	}
	return errs
}

type faultBody struct {
	Type            string         `json:"type"`
	DurationSeconds int            `json:"duration_seconds"`
	Parameters      map[string]any `json:"parameters"`
}

// simFault injects a software fault into the simulator's API (latency, 503s, stale flag, SSE refusal).
func (s *server) simFault(w http.ResponseWriter, r *http.Request) {
	var b faultBody
	if !decode(w, r, &b) {
		return
	}
	var errs []string
	params := map[string]string{"latency": "delay_ms", "error_rate": "rate", "unavailable": "", "stale_data": "", "stream_disconnect": ""}
	key, ok := params[b.Type]
	if !ok {
		errs = append(errs, fmt.Sprintf("unknown type %q", b.Type))
	}
	if b.DurationSeconds < 1 || b.DurationSeconds > 3600 {
		errs = append(errs, "duration_seconds must be 1–3600")
	}
	for k, v := range b.Parameters {
		f, isNum := v.(float64)
		switch {
		case k != key || key == "":
			errs = append(errs, fmt.Sprintf("parameter %q is not used by %s", k, b.Type))
		case k == "delay_ms" && (!isNum || f < 0 || f > 10000):
			errs = append(errs, "delay_ms must be 0–10000")
		case k == "rate" && (!isNum || f < 0 || f > 1):
			errs = append(errs, "rate must be 0–1")
		}
	}
	if len(errs) > 0 {
		writeErr(w, http.StatusBadRequest, "INVALID_FAULT", "fault rejected before reaching the simulator", errs...)
		return
	}
	if b.Parameters == nil {
		b.Parameters = map[string]any{} // the simulator rejects null with a 422
	}
	s.queueAndWait(w, r, "fault", b)
}

type command struct {
	ID          int64           `json:"id"`
	Kind        string          `json:"kind"`
	Payload     json.RawMessage `json:"payload"`
	Status      string          `json:"status"` // PENDING | DONE | FAILED
	Result      json.RawMessage `json:"result"`
	Error       *string         `json:"error"`
	RequestedBy string          `json:"requested_by"`
	CreatedAt   time.Time       `json:"created_at"`
	DoneAt      *time.Time      `json:"done_at"`
}

const commandSelect = `SELECT id, kind, payload, status, result, error, requested_by, created_at, done_at FROM sim_commands`

func scanCommand(row pgx.CollectableRow) (command, error) {
	var c command
	err := row.Scan(&c.ID, &c.Kind, &c.Payload, &c.Status, &c.Result, &c.Error, &c.RequestedBy, &c.CreatedAt, &c.DoneAt)
	return c, err
}

// queueAndWait queues a command for the ingestor and waits up to 25 s: 200 done, 502 failed in the
// simulator, 202 still running (poll GET /api/admin/commands/{id}).
func (s *server) queueAndWait(w http.ResponseWriter, r *http.Request, kind string, payload any) {
	ctx := r.Context()
	body, _ := json.Marshal(payload)
	var id int64
	if err := s.db.QueryRow(ctx, `INSERT INTO sim_commands (kind, payload, requested_by) VALUES ($1,$2,$3) RETURNING id`,
		kind, body, s.auth.actor(r)).Scan(&id); err != nil {
		internalErr(w, err)
		return
	}
	deadline := time.Now().Add(25 * time.Second)
	for {
		rows, err := s.db.Query(ctx, commandSelect+` WHERE id = $1`, id)
		if err != nil {
			internalErr(w, err)
			return
		}
		c, err := pgx.CollectExactlyOneRow(rows, scanCommand)
		if err != nil {
			internalErr(w, err)
			return
		}
		switch {
		case c.Status == "DONE":
			s.hub.poke()
			httpx.WriteJSON(w, http.StatusOK, c)
			return
		case c.Status == "FAILED":
			httpx.WriteJSON(w, http.StatusBadGateway, map[string]any{"error": apiError{Code: "SIM_COMMAND_FAILED", Message: deref(c.Error)}, "command": c})
			return
		case time.Now().After(deadline):
			httpx.WriteJSON(w, http.StatusAccepted, c)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (s *server) listCommands(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), commandSelect+` ORDER BY id DESC LIMIT $1`, intParam(r.URL.Query().Get("limit"), 50, 1, 500))
	if err != nil {
		internalErr(w, err)
		return
	}
	cs, err := pgx.CollectRows(rows, scanCommand)
	if err != nil {
		internalErr(w, err)
		return
	}
	if cs == nil {
		cs = []command{}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"commands": cs})
}

func (s *server) getCommand(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Query(r.Context(), commandSelect+` WHERE id = $1`, id)
	if err != nil {
		internalErr(w, err)
		return
	}
	c, err := pgx.CollectExactlyOneRow(rows, scanCommand)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "NOT_FOUND", "no such command")
		return
	}
	if err != nil {
		internalErr(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, c)
}

// getPolicy: the active decision policy and the human-in-the-loop settings.
func (s *server) getPolicy(w http.ResponseWriter, r *http.Request) {
	var auto bool
	var th float64
	var by, decision string
	var at time.Time
	if err := s.db.QueryRow(r.Context(), `SELECT auto_execute, jev_threshold, updated_by, updated_at, decision_policy FROM settings WHERE id = 1`).
		Scan(&auto, &th, &by, &at, &decision); err != nil {
		internalErr(w, err)
		return
	}
	o := policy.DefaultOptions
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"decision_policy":   decision, // rl = the trained Maskable PPO policy proposes; greedy = the heuristic proposes
		"policy_versions":   map[string]string{"rl": intel.RLVersion, "greedy": policy.Version},
		"rl_low_confidence": intel.LowConfidence,
		"policy_version":    policy.Version, "auto_execute": auto, "jev_threshold": th, "jev_configured": s.jevConfigured,
		"updated_by": by, "updated_at": at,
		"options": map[string]any{"horizon_ticks": o.Horizon, "monte_carlo_runs": o.Runs, "safety_ticks": o.SafetyTicks,
			"min_lot_liters": o.MinLot, "review_above_liters": o.ReviewQty},
		"review_rule": []string{
			"hard veto (always review): stale data, shipment > review_above_liters, an event touching the route/station/depot/region, rerouted around a disruption, RL confidence below rl_low_confidence",
			"otherwise Jev decides: auto if p_auto >= jev_threshold",
			"if Jev is off or fails, the fixed rule decides: review if any crisis is active, residual risk after the shipment > 25%, or unexplained demand anomaly",
		},
	})
}

func (s *server) putPolicy(w http.ResponseWriter, r *http.Request) {
	var b struct {
		AutoExecute    *bool    `json:"auto_execute"`
		JevThreshold   *float64 `json:"jev_threshold"`
		DecisionPolicy *string  `json:"decision_policy"`
	}
	if !decode(w, r, &b) {
		return
	}
	if b.DecisionPolicy != nil && *b.DecisionPolicy != "rl" && *b.DecisionPolicy != "greedy" {
		writeErr(w, http.StatusBadRequest, "INVALID_BODY", "decision_policy must be rl or greedy")
		return
	}
	if b.JevThreshold != nil && (*b.JevThreshold <= 0 || *b.JevThreshold > 1) {
		writeErr(w, http.StatusBadRequest, "INVALID_BODY", "jev_threshold must be in (0, 1]")
		return
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE settings SET auto_execute = COALESCE($1, auto_execute),
		jev_threshold = COALESCE($2, jev_threshold), decision_policy = COALESCE($4, decision_policy),
		updated_by = $3, updated_at = now() WHERE id = 1`,
		b.AutoExecute, b.JevThreshold, s.auth.actor(r), b.DecisionPolicy); err != nil {
		internalErr(w, err)
		return
	}
	s.getPolicy(w, r)
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
