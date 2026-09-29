// Package ingestor is the ONLY process that talks to the simulator.
// It snapshots simulator state into Postgres and (later) drains the allocation outbox as the single writer.
package ingestor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/config"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/httpx"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var simTick = promauto.NewGauge(prometheus.GaugeOpts{Name: "sim_tick", Help: "Latest simulator tick seen."})

// TODO(P1): SSE consumer + zombie watchdog, full snapshot (stations, depots, routes, events, allocations, supply),
// tick fence (read /v1/instance before and after), outbox worker behind a Postgres advisory lock.
func Run(ctx context.Context, cfg config.Config) error {
	db, err := store.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("connect db: %w", err)
	}
	defer db.Close()

	ing := &ingestor{db: db, sim: sim.New(cfg.SimBaseURL, cfg.SimMaxInflight, cfg.SimTimeout)}
	go ing.loop(ctx, cfg.PollInterval)

	mux := httpx.NewMux("ingestor", ing.healthy, false)
	return httpx.Serve(ctx, cfg.HTTPAddr, httpx.Instrument(mux, 0))
}

type ingestor struct {
	db       *pgxpool.Pool
	sim      *sim.Client
	epochID  int64
	last     sim.Instance
	lastOKAt atomic.Int64 // unix nanos of last successful poll
}

func (i *ingestor) healthy(ctx context.Context) error {
	if time.Since(time.Unix(0, i.lastOKAt.Load())) > 10*time.Second {
		return errors.New("no successful simulator poll in 10s")
	}
	return nil
}

func (i *ingestor) loop(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if err := i.poll(ctx); err != nil && ctx.Err() == nil {
			slog.Warn("poll failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (i *ingestor) poll(ctx context.Context) error {
	var inst sim.Instance
	meta, err := i.sim.GetJSON(ctx, "/v1/instance", &inst)
	if err != nil {
		return err
	}
	if err := i.ensureEpoch(ctx, inst); err != nil {
		return err
	}
	simTime, err := sim.ParseSimTime(inst.SimTime)
	if err != nil {
		return fmt.Errorf("invalid sim_time %q: %w", inst.SimTime, err)
	}
	payload, _ := json.Marshal(map[string]any{"instance": inst})
	if _, err := i.db.Exec(ctx,
		`INSERT INTO snapshots (epoch_id, tick, sim_time, stale, payload) VALUES ($1,$2,$3,$4,$5)`,
		i.epochID, inst.Tick, simTime, meta.Stale, payload); err != nil {
		return err
	}
	if inst.Tick != i.last.Tick || inst.Status != i.last.Status {
		slog.Info("sim tick", "tick", inst.Tick, "status", inst.Status, "sim_time", inst.SimTime, "epoch", i.epochID, "stale", meta.Stale)
	}
	i.last = inst
	simTick.Set(float64(inst.Tick))
	i.lastOKAt.Store(time.Now().UnixNano())
	return nil
}

// ensureEpoch opens a new epoch on first contact or when the simulator was reset
// (tick went backwards, or seed/scenario changed).
func (i *ingestor) ensureEpoch(ctx context.Context, inst sim.Instance) error {
	reset := i.epochID == 0 || inst.Tick < i.last.Tick || inst.Seed != i.last.Seed || inst.ScenarioID != i.last.ScenarioID
	if !reset {
		return nil
	}
	err := i.db.QueryRow(ctx,
		`INSERT INTO sim_epochs (scenario_id, seed) VALUES ($1,$2) RETURNING id`,
		inst.ScenarioID, inst.Seed).Scan(&i.epochID)
	if err == nil {
		slog.Info("new sim epoch", "epoch", i.epochID, "scenario", inst.ScenarioID, "seed", inst.Seed, "tick", inst.Tick)
	}
	return err
}
