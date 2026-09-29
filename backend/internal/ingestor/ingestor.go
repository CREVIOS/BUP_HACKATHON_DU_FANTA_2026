// Package ingestor is the ONLY process that talks to the simulator.
// Every cycle it snapshots the world into Postgres, runs the decision pipeline on each new tick (intel, or the
// in-process fallback), drains the allocation outbox, and executes operator commands queued by the api.
// A Postgres advisory lock makes it the single writer even if two copies run.
package ingestor

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/config"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/httpx"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/obs"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/rl"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
)

var (
	simTick         = promauto.NewGauge(prometheus.GaugeOpts{Name: "sim_tick", Help: "Latest simulator tick seen."})
	simServiceLevel = promauto.NewGauge(prometheus.GaugeOpts{Name: "sim_service_level", Help: "Simulator /v1/metrics service_level."})
	snapshotsTotal  = promauto.NewCounter(prometheus.CounterOpts{Name: "ingestor_snapshots_total", Help: "Snapshots written."})
	pollErrors      = promauto.NewCounter(prometheus.CounterOpts{Name: "ingestor_poll_errors_total", Help: "Failed poll cycles."})
)

const metricsEvery = 5 * time.Second // /v1/metrics full-scans a growing table server-side

// writerLock is the Postgres advisory lock key held by the one active ingestor.
const writerLock = 0x6675656c // "fuel"

func Run(ctx context.Context, cfg config.Config) error {
	db, err := store.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("connect db: %w", err)
	}
	defer db.Close()

	ing := &ingestor{
		db:       db,
		sim:      sim.New(cfg.SimBaseURL, cfg.SimMaxInflight, cfg.SimTimeout),
		stream:   sim.NewStream(cfg.SimBaseURL, 3*time.Second),
		intelURL: cfg.IntelURL,
		intel:    &http.Client{Timeout: 4 * time.Second, Transport: otelhttp.NewTransport(http.DefaultTransport)},
	}
	if cfg.RLShadow {
		if ing.actor, err = rl.LoadActor(); err != nil {
			return fmt.Errorf("load rl actor: %w", err)
		}
		slog.InfoContext(ctx, "rl shadow enabled", "repo", ing.actor.Meta.Repo, "revision", ing.actor.Meta.Revision, "seed", ing.actor.Meta.Seed)
	}
	mux := httpx.NewMux("ingestor", ing.healthy, false)
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	go func() {
		// Blocks until this copy is the only writer (a standby waits here, not ready).
		lock, err := acquireWriterLock(ctx, db)
		if err != nil {
			cancel(err)
			return
		}
		defer lock.Release()
		ing.leader.Store(true)
		slog.InfoContext(ctx, "writer lock acquired")
		wake := make(chan struct{}, 1)
		go ing.stream.Run(ctx, wake)
		cancel(ing.loop(ctx, cfg.PollInterval, wake, lock))
	}()
	err = httpx.Serve(ctx, cfg.HTTPAddr, httpx.Instrument(mux, 0))
	if cause := context.Cause(ctx); cause != nil && !errors.Is(cause, context.Canceled) {
		return cause
	}
	return err
}

func acquireWriterLock(ctx context.Context, db *pgxpool.Pool) (*pgxpool.Conn, error) {
	conn, err := db.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, writerLock); err != nil {
		conn.Release()
		return nil, fmt.Errorf("writer lock: %w", err)
	}
	return conn, nil
}

type ingestor struct {
	db       *pgxpool.Pool
	sim      *sim.Client
	stream   *sim.Stream
	intelURL string
	intel    *http.Client
	actor    *rl.Actor // RL policy in shadow mode; nil disables it
	leader   atomic.Bool

	world       sim.World                    // latest tick-fenced world (the outbox pre-flights against it)
	firstSupply map[string]sim.SupplyArrival // supply schedule as first seen this epoch: delay/shortfall baseline

	epochID        int64
	last           sim.Instance
	lastStale      bool
	lastWorld      [32]byte  // hash of the last persisted world
	lastEvents     [32]byte  // hash of the events at the last decision
	fellBack       bool      // the last decision used the fallback (intel unreachable)
	decidedAt      time.Time // when the last decision ran
	lastDemandTick int
	metrics        *sim.Metrics
	metricsAt      time.Time
	lastOKAt       atomic.Int64 // unix nanos of last successful poll
}

func (i *ingestor) healthy(context.Context) error {
	if !i.leader.Load() {
		return errors.New("standby: waiting for the writer lock")
	}
	if time.Since(time.Unix(0, i.lastOKAt.Load())) > 10*time.Second {
		return errors.New("no successful simulator poll in 10s")
	}
	return nil
}

