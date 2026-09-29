package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/genai"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/httpx"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/policy"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/store"
	"github.com/jackc/pgx/v5"
)

type recommendation struct {
	ID            int64           `json:"id"`
	EpochID       int64           `json:"epoch_id"`
	Tick          int             `json:"tick"`
	StationID     string          `json:"station_id"`
	FuelType      string          `json:"fuel_type"`
	DepotID       *string         `json:"depot_id"`
	RouteID       string          `json:"route_id"`
	Quantity      float64         `json:"quantity"`
	PolicyVersion string          `json:"policy_version"`
	Source        string          `json:"source"` // intel | fallback | manual
	RiskBefore    *float64        `json:"risk_before"`
	RiskAfter     *float64        `json:"risk_after"`
	RuleVerdict   *string         `json:"rule_verdict"`
	JevPAuto      *float64        `json:"jev_p_auto"`
	JevModel      *string         `json:"jev_model"`
	Verdict       *string         `json:"verdict"`
	Status        string          `json:"status"` // PROPOSED | APPROVED | REJECTED | SUBMITTED | EXPIRED | FAILED
	CreatedAt     time.Time       `json:"created_at"`
	Explanation   json.RawMessage `json:"explanation"` // signals, binding constraint, alternatives, review reasons, Jev features
	Outbox        *outboxState    `json:"outbox"`
}

type outboxState struct {
	Status          string  `json:"status"`
	Attempts        int     `json:"attempts"`
	LastError       *string `json:"last_error"`
	SimAllocationID *int    `json:"sim_allocation_id"`
}

const recSelect = `SELECT r.id, r.epoch_id, r.tick, r.station_id, r.fuel_type, r.depot_id, r.route_id, r.quantity::float8,
	r.policy_version, r.source, r.risk_before, r.risk_after, r.rule_verdict, r.jev_p_auto, r.jev_model, r.verdict, r.status,
	r.created_at, r.explanation, o.status, o.attempts, o.last_error, o.sim_allocation_id
	FROM recommendations r LEFT JOIN outbox o ON o.recommendation_id = r.id`

func scanRec(row pgx.CollectableRow) (recommendation, error) {
	var r recommendation
	var oStatus *string
	var oAttempts *int
	var oErr *string
	var oSim *int
	err := row.Scan(&r.ID, &r.EpochID, &r.Tick, &r.StationID, &r.FuelType, &r.DepotID, &r.RouteID, &r.Quantity,
		&r.PolicyVersion, &r.Source, &r.RiskBefore, &r.RiskAfter, &r.RuleVerdict, &r.JevPAuto, &r.JevModel, &r.Verdict, &r.Status,
		&r.CreatedAt, &r.Explanation, &oStatus, &oAttempts, &oErr, &oSim)
	if oStatus != nil {
		r.Outbox = &outboxState{Status: *oStatus, Attempts: *oAttempts, LastError: oErr, SimAllocationID: oSim}
	}
	return r, err
}

// listRecommendations: current epoch, newest first. Query: status (comma list, e.g. PROPOSED), limit.
func (s *server) listRecommendations(w http.ResponseWriter, r *http.Request) {
	snap, ok := s.snapshot(w, r)
	if !ok {
		return
	}
	var statuses []string
	if v := r.URL.Query().Get("status"); v != "" {
		statuses = strings.Split(strings.ToUpper(v), ",")
	}
	rows, err := s.db.Query(r.Context(), recSelect+` WHERE r.epoch_id = $1 AND (COALESCE(cardinality($2::text[]), 0) = 0 OR r.status = ANY($2))
		ORDER BY r.id DESC LIMIT $3`, snap.EpochID, statuses, intParam(r.URL.Query().Get("limit"), 100, 1, 1000))
	if err != nil {
		internalErr(w, err)
		return
	}
	recs, err := pgx.CollectRows(rows, scanRec)
	if err != nil {
		internalErr(w, err)
		return
	}
	if recs == nil {
		recs = []recommendation{}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"tick": snap.World.Instance.Tick, "recommendations": recs})
}

