package ingestor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5"
)

// Command payloads, as the api validated and queued them (api/admin.go).
type (
	StepCommand struct {
		Count int `json:"count"`
	}
	EventCommand struct {
		Type          string         `json:"type"`
		StartTick     *int           `json:"start_tick"` // absolute; nil = current tick + StartIn
		StartIn       int            `json:"start_in"`
		DurationTicks int            `json:"duration_ticks"`
		Parameters    map[string]any `json:"parameters"`
	}
	FaultCommand struct {
		Type            string         `json:"type"`
		DurationSeconds int            `json:"duration_seconds"`
		Parameters      map[string]any `json:"parameters"`
	}
	CancelCommand struct {
		AllocationID int `json:"allocation_id"`
	}
)

// runCommands executes queued operator commands in order. Commands run inside the ingestor so the simulator
// keeps exactly one client with a bounded number of in-flight requests.
func (i *ingestor) runCommands(ctx context.Context) {
	for ctx.Err() == nil {
		var id int64
		var kind string
		var payload []byte
		err := i.db.QueryRow(ctx, `SELECT id, kind, payload FROM sim_commands WHERE status = 'PENDING' ORDER BY id LIMIT 1`).
			Scan(&id, &kind, &payload)
		if errors.Is(err, pgx.ErrNoRows) {
			return
		}
		if err != nil {
			slog.WarnContext(ctx, "read command queue", "err", err)
			return
		}
		result, execErr := i.exec(ctx, kind, payload)
		status, errText := "DONE", ""
		if execErr != nil {
			status, errText = "FAILED", execErr.Error()
		}
		res, _ := json.Marshal(result)
		if _, err := i.db.Exec(ctx, `UPDATE sim_commands SET status = $2, result = $3, error = NULLIF($4, ''), done_at = now() WHERE id = $1`,
			id, status, res, errText); err != nil {
			slog.ErrorContext(ctx, "record command result", "id", id, "err", err)
			return
		}
		slog.InfoContext(ctx, "command executed", "id", id, "kind", kind, "status", status, "err", errText)
	}
}

func (i *ingestor) exec(ctx context.Context, kind string, payload []byte) (any, error) {
	switch kind {
	case "step":
		var c StepCommand
		if err := json.Unmarshal(payload, &c); err != nil {
			return nil, err
		}
		// One tick at a time, deciding and submitting after each, exactly as if the simulator were running.
		for n := 0; n < max(c.Count, 1); n++ {
			if _, err := i.sim.PostOnce(ctx, "/admin/step", nil, nil); err != nil {
				return map[string]any{"stepped": n, "tick": i.world.Instance.Tick}, err
			}
			i.cycle(ctx, false)
		}
		return map[string]any{"stepped": max(c.Count, 1), "tick": i.world.Instance.Tick}, nil
	case "run", "pause", "reset":
		if _, err := i.sim.PostOnce(ctx, "/admin/"+kind, nil, nil); err != nil {
			return nil, err
		}
		i.cycle(ctx, true)
		return map[string]any{"tick": i.world.Instance.Tick, "status": i.world.Instance.Status}, nil
	case "faults_clear":
		if _, err := i.sim.PostOnce(ctx, "/admin/faults/clear", nil, nil); err != nil {
			return nil, err
		}
		return map[string]any{"status": "cleared"}, nil
	case "event":
		var c EventCommand
		if err := json.Unmarshal(payload, &c); err != nil {
			return nil, err
		}
		start := i.world.Instance.Tick + c.StartIn
		if c.StartTick != nil {
			start = *c.StartTick
		}
		body, _ := json.Marshal(map[string]any{"type": c.Type, "start_tick": start, "duration_ticks": c.DurationTicks, "parameters": c.Parameters})
		var out map[string]any
		if _, err := i.sim.PostOnce(ctx, "/admin/events", body, &out); err != nil {
			return nil, err
		}
		i.cycle(ctx, true) // react now: cancel doomed allocations, re-alert
		return out, nil
	case "fault":
		var c FaultCommand
		if err := json.Unmarshal(payload, &c); err != nil {
			return nil, err
		}
		body, _ := json.Marshal(map[string]any{"type": c.Type, "duration_seconds": c.DurationSeconds, "parameters": c.Parameters})
		var out map[string]any
		if _, err := i.sim.PostOnce(ctx, "/admin/faults", body, &out); err != nil {
			return nil, err
		}
		return out, nil
	case "cancel_allocation":
		var c CancelCommand
		if err := json.Unmarshal(payload, &c); err != nil {
			return nil, err
		}
		var out map[string]any
		if _, err := i.sim.PostJSON(ctx, fmt.Sprintf("/v1/allocations/%d/cancel", c.AllocationID), nil, &out); err != nil {
			return nil, err
		}
		i.cycle(ctx, true)
		return out, nil
	}
	return nil, fmt.Errorf("unknown command kind %q", kind)
}