// loop polls on every SSE tick (hint) and at least every `every` (fallback when SSE is down), and checks the
// command queue every 250 ms. It returns only on a fatal error (lost writer lock) or shutdown.
func (i *ingestor) loop(ctx context.Context, every time.Duration, wake <-chan struct{}, lock *pgxpool.Conn) error {
	t := time.NewTicker(250 * time.Millisecond)
	defer t.Stop()
	var lastCycle time.Time
	woke := true
	for {
		if woke || time.Since(lastCycle) >= every {
			if _, err := lock.Exec(ctx, `SELECT 1`); err != nil && ctx.Err() == nil {
				return fmt.Errorf("writer lock connection lost: %w", err) // exit; the orchestrator restarts us
			}
			i.cycle(ctx, false)
			lastCycle = time.Now()
		}
		i.runCommands(ctx)
		woke = false
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		case <-wake:
			woke = true
		}
	}
}

var tracer = otel.Tracer("github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/ingestor")

// cycle is one pass of the pipeline: snapshot, decide on a new tick (or when forced, e.g. after an operator
// injected an event), submit approved allocations. It runs under one root span, so the cycle's simulator
// calls (otelhttp), intel call, DB writes (otelpgx) and log lines (trace_id) all land in one trace.
func (i *ingestor) cycle(ctx context.Context, force bool) {
	ctx, span := tracer.Start(ctx, "ingestor.poll")
	defer span.End()
	w, changed, err := i.poll(ctx)
	if err != nil {
		if ctx.Err() == nil {
			pollErrors.Inc()
			obs.RecordPollError(ctx)
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			slog.WarnContext(ctx, "poll failed", "err", err)
		}
		return
	}
	// While on the fallback, re-decide every 5 s even without a new tick, so a paused simulator does not keep
	// the fallback (and its alert) after intel recovers, e.g. when the ingestor starts before intel is ready.
	retry := i.fellBack && time.Since(i.decidedAt) >= 5*time.Second
	if changed || force || retry {
		if err := i.decide(ctx, w); err != nil && ctx.Err() == nil {
			slog.ErrorContext(ctx, "decide failed", "tick", w.Instance.Tick, "err", err)
		}
	}
	if err := i.drainOutbox(ctx); err != nil && ctx.Err() == nil {
		slog.ErrorContext(ctx, "outbox drain failed", "err", err)
	}
}

