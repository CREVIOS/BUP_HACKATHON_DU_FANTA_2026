package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
	"github.com/jackc/pgx/v5"
)

// Querier is satisfied by *pgxpool.Pool, *pgx.Conn and pgx.Tx.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// AllocationRequest is the exact POST /v1/allocations body. It is serialized once and stored in the outbox,
// so every retry is byte-identical under the same idempotency key (the simulator compares fields exactly).
type AllocationRequest struct {
	IdempotencyKey       string  `json:"idempotency_key"`
	SourceDepotID        string  `json:"source_depot_id"`
	DestinationStationID string  `json:"destination_station_id"`
	RouteID              string  `json:"route_id"`
	FuelType             string  `json:"fuel_type"`
	Quantity             float64 `json:"quantity"`
}

// Enqueue queues an approved recommendation for submission. The ingestor's outbox worker is the only sender.
// The key is epoch-scoped: allocation ids and keys restart when the simulator is reset.
func Enqueue(ctx context.Context, tx pgx.Tx, epochID, recID int64, depot, station, route, fuel string, qty float64) error {
	req := AllocationRequest{
		IdempotencyKey: fmt.Sprintf("fuelops-e%d-r%d", epochID, recID), SourceDepotID: depot,
		DestinationStationID: station, RouteID: route, FuelType: fuel, Quantity: qty,
	}
	body, err := json.Marshal(req)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO outbox (recommendation_id, idempotency_key, body) VALUES ($1,$2,$3)`, recID, req.IdempotencyKey, body)
	return err
}

// Snapshot is the latest persisted world plus its bookkeeping.
type Snapshot struct {
	EpochID    int64
	Tick       int
	Stale      bool
	CapturedAt time.Time
	World      sim.World
	Metrics    *sim.Metrics
}

// LatestSnapshot returns the newest snapshot; pgx.ErrNoRows before the first poll.
func LatestSnapshot(ctx context.Context, q Querier) (Snapshot, error) {
	var s Snapshot
	var payload []byte
	err := q.QueryRow(ctx, `SELECT epoch_id, tick, stale, captured_at, payload FROM snapshots ORDER BY id DESC LIMIT 1`).
		Scan(&s.EpochID, &s.Tick, &s.Stale, &s.CapturedAt, &payload)
	if err != nil {
		return s, err
	}
	var m struct {
		Metrics *sim.Metrics `json:"metrics"`
	}
	if err := json.Unmarshal(payload, &s.World); err != nil {
		return s, fmt.Errorf("decode snapshot: %w", err)
	}
	_ = json.Unmarshal(payload, &m)
	s.Metrics = m.Metrics
	return s, nil
}
