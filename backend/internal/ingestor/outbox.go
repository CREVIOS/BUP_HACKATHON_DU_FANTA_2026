package ingestor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/policy"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var outboxResults = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "outbox_results_total", Help: "Allocation submissions by result (sent|rejected|preflight_rejected|retry|failed_permanent|recovered).",
}, []string{"result"})

// maxAttempts bounds retries of transient failures (5xx, timeouts, DISPATCH_CAPACITY_EXCEEDED next tick).
const maxAttempts = 5

type outboxRow struct {
	id, recID int64
	key       string
	body      []byte
	attempts  int
}

// drainOutbox submits approved allocations, oldest first. The body is sent byte-for-byte as stored, so a retry
// after an ambiguous failure (timeout, 5xx) is an idempotent replay. Before the FIRST attempt it is re-checked
// against the current world: approval may be ticks old, and the simulator silently loses fuel on some
// requests it accepts (overflow, route disrupted at departure).
func (i *ingestor) drainOutbox(ctx context.Context) error {
	rows, err := i.db.Query(ctx, `SELECT id, recommendation_id, idempotency_key, body, attempts FROM outbox
		WHERE status = 'PENDING' ORDER BY id LIMIT 20`)
	if err != nil {
		return err
	}
	pending, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (outboxRow, error) {
		var o outboxRow
		return o, r.Scan(&o.id, &o.recID, &o.key, &o.body, &o.attempts)
	})
	if err != nil {
		return err
	}
	for _, o := range pending {
		if err := i.submit(ctx, o); err != nil {
			return err
		}
	}
	return nil
}

func (i *ingestor) submit(ctx context.Context, o outboxRow) error {
	// An earlier ambiguous attempt may have succeeded: the key is visible in the world.
	for _, a := range i.world.Allocations {
		if a.IdempotencyKey == o.key {
			outboxResults.WithLabelValues("recovered").Inc()
			return i.markSent(ctx, o, a.ID)
		}
	}
	var req store.AllocationRequest
	if err := json.Unmarshal(o.body, &req); err != nil {
		return i.markFailed(ctx, o, "REJECTED", "corrupt outbox body: "+err.Error())
	}
	if o.attempts == 0 {
		if why := policy.Validate(i.world, policy.Proposal{StationID: req.DestinationStationID, FuelType: req.FuelType,
			RouteID: req.RouteID, Quantity: req.Quantity}); len(why) > 0 {
			outboxResults.WithLabelValues("preflight_rejected").Inc()
			return i.markFailed(ctx, o, "REJECTED", "PREFLIGHT: "+strings.Join(why, "; "))
		}
	}
	var out sim.Allocation
	_, err := i.sim.PostJSON(ctx, "/v1/allocations", o.body, &out)
	var apiErr *sim.APIError
	switch {
	case err == nil:
		outboxResults.WithLabelValues("sent").Inc()
		slog.InfoContext(ctx, "allocation submitted", "allocation", out.ID, "key", o.key, "route", req.RouteID, "liters", req.Quantity)
		i.applyLocally(out)
		return i.markSent(ctx, o, out.ID)
	case errors.As(err, &apiErr) && apiErr.Status < 500 && apiErr.Code != "DISPATCH_CAPACITY_EXCEEDED":
		// A definite rejection: the request never created an allocation. Re-planning happens next tick.
		outboxResults.WithLabelValues("rejected").Inc()
		return i.markFailed(ctx, o, "REJECTED", apiErr.Code+": "+apiErr.Message)
	default:
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if o.attempts+1 >= maxAttempts {
			outboxResults.WithLabelValues("failed_permanent").Inc()
			return i.markFailed(ctx, o, "FAILED_PERMANENT", fmt.Sprintf("gave up after %d attempts: %v", maxAttempts, err))
		}
		outboxResults.WithLabelValues("retry").Inc()
		_, dbErr := i.db.Exec(ctx, `UPDATE outbox SET attempts = attempts + 1, last_error = $2, updated_at = now() WHERE id = $1`, o.id, err.Error())
		return dbErr
	}
}

// applyLocally reflects a just-created allocation in the cached world, so the next pre-flight in this drain
// counts it (in transit, depot stock, dispatch capacity) before the next snapshot shows it.
func (i *ingestor) applyLocally(a sim.Allocation) {
	a.CreatedTick = i.world.Instance.Tick
	i.world.Allocations = append(i.world.Allocations, a)
	for k := range i.world.Depots {
		if d := &i.world.Depots[k]; d.ID == a.SourceDepotID {
			inv := map[string]float64{}
			for f, v := range d.Inventory {
				inv[f] = v
			}
			inv[a.FuelType] -= a.Quantity
			d.Inventory = inv
		}
	}
}

func (i *ingestor) markSent(ctx context.Context, o outboxRow, simID int) error {
	tx, err := i.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE outbox SET status = 'SENT', sim_allocation_id = $2, attempts = attempts + 1,
		last_error = NULL, updated_at = now() WHERE id = $1`, o.id, simID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE recommendations SET status = 'SUBMITTED' WHERE id = $1`, o.recID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (i *ingestor) markFailed(ctx context.Context, o outboxRow, status, reason string) error {
	slog.WarnContext(ctx, "allocation not submitted", "key", o.key, "status", status, "reason", reason)
	tx, err := i.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE outbox SET status = $2, last_error = $3, attempts = attempts + 1, updated_at = now() WHERE id = $1`,
		o.id, status, reason); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE recommendations SET status = 'FAILED' WHERE id = $1`, o.recID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