// poll snapshots the world whenever any of it changed (so the UI sees a just-submitted allocation while
// paused). changed reports what warrants deciding again: a new tick, run state, staleness or event set.
func (i *ingestor) poll(ctx context.Context) (sim.World, bool, error) {
	w, err := i.sim.FetchWorld(ctx)
	if err != nil {
		return w, false, err
	}
	i.stream.ObserveTick(w.Instance.Tick)
	if err := w.Validate(); err != nil {
		// Reject a malformed simulator response instead of persisting it (brief §11).
		return w, false, fmt.Errorf("invalid world snapshot: %w", err)
	}
	if err := i.ensureEpoch(ctx, w); err != nil {
		return w, false, err
	}
	i.world = w
	if err := i.ingestDemand(ctx, w.Instance.Tick); err != nil {
		return w, false, fmt.Errorf("demand: %w", err)
	}
	if time.Since(i.metricsAt) > metricsEvery {
		if m, err := i.sim.FetchMetrics(ctx); err == nil {
			i.metrics, i.metricsAt = &m, time.Now()
			simServiceLevel.Set(m.ServiceLevel)
			obs.SetServiceLevel(ctx, m.ServiceLevel)
		}
	}

	worldJSON, _ := json.Marshal(w)
	eventsJSON, _ := json.Marshal(w.Events)
	worldHash, eventsHash := sha256.Sum256(worldJSON), sha256.Sum256(eventsJSON)
	changed := i.last.ScenarioID == "" || w.Instance.Tick != i.last.Tick || w.Instance.Status != i.last.Status ||
		w.Stale != i.lastStale || eventsHash != i.lastEvents
	if changed || worldHash != i.lastWorld {
		if err := i.writeSnapshot(ctx, w); err != nil {
			return w, false, err
		}
		i.lastWorld, i.lastEvents = worldHash, eventsHash
		slog.InfoContext(ctx, "sim tick", "tick", w.Instance.Tick, "status", w.Instance.Status, "epoch", i.epochID,
			"stale", w.Stale, "sse", i.stream.Connected())
	}
	i.last, i.lastStale = w.Instance, w.Stale
	if _, err := i.db.Exec(ctx, `INSERT INTO ingestor_heartbeat (id, last_ok_at, tick, status) VALUES (1, now(), $1, $2)
		ON CONFLICT (id) DO UPDATE SET last_ok_at = now(), tick = $1, status = $2`, w.Instance.Tick, w.Instance.Status); err != nil {
		return w, false, fmt.Errorf("heartbeat: %w", err)
	}
	simTick.Set(float64(w.Instance.Tick))
	obs.SetSimTick(ctx, w.Instance.Tick)
	i.lastOKAt.Store(time.Now().UnixNano())
	return w, changed, nil
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
		obs.RecordSnapshot(ctx)
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

// ensureEpoch opens a new epoch when the simulator was reset (tick went backwards, or seed/scenario changed).
// On a restart of the ingestor itself it resumes the latest matching epoch instead, so approvals, the outbox
// and alerts survive a crash.
func (i *ingestor) ensureEpoch(ctx context.Context, w sim.World) error {
	inst := w.Instance
	if i.epochID != 0 && inst.Tick >= i.last.Tick && inst.Seed == i.last.Seed && inst.ScenarioID == i.last.ScenarioID {
		return nil
	}
	if i.epochID == 0 {
		if id, ok, err := i.resumableEpoch(ctx, w); err != nil {
			return err
		} else if ok {
			i.epochID = id
			if err := i.db.QueryRow(ctx, `SELECT COALESCE(MAX(tick), 0) FROM demand_observations WHERE epoch_id = $1`, id).
				Scan(&i.lastDemandTick); err != nil {
				return err
			}
			i.firstSupply = map[string]sim.SupplyArrival{}
			var first []sim.SupplyArrival
			var raw []byte
			if err := i.db.QueryRow(ctx, `SELECT payload->'supply_arrivals' FROM snapshots WHERE epoch_id = $1 ORDER BY id LIMIT 1`, id).
				Scan(&raw); err == nil && json.Unmarshal(raw, &first) == nil {
				for _, s := range first {
					i.firstSupply[s.ID] = s
				}
			}
			slog.InfoContext(ctx, "resumed sim epoch", "epoch", id, "tick", inst.Tick)
			return nil
		}
	}
	tx, err := i.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO sim_epochs (scenario_id, scenario_version, seed) VALUES ($1,$2,$3) RETURNING id`,
		inst.ScenarioID, inst.ScenarioVersion, inst.Seed).Scan(&id); err != nil {
		return err
	}
	// The old world is gone: nothing from it may still be approved, submitted or alerted on.
	for _, q := range []string{
		`UPDATE recommendations SET status = 'EXPIRED' WHERE status = 'PROPOSED'`,
		`UPDATE outbox SET status = 'FAILED_PERMANENT', last_error = 'simulator reset before submission', updated_at = now() WHERE status = 'PENDING'`,
		`UPDATE recommendations SET status = 'FAILED' WHERE status = 'APPROVED'`,
		`UPDATE alerts SET resolved_at = now() WHERE resolved_at IS NULL`,
	} {
		if _, err := tx.Exec(ctx, q); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	i.epochID, i.lastDemandTick = id, 0
	i.firstSupply = map[string]sim.SupplyArrival{}
	slog.InfoContext(ctx, "new sim epoch", "epoch", id, "scenario", inst.ScenarioID, "seed", inst.Seed, "tick", inst.Tick)
	return nil
}

// resumableEpoch finds the latest epoch that can be the same simulator world as w: same scenario and seed,
// last snapshot not ahead of w, and every allocation we submitted in it still visible in w.
// ponytail: a reset followed by running past the old tick before we restart, with no submissions yet, is
// indistinguishable from "same world"; the simulator exposes no run id.
func (i *ingestor) resumableEpoch(ctx context.Context, w sim.World) (int64, bool, error) {
	var id int64
	var lastTick int
	err := i.db.QueryRow(ctx, `SELECT e.id, s.tick FROM sim_epochs e
		JOIN LATERAL (SELECT tick FROM snapshots WHERE epoch_id = e.id ORDER BY id DESC LIMIT 1) s ON true
		WHERE e.scenario_id = $1 AND e.seed = $2 ORDER BY e.id DESC LIMIT 1`, w.Instance.ScenarioID, w.Instance.Seed).Scan(&id, &lastTick)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && lastTick > w.Instance.Tick) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	rows, err := i.db.Query(ctx, `SELECT o.idempotency_key FROM outbox o JOIN recommendations r ON r.id = o.recommendation_id
		WHERE r.epoch_id = $1 AND o.status = 'SENT'`, id)
	if err != nil {
		return 0, false, err
	}
	keys, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return 0, false, err
	}
	seen := map[string]bool{}
	for _, a := range w.Allocations {
		seen[a.IdempotencyKey] = true
	}
	for _, k := range keys {
		if !seen[k] {
			return 0, false, nil
		}
	}
	return id, true, nil
}