// getRecommendation: one recommendation with its decisions, submission state, the live simulator allocation,
// and — while still PROPOSED — whether it is still safe to execute against the current world.
func (s *server) getRecommendation(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	rec, err := s.loadRec(r.Context(), s.db, id, false)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "NOT_FOUND", "no such recommendation")
		return
	}
	if err != nil {
		internalErr(w, err)
		return
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, actor, action, reason, created_at FROM decisions WHERE recommendation_id = $1 ORDER BY id`, id)
	if err != nil {
		internalErr(w, err)
		return
	}
	decisions, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (map[string]any, error) {
		var did int64
		var actor, action string
		var reason *string
		var at time.Time
		err := row.Scan(&did, &actor, &action, &reason, &at)
		return map[string]any{"id": did, "actor": actor, "action": action, "reason": reason, "created_at": at}, err
	})
	if err != nil {
		internalErr(w, err)
		return
	}
	out := map[string]any{"recommendation": rec, "decisions": decisions}
	if snap, err := store.LatestSnapshot(r.Context(), s.db); err == nil {
		if rec.Outbox != nil && rec.Outbox.SimAllocationID != nil {
			for _, a := range snap.World.Allocations {
				if a.ID == *rec.Outbox.SimAllocationID {
					out["sim_allocation"] = a
				}
			}
		}
		if rec.Status == "PROPOSED" {
			v := append([]string{}, policy.Validate(snap.World, policy.Proposal{StationID: rec.StationID, FuelType: rec.FuelType, RouteID: rec.RouteID, Quantity: rec.Quantity})...)
			out["still_valid"], out["violations"] = len(v) == 0 && snap.EpochID == rec.EpochID, v
		}
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// explainTimeout bounds the outbound LLM call. On expiry the explainer returns
// its deterministic fallback, so this endpoint never hangs on the model.
const explainTimeout = 20 * time.Second

// explainRecommendation returns a human-readable, operator-facing explanation of
// one recommendation (brief §7 GenAI: "human-readable decision explanations",
// §9: inspectable decisions). The hard numbers are computed deterministically;
// the LLM only writes the narrative, and falls back cleanly when unavailable.
func (s *server) explainRecommendation(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	rec, err := s.loadRec(r.Context(), s.db, id, false)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "NOT_FOUND", "no such recommendation")
		return
	}
	if err != nil {
		internalErr(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), explainTimeout)
	defer cancel()
	ex := s.explain.Explain(ctx, decisionInput(rec))
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"recommendation_id": id, "explanation": ex})
}

// decisionInput maps a stored recommendation to the grounded facts the explainer
// needs. The authoritative scalars come from the recommendation's own columns;
// the richer evidence (binding constraint, review reasons, rejected routes,
// signals) is read from the explanation JSON the planner wrote (a marshaled
// intel.Triaged). Missing fields (e.g. for a manual allocation) are simply left
// zero — the explainer handles that.
func decisionInput(rec recommendation) genai.DecisionInput {
	in := genai.DecisionInput{
		StationID: rec.StationID, FuelType: rec.FuelType, RouteID: rec.RouteID,
		DepotID: deref(rec.DepotID), Quantity: rec.Quantity, TimeToStockout: -1,
		RiskBefore: derefF(rec.RiskBefore), RiskAfter: derefF(rec.RiskAfter),
		Verdict: deref(rec.Verdict),
	}
	if len(rec.Explanation) > 0 {
		var ev struct {
			TimeToStockout    *int           `json:"time_to_stockout"`
			BindingConstraint string         `json:"binding_constraint"`
			ReviewReasons     []string       `json:"review_reasons"`
			RuleReasons       []string       `json:"rule_reasons"`
			Signals           map[string]any `json:"signals"`
			Alternatives      []struct {
				RouteID  string `json:"route_id"`
				DepotID  string `json:"depot_id"`
				Rejected string `json:"rejected"`
			} `json:"alternatives"`
		}
		if json.Unmarshal(rec.Explanation, &ev) == nil {
			if ev.TimeToStockout != nil {
				in.TimeToStockout = *ev.TimeToStockout
			}
			in.BindingConstraint = ev.BindingConstraint
			in.Signals = ev.Signals
			// rule_reasons is the full set the verdict was based on (hard + soft);
			// fall back to the planner's review_reasons if it is absent.
			in.ReviewReasons = ev.RuleReasons
			if len(in.ReviewReasons) == 0 {
				in.ReviewReasons = ev.ReviewReasons
			}
			for _, a := range ev.Alternatives {
				if a.Rejected != "" {
					in.RejectedAlts = append(in.RejectedAlts, fmt.Sprintf("%s via %s — rejected: %s", a.RouteID, a.DepotID, a.Rejected))
				}
			}
		}
	}
	return in
}

func (s *server) loadRec(ctx context.Context, q store.Querier, id int64, lock bool) (recommendation, error) {
	sql := recSelect + ` WHERE r.id = $1`
	if lock {
		sql += ` FOR UPDATE OF r`
	}
	rows, err := q.Query(ctx, sql, id)
	if err != nil {
		return recommendation{}, err
	}
	return pgx.CollectExactlyOneRow(rows, scanRec)
}

type approveBody struct {
	Reason   string   `json:"reason"`
	Quantity *float64 `json:"quantity"` // optional operator edit; re-validated
}

// approve: a human accepts a PROPOSED recommendation; it goes to the outbox for the ingestor to submit.
func (s *server) approve(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var body approveBody
	if r.ContentLength != 0 && !decode(w, r, &body) {
		return
	}
	if len(body.Reason) > 500 {
		writeErr(w, http.StatusBadRequest, "INVALID_BODY", "reason is limited to 500 characters")
		return
	}
	s.decide(w, r, id, func(ctx context.Context, tx pgx.Tx, rec *recommendation, snap store.Snapshot) (int, *apiError) {
		if body.Quantity != nil {
			rec.Quantity = math.Floor(*body.Quantity)
		}
		if v := policy.Validate(snap.World, policy.Proposal{StationID: rec.StationID, FuelType: rec.FuelType, RouteID: rec.RouteID, Quantity: rec.Quantity}); len(v) > 0 {
			return http.StatusUnprocessableEntity, &apiError{Code: "UNSAFE", Message: "the world changed: executing this now would be rejected or lose fuel", Details: v}
		}
		if _, err := tx.Exec(ctx, `UPDATE recommendations SET status = 'APPROVED', quantity = $2 WHERE id = $1`, rec.ID, rec.Quantity); err != nil {
			return 0, &apiError{Code: "INTERNAL", Message: err.Error()}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO decisions (recommendation_id, actor, action, reason) VALUES ($1,$2,'APPROVE',NULLIF($3,''))`,
			rec.ID, s.auth.actor(r), body.Reason); err != nil {
			return 0, &apiError{Code: "INTERNAL", Message: err.Error()}
		}
		depot := deref(rec.DepotID)
		for _, rt := range snap.World.Routes {
			if rt.ID == rec.RouteID {
				depot = rt.SourceDepotID // the route fixes the depot
			}
		}
		if err := store.Enqueue(ctx, tx, rec.EpochID, rec.ID, depot, rec.StationID, rec.RouteID, rec.FuelType, rec.Quantity); err != nil {
			return 0, &apiError{Code: "INTERNAL", Message: err.Error()}
		}
		return http.StatusOK, nil
	})
}

