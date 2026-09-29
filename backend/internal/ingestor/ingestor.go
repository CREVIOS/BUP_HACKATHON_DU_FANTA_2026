// Package ingestor is the ONLY process that talks to the simulator.
// It snapshots simulator state into Postgres and (next) drains the allocation outbox as the single writer.
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
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	simTick         = promauto.NewGauge(prometheus.GaugeOpts{Name: "sim_tick", Help: "Latest simulator tick seen."})
	simServiceLevel = promauto.NewGauge(prometheus.GaugeOpts{Name: "sim_service_level", Help: "Simulator /v1/metrics service_level."})
	snapshotsTotal  = promauto.NewCounter(prometheus.CounterOpts{Name: "ingestor_snapshots_total", Help: "Snapshots written."})
	pollErrors      = promauto.NewCounter(prometheus.CounterOpts{Name: "ingestor_poll_errors_total", Help: "Failed poll cycles."})
)

const metricsEvery = 5 * time.Second // /v1/metrics full-scans a growing table server-side

// TODO(P1): outbox worker behind a Postgres advisory lock (single writer to POST /v1/allocations).
func Run(ctx context.Context, cfg config.Config) error {
	db, err := store.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("connect db: %w", err)
	}
	defer db.Close()

	ing := &ingestor{
		db:     db,
		sim:    sim.New(cfg.SimBaseURL, cfg.SimMaxInflight, cfg.SimTimeout),
		stream: sim.NewStream(cfg.SimBaseURL, 3*time.Second),
	}
	wake := make(chan struct{}, 1)
	go ing.stream.Run(ctx, wake)
	go ing.loop(ctx, cfg.PollInterval, wake)

	mux := httpx.NewMux("ingestor", ing.healthy, false)
	return httpx.Serve(ctx, cfg.HTTPAddr, httpx.Instrument(mux, 0))
}

type ingestor struct {
	db     *pgxpool.Pool
	sim    *sim.Client
	stream *sim.Stream

	epochID        int64
	last           sim.Instance
	lastStale      bool
	lastDemandTick int
	metrics        *sim.Metrics
	metricsAt      time.Time
	lastOKAt       atomic.Int64 // unix nanos of last successful poll
}

func (i *ingestor) healthy(context.Context) error {
	if time.Since(time.Unix(0, i.lastOKAt.Load())) > 10*time.Second {
		return errors.New("no successful simulator poll in 10s")
	}
	return nil
}

// loop polls on every SSE tick (hint) and at least every `every` (fallback when SSE is down).
func (i *ingestor) loop(ctx context.Context, every time.Duration, wake <-chan struct{}) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if err := i.poll(ctx); err != nil && ctx.Err() == nil {
			pollErrors.Inc()
			slog.Warn("poll failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-wake:
		}
	}
}

func (i *ingestor) poll(ctx context.Context) error {
	w, err := i.sim.FetchWorld(ctx)
	if err != nil {
		return err
	}
	i.stream.ObserveTick(w.Instance.Tick)
	if err := i.ensureEpoch(ctx, w.Instance); err != nil {
		return err
	}
	if err := i.ingestDemand(ctx, w.Instance.Tick); err != nil {
		return fmt.Errorf("demand: %w", err)
	}
	if time.Since(i.metricsAt) > metricsEvery {
		if m, err := i.sim.FetchMetrics(ctx); err == nil {
			i.metrics, i.metricsAt = &m, time.Now()
			simServiceLevel.Set(m.ServiceLevel)
		}
	}

	changed := w.Instance.Tick != i.last.Tick || w.Instance.Status != i.last.Status || w.Stale != i.lastStale
	if changed {
		if err := i.writeSnapshot(ctx, w); err != nil {
			return err
		}
		slog.Info("sim tick", "tick", w.Instance.Tick, "status", w.Instance.Status, "epoch", i.epochID,
			"stale", w.Stale, "sse", i.stream.Connected())
	}
	i.last, i.lastStale = w.Instance, w.Stale
	simTick.Set(float64(w.Instance.Tick))
	i.lastOKAt.Store(time.Now().UnixNano())
	return nil
}

func (i *ingestor) writeSnapshot(ctx context.Context, w sim.World) error {
	simTime, err := sim.ParseSimTime(w.Instance.SimTime)
	if err != nil {
		return fmt.Errorf("invalid sim_time %q: %w", w.Instance.SimTime, err)
	}
	payload, err := json.Marshal(struct {
		sim.World
		Metrics *sim.Metrics `json:"metrics,omitempty"`
	}{w, i.metrics})
	if err != nil {
		return err
	}
	_, err = i.db.Exec(ctx,
		`INSERT INTO snapshots (epoch_id, tick, sim_time, stale, payload) VALUES ($1,$2,$3,$4,$5)`,
		i.epochID, w.Instance.Tick, simTime, w.Stale, payload)
	if err == nil {
		snapshotsTotal.Inc()
	}
	return err
}

// ingestDemand mirrors new /v1/demand-history rows. The endpoint returns newest-first with a limit
// clamped to 2000 (=166 ticks), so the limit is sized from ticks elapsed since the last read.
func (i *ingestor) ingestDemand(ctx context.Context, tick int) error {
	if tick <= i.lastDemandTick {
		return nil
	}
	rows, err := i.sim.FetchDemand(ctx, 12*(tick-i.lastDemandTick)+12)
	if err != nil {
		return err
	}
	b := &pgx.Batch{}
	for _, r := range rows {
		t, err := sim.ParseSimTime(r.SimTime)
		if err != nil {
			return fmt.Errorf("invalid demand sim_time %q: %w", r.SimTime, err)
		}
		b.Queue(`INSERT INTO demand_observations
			(epoch_id, sim_id, station_id, fuel_type, tick, sim_time, demand_liters, served_liters, unmet_liters)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
			i.epochID, r.ID, r.StationID, r.FuelType, r.Tick, t, r.DemandLiters, r.ServedLiters, r.UnmetLiters)
	}
	if err := i.db.SendBatch(ctx, b).Close(); err != nil {
		return err
	}
	i.lastDemandTick = tick
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
		i.lastDemandTick = 0
		slog.Info("new sim epoch", "epoch", i.epochID, "scenario", inst.ScenarioID, "seed", inst.Seed, "tick", inst.Tick)
	}
	return err
}
