package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/httpx"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/rl"
	"github.com/jackc/pgx/v5"
)

// rlModel is the RL policy card plus how it behaves live. With decision_policy=rl it proposes the recommendations
// (through validation, review and the outbox); either way every tick is also logged next to the planner baseline
// and greedy. Offline numbers are the package's frozen held-out evaluation (docs/RL_HUGGINGFACE_HANDOFF.md §9).
func (s *server) rlModel(w http.ResponseWriter, r *http.Request) {
	a, err := rl.LoadActor()
	if err != nil {
		internalErr(w, err)
		return
	}
	live := map[string]any{}
	snap, ok := s.snapshot(w, r)
	if !ok {
		return
	}
	var n, errs, ship, agree, baseShip int
	var avgUs *float64
	var decision string
	if err := s.db.QueryRow(r.Context(), `SELECT decision_policy FROM settings WHERE id = 1`).Scan(&decision); err != nil {
		internalErr(w, err)
		return
	}
	if err := s.db.QueryRow(r.Context(), `SELECT count(*), count(*) FILTER (WHERE error IS NOT NULL),
			count(*) FILTER (WHERE action > 0), count(*) FILTER (WHERE action = baseline_action),
			count(*) FILTER (WHERE baseline_action > 0), avg(latency_us)
		FROM rl_shadow WHERE epoch_id = $1`, snap.EpochID).Scan(&n, &errs, &ship, &agree, &baseShip, &avgUs); err != nil {
		internalErr(w, err)
		return
	}
	live = map[string]any{"epoch_id": snap.EpochID, "ticks_decided": n, "errors": errs, "ticks_rl_ships": ship,
		"ticks_baseline_ships": baseShip, "agrees_with_planner_baseline": agree, "avg_latency_us": avgUs}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"mode":            map[bool]string{true: "active", false: "comparison-only"}[decision == "rl"],
		"decision_policy": decision,
		"model":           a.Meta,
		"architecture": map[string]any{"algorithm": "Maskable PPO (sb3-contrib)", "actor": "600 → 128 tanh → 128 tanh → 13 (masked)",
			"parameters": 95117, "actions": "0 = wait; 1–12 = coverage target (2h/6h/12h) × mode (urgency, captive-priority, depot-headroom, scarcity-aware)",
			"planner": "shared Go planner (internal/planner, identical to the training commit a81e90c) builds candidates, mask and features"},
		"verification": map[string]any{
			"actor_parity":      "2,304/2,304 decisions identical to SB3 choose() (4 exact scenarios × 576 ticks)",
			"end_to_end_parity": "real simulator, 4 exact scenarios × 576 ticks: 2,304/2,304 actions and masks identical, max feature diff 1.2e-7, 785 shipments posted, 0 rejected, 0 failed",
			"package":           "171/171 files SHA-256 verified; packaged unit tests and 12-episode smoke test passed"},
		"offline_heldout": []map[string]any{
			{"policy": "greedy baseline", "service_pct": 71.7757, "unmet_liters": 158396.172, "requests": 165.010},
			{"policy": "seed 11 (this model)", "service_pct": 71.7995, "unmet_liters": 158263.003, "requests": 187.255},
			{"policy": "seed 23", "service_pct": 71.7398, "unmet_liters": 158596.802, "requests": 161.725},
			{"policy": "seed 37", "service_pct": 71.7819, "unmet_liters": 158361.438, "requests": 162.305},
		},
		"live": live,
	})
}

// rlShadow lists recent shadow decisions: the policy's plan, the planner baseline's plan and greedy's recommendations.
func (s *server) rlShadow(w http.ResponseWriter, r *http.Request) {
	snap, ok := s.snapshot(w, r)
	if !ok {
		return
	}
	rows, err := s.db.Query(r.Context(), `SELECT tick, action, strategy, baseline_action, baseline_strategy, shipments,
			baseline_shipments, greedy, mask, logits, error, latency_us, created_at
		FROM rl_shadow WHERE epoch_id = $1 ORDER BY tick DESC LIMIT $2`, snap.EpochID, intParam(r.URL.Query().Get("limit"), 50, 1, 1000))
	if err != nil {
		internalErr(w, err)
		return
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (map[string]any, error) {
		var tick int
		var action, base *int
		var strategy, baseStrategy, errText *string
		var ship, baseShip, greedy, mask, logits json.RawMessage
		var lat *int64
		var at time.Time
		err := row.Scan(&tick, &action, &strategy, &base, &baseStrategy, &ship, &baseShip, &greedy, &mask, &logits, &errText, &lat, &at)
		return map[string]any{"tick": tick, "action": action, "strategy": strategy, "baseline_action": base,
			"baseline_strategy": baseStrategy, "shipments": ship, "baseline_shipments": baseShip, "greedy": greedy,
			"mask": mask, "logits": logits, "error": errText, "latency_us": lat, "created_at": at}, err
	})
	if err != nil {
		internalErr(w, err)
		return
	}
	if out == nil {
		out = []map[string]any{}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"tick": snap.World.Instance.Tick, "decisions": out})
}