// reject: a human declines a PROPOSED recommendation. A reason is required for the audit trail.
func (s *server) reject(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if !decode(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Reason) == "" || len(body.Reason) > 500 {
		writeErr(w, http.StatusBadRequest, "INVALID_BODY", "reason is required (1–500 characters)")
		return
	}
	s.decide(w, r, id, func(ctx context.Context, tx pgx.Tx, rec *recommendation, _ store.Snapshot) (int, *apiError) {
		if _, err := tx.Exec(ctx, `UPDATE recommendations SET status = 'REJECTED' WHERE id = $1`, rec.ID); err != nil {
			return 0, &apiError{Code: "INTERNAL", Message: err.Error()}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO decisions (recommendation_id, actor, action, reason) VALUES ($1,$2,'REJECT',$3)`,
			rec.ID, s.auth.actor(r), body.Reason); err != nil {
			return 0, &apiError{Code: "INTERNAL", Message: err.Error()}
		}
		return http.StatusOK, nil
	})
}

// decide runs fn on a locked, still-PROPOSED recommendation of the current epoch, then returns it.
func (s *server) decide(w http.ResponseWriter, r *http.Request, id int64,
	fn func(context.Context, pgx.Tx, *recommendation, store.Snapshot) (int, *apiError)) {
	ctx := r.Context()
	snap, ok := s.snapshot(w, r)
	if !ok {
		return
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		internalErr(w, err)
		return
	}
	defer tx.Rollback(ctx)
	rec, err := s.loadRec(ctx, tx, id, true)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "NOT_FOUND", "no such recommendation")
		return
	}
	if err != nil {
		internalErr(w, err)
		return
	}
	if rec.Status != "PROPOSED" {
		writeErr(w, http.StatusConflict, "NOT_PROPOSED", "recommendation is "+rec.Status+": only PROPOSED ones can be decided")
		return
	}
	if rec.EpochID != snap.EpochID {
		writeErr(w, http.StatusConflict, "EXPIRED", "the simulator was reset since this was proposed")
		return
	}
	status, apiErr := fn(ctx, tx, &rec, snap)
	if apiErr != nil {
		if status == 0 {
			status = http.StatusInternalServerError
		}
		writeErr(w, status, apiErr.Code, apiErr.Message, apiErr.Details...)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		internalErr(w, err)
		return
	}
	rec, err = s.loadRec(ctx, s.db, id, false)
	if err != nil {
		internalErr(w, err)
		return
	}
	s.hub.poke()
	httpx.WriteJSON(w, status, rec)
}

// simulate is the what-if for a candidate shipment: every constraint and trap it would hit, and its effect on
// stockout risk. Nothing is submitted (brief §22 step 8: "allocation is simulated").
func (s *server) simulate(w http.ResponseWriter, r *http.Request) {
	var p policy.Proposal
	if !decode(w, r, &p) {
		return
	}
	snap, ok := s.snapshot(w, r)
	if !ok {
		return
	}
	httpx.WriteJSON(w, http.StatusOK, whatIf(snap.World, p))
}

func whatIf(wd sim.World, p policy.Proposal) map[string]any {
	violations := append([]string{}, policy.Validate(wd, p)...)
	out := map[string]any{"tick": wd.Instance.Tick, "proposal": p, "valid": len(violations) == 0, "violations": violations}
	before, after, err := policy.Impact(wd, p, policy.DefaultOptions)
	if err != nil {
		return out
	}
	view := func(pr policy.Projection) map[string]any {
		return map[string]any{"stockout_prob": pr.StockoutProb, "time_to_stockout_ticks": pr.TimeToStockout,
			"time_to_stockout_hours": hours(pr.TimeToStockout, wd), "risk_level": riskLevel(pr), "position": pr.Position()}
	}
	out["before"], out["after"] = view(before), view(after)
	out["risk_reduction"] = before.StockoutProb - after.StockoutProb
	for _, rt := range wd.Routes {
		if rt.ID == p.RouteID {
			out["arrival_tick"] = wd.Instance.Tick + rt.TransitTicks
		}
	}
	return out
}

type manualBody struct {
	policy.Proposal
	Reason string `json:"reason"`
}

// manualAllocation: an operator's own shipment. Validated like any other, recorded as a human decision,
// then submitted through the same outbox.
func (s *server) manualAllocation(w http.ResponseWriter, r *http.Request) {
	var body manualBody
	if !decode(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Reason) == "" || len(body.Reason) > 500 {
		writeErr(w, http.StatusBadRequest, "INVALID_BODY", "reason is required (1–500 characters)")
		return
	}
	body.Quantity = math.Floor(body.Quantity)
	snap, ok := s.snapshot(w, r)
	if !ok {
		return
	}
	wi := whatIf(snap.World, body.Proposal)
	if v := wi["violations"].([]string); len(v) > 0 {
		writeErr(w, http.StatusUnprocessableEntity, "UNSAFE", "this shipment would be rejected or lose fuel", v...)
		return
	}
	var depot string
	for _, rt := range snap.World.Routes {
		if rt.ID == body.RouteID {
			depot = rt.SourceDepotID
		}
	}
	explanation, _ := json.Marshal(map[string]any{"manual": true, "reason": body.Reason, "what_if": wi})
	var before, after *float64
	if b, ok := wi["before"].(map[string]any); ok {
		v := b["stockout_prob"].(float64)
		before = &v
	}
	if a, ok := wi["after"].(map[string]any); ok {
		v := a["stockout_prob"].(float64)
		after = &v
	}
	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		internalErr(w, err)
		return
	}
	defer tx.Rollback(ctx)
	var id int64
	err = tx.QueryRow(ctx, `INSERT INTO recommendations (epoch_id, tick, station_id, fuel_type, route_id, depot_id, quantity,
			policy_version, risk_before, risk_after, explanation, verdict, source, status)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'review','manual','APPROVED')
		ON CONFLICT (epoch_id, tick, station_id, fuel_type, policy_version) DO NOTHING RETURNING id`,
		snap.EpochID, snap.World.Instance.Tick, body.StationID, body.FuelType, body.RouteID, depot, body.Quantity,
		"manual", before, after, explanation).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusConflict, "DUPLICATE", "a manual allocation for this station and fuel was already made this tick")
		return
	}
	if err != nil {
		internalErr(w, err)
		return
	}
	if _, err := tx.Exec(ctx, `INSERT INTO decisions (recommendation_id, actor, action, reason) VALUES ($1,$2,'APPROVE',$3)`,
		id, s.auth.actor(r), body.Reason); err != nil {
		internalErr(w, err)
		return
	}
	if err := store.Enqueue(ctx, tx, snap.EpochID, id, depot, body.StationID, body.RouteID, body.FuelType, body.Quantity); err != nil {
		internalErr(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		internalErr(w, err)
		return
	}
	rec, err := s.loadRec(ctx, s.db, id, false)
	if err != nil {
		internalErr(w, err)
		return
	}
	s.hub.poke()
	httpx.WriteJSON(w, http.StatusCreated, rec)
}

// cancelAllocation cancels a PENDING simulator allocation (refunds the depot) via the ingestor.
func (s *server) cancelAllocation(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	snap, ok := s.snapshot(w, r)
	if !ok {
		return
	}
	var found *sim.Allocation
	for i, a := range snap.World.Allocations {
		if int64(a.ID) == id {
			found = &snap.World.Allocations[i]
		}
	}
	if found == nil {
		writeErr(w, http.StatusNotFound, "NOT_FOUND", "no such allocation in the latest snapshot")
		return
	}
	if found.Status != "PENDING" {
		writeErr(w, http.StatusConflict, "CANNOT_CANCEL", "only PENDING allocations can be cancelled; this one is "+found.Status)
		return
	}
	s.queueAndWait(w, r, "cancel_allocation", map[string]any{"allocation_id": id})
}

// decisions is the decision history (audit trail): who decided what, and what happened to it.
func (s *server) decisions(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), `SELECT d.id, d.created_at, d.actor, d.action, d.reason,
			r.id, r.epoch_id, r.tick, r.station_id, r.fuel_type, r.route_id, r.quantity::float8, r.status, r.source, r.verdict,
			r.risk_before, r.risk_after, o.status, o.last_error, o.sim_allocation_id
		FROM decisions d JOIN recommendations r ON r.id = d.recommendation_id LEFT JOIN outbox o ON o.recommendation_id = r.id
		ORDER BY d.id DESC LIMIT $1`, intParam(r.URL.Query().Get("limit"), 100, 1, 1000))
	if err != nil {
		internalErr(w, err)
		return
	}
	// Live simulator status, only for allocations of the current epoch (ids restart after a reset).
	simStatus := map[int]string{}
	var epoch int64
	if snap, err := store.LatestSnapshot(r.Context(), s.db); err == nil {
		epoch = snap.EpochID
		for _, a := range snap.World.Allocations {
			simStatus[a.ID] = a.Status
		}
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (map[string]any, error) {
		var id, recID int64
		var at time.Time
		var actor, action, station, fuel, route, status, source string
		var reason, verdict, oStatus, oErr *string
		var tick int
		var qty float64
		var rb, ra *float64
		var simID *int
		var recEpoch int64
		err := row.Scan(&id, &at, &actor, &action, &reason, &recID, &recEpoch, &tick, &station, &fuel, &route, &qty, &status, &source,
			&verdict, &rb, &ra, &oStatus, &oErr, &simID)
		d := map[string]any{"id": id, "created_at": at, "actor": actor, "action": action, "reason": reason,
			"recommendation": map[string]any{"id": recID, "epoch_id": recEpoch, "tick": tick, "station_id": station, "fuel_type": fuel,
				"route_id": route, "quantity": qty, "status": status, "source": source, "verdict": verdict, "risk_before": rb, "risk_after": ra},
			"outcome": map[string]any{"submission": oStatus, "error": oErr, "sim_allocation_id": simID}}
		if st, ok := simStatus[simIDOr0(simID)]; ok && simID != nil && recEpoch == epoch {
			d["outcome"].(map[string]any)["sim_status"] = st
		}
		return d, err
	})
	if err != nil {
		internalErr(w, err)
		return
	}
	if out == nil {
		out = []map[string]any{}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"decisions": out})
}

// alerts: shortage, anomaly, disruption, supply, integration and fallback alerts. Query: state=open|all, limit.
func (s *server) alerts(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	if state == "" {
		state = "open"
	}
	if state != "open" && state != "all" {
		writeErr(w, http.StatusBadRequest, "INVALID_QUERY", "state must be open or all")
		return
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, epoch_id, tick, kind, severity, subject, detail, created_at, resolved_at, acked_at, acked_by
		FROM alerts WHERE ($1 = 'all' OR resolved_at IS NULL)
		ORDER BY resolved_at IS NULL DESC, CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARN' THEN 1 ELSE 2 END, id DESC LIMIT $2`,
		state, intParam(r.URL.Query().Get("limit"), 200, 1, 2000))
	if err != nil {
		internalErr(w, err)
		return
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (map[string]any, error) {
		var id int64
		var epoch *int64
		var tick *int
		var kind, severity string
		var subject, ackedBy *string
		var detail json.RawMessage
		var created time.Time
		var resolved, acked *time.Time
		err := row.Scan(&id, &epoch, &tick, &kind, &severity, &subject, &detail, &created, &resolved, &acked, &ackedBy)
		return map[string]any{"id": id, "epoch_id": epoch, "tick": tick, "kind": kind, "severity": severity, "subject": subject,
			"detail": detail, "created_at": created, "resolved_at": resolved, "acked_at": acked, "acked_by": ackedBy,
			"open": resolved == nil}, err
	})
	if err != nil {
		internalErr(w, err)
		return
	}
	if out == nil {
		out = []map[string]any{}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"alerts": out})
}

func (s *server) ackAlert(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE alerts SET acked_at = now(), acked_by = $2 WHERE id = $1 AND acked_at IS NULL`, id, s.auth.actor(r))
	if err != nil {
		internalErr(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusConflict, "NOT_ACKABLE", "no such alert, or it is already acknowledged")
		return
	}
	s.hub.poke()
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"id": id, "acked_by": s.auth.actor(r)})
}

func pathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "INVALID_ID", fmt.Sprintf("invalid id %q", r.PathValue("id")))
		return 0, false
	}
	return id, true
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefF(f *float64) float64 {
	if f == nil {
		return 0
	}
	return *f
}

func simIDOr0(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}
