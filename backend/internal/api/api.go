// Package api serves the operator frontend's REST API. It reads from Postgres and never calls the simulator:
// only the ingestor may (docs/PLAN.md §2 #1 — the simulator wedges at ~15 concurrent requests). Operator and
// admin actions are written to Postgres (outbox, sim_commands) for the ingestor to carry out.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/config"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/httpx"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

func Run(ctx context.Context, cfg config.Config) error {
	db, err := store.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("connect db: %w", err)
	}
	defer db.Close()

	// otelhttp.NewTransport propagates trace context to intel and emits client spans.
	s := &server{
		db: db, intelURL: cfg.IntelURL, jevConfigured: cfg.TypesafeAPIKey != "",
		http: &http.Client{Timeout: time.Second, Transport: otelhttp.NewTransport(http.DefaultTransport)},
		auth: auth{operator: cfg.OperatorToken, admin: cfg.AdminToken}, hub: newHub(),
	}
	if !s.auth.enabled() {
		slog.WarnContext(ctx, "OPERATOR_TOKEN and ADMIN_TOKEN unset: auth is OFF, every caller is admin (local dev only)")
	}
	mux := httpx.NewMux("api", func(ctx context.Context) error { return db.Ping(ctx) }, cfg.FailHealth)
	s.routes(mux)
	registerDocs(mux) // /openapi.yaml, /docs (Swagger UI), /redoc
	logChaos(ctx, cfg)
	go s.hub.run(ctx, db)
	return httpx.Serve(ctx, cfg.HTTPAddr, s.latency.wrap(httpx.Instrument(mux, cfg.Chaos500Pct)))
}

// routes registers every endpoint and returns the patterns (the docs test checks each is in openapi.yaml).
func (s *server) routes(mux *http.ServeMux) []string {
	var patterns []string
	handle := func(pattern string, h http.HandlerFunc) {
		mux.HandleFunc(pattern, h)
		patterns = append(patterns, pattern)
	}
	op, admin := func(h http.HandlerFunc) http.HandlerFunc { return s.auth.require(roleOperator, h) },
		func(h http.HandlerFunc) http.HandlerFunc { return s.auth.require(roleAdmin, h) }

	// Situation awareness (read-only, brief §6).
	handle("GET /api/state", s.state)
	handle("GET /api/status", s.status)
	handle("GET /api/overview", s.overview)
	handle("GET /api/network", s.network)
	handle("GET /api/risk", s.risk)
	handle("GET /api/demand", s.demand)
	handle("GET /api/demand/regions", s.regionalDemand)
	handle("GET /api/supply", s.supply)
	handle("GET /api/events", s.events)
	handle("GET /api/allocations", s.allocations)
	handle("GET /api/alerts", s.alerts)
	handle("GET /api/decisions", s.decisions)
	handle("GET /api/intel/quality", s.quality)
	handle("GET /api/stream", s.stream)
	handle("GET /api/me", s.auth.me)

	// Decisions (brief §9: inspectable recommendations, human review).
	handle("GET /api/recommendations", s.listRecommendations)
	handle("GET /api/recommendations/{id}", s.getRecommendation)
	handle("POST /api/recommendations/{id}/approve", op(s.approve))
	handle("POST /api/recommendations/{id}/reject", op(s.reject))
	handle("POST /api/simulate", s.simulate)
	handle("POST /api/allocations", op(s.manualAllocation))
	handle("POST /api/allocations/{id}/cancel", op(s.cancelAllocation))
	handle("POST /api/alerts/{id}/ack", op(s.ackAlert))

	// Policy and scenario control (admin).
	handle("GET /api/policy", s.getPolicy)
	handle("PUT /api/policy", admin(s.putPolicy))
	handle("POST /api/admin/sim/step", admin(s.simStep))
	handle("POST /api/admin/sim/run", admin(s.simSimple("run")))
	handle("POST /api/admin/sim/pause", admin(s.simSimple("pause")))
	handle("POST /api/admin/sim/reset", admin(s.simSimple("reset")))
	handle("POST /api/admin/sim/events", admin(s.simEvent))
	handle("POST /api/admin/sim/faults", admin(s.simFault))
	handle("POST /api/admin/sim/faults/clear", admin(s.simSimple("faults_clear")))
	handle("GET /api/admin/commands", admin(s.listCommands))
	handle("GET /api/admin/commands/{id}", admin(s.getCommand))
	return patterns
}

type server struct {
	db            *pgxpool.Pool
	intelURL      string
	jevConfigured bool
	http          *http.Client
	auth          auth
	latency       window
	hub           *hub
}

// apiError is the one error shape of this API.
type apiError struct {
	Code    string   `json:"code"`
	Message string   `json:"message"`
	Details []string `json:"details,omitempty"`
}

func writeErr(w http.ResponseWriter, status int, code, msg string, details ...string) {
	httpx.WriteJSON(w, status, map[string]apiError{"error": {Code: code, Message: msg, Details: details}})
}

func internalErr(w http.ResponseWriter, err error) {
	slog.Error("api error", "err", err)
	writeErr(w, http.StatusInternalServerError, "INTERNAL", err.Error())
}

// decode reads a JSON body (max 64 KiB), rejecting unknown fields so typos fail loudly.
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "INVALID_BODY", err.Error())
		return false
	}
	return true
}

// snapshot loads the latest world, answering 503 itself when there is none yet.
func (s *server) snapshot(w http.ResponseWriter, r *http.Request) (store.Snapshot, bool) {
	snap, err := store.LatestSnapshot(r.Context(), s.db)
	if errors.Is(err, pgx.ErrNoRows) {
		writeErr(w, http.StatusServiceUnavailable, "NO_SNAPSHOT", "the ingestor has not read the simulator yet")
		return snap, false
	}
	if err != nil {
		internalErr(w, err)
		return snap, false
	}
	return snap, true
}

// state returns the latest raw snapshot.
func (s *server) state(w http.ResponseWriter, r *http.Request) {
	var tick int
	var stale bool
	var payload json.RawMessage
	var capturedAt time.Time
	err := s.db.QueryRow(r.Context(),
		`SELECT tick, stale, payload, captured_at FROM snapshots ORDER BY id DESC LIMIT 1`).
		Scan(&tick, &stale, &payload, &capturedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"tick": nil})
		return
	}
	if err != nil {
		httpx.WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"tick": tick, "stale": stale, "captured_at": capturedAt, "age_seconds": time.Since(capturedAt).Seconds(), "snapshot": payload,
	})
}

// status is the brief's §15 "System Status" panel: health of every component plus API latency and errors.
// Component values are "healthy", "degraded: <reason>" or "unhealthy: <reason>".
func (s *server) status(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	out := map[string]any{"backend_api": "healthy"}

	out["database"] = health(s.db.Ping(ctx))

	// Judged by the ingestor's last successful poll, not the last new tick: a PAUSED simulator is healthy.
	var age float64
	err := s.db.QueryRow(ctx, `SELECT EXTRACT(EPOCH FROM now() - last_ok_at) FROM ingestor_heartbeat WHERE id = 1`).Scan(&age)
	if errors.Is(err, pgx.ErrNoRows) {
		err = errors.New("ingestor has not polled the simulator yet")
	} else if err == nil && age > 10 {
		err = fmt.Errorf("no successful simulator poll for %.0fs", age)
	}
	sim := health(err)
	if err == nil {
		var stale bool
		if s.db.QueryRow(ctx, `SELECT stale FROM snapshots ORDER BY id DESC LIMIT 1`).Scan(&stale) == nil && stale {
			sim = "degraded: simulator reports stale data"
		}
	}
	out["fuel_simulator"] = sim

	intelErr := s.ping(ctx, s.intelURL+"/healthz")
	out["prediction_service"] = health(intelErr)
	engine := health(intelErr)
	if intelErr != nil {
		engine = "degraded: fallback policy active (" + intelErr.Error() + ")"
	}
	out["decision_engine"] = engine
	out["jev"] = map[bool]string{true: "configured", false: "disabled: fixed review rule only"}[s.jevConfigured]
	var jevDown bool
	if s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM alerts WHERE kind = 'jev_unavailable' AND resolved_at IS NULL)`).Scan(&jevDown) == nil && jevDown {
		out["jev"] = "degraded: unavailable, fixed review rule deciding"
	}
	p95, errRate, n := s.latency.stats()
	out["p95_latency_ms"], out["error_rate"], out["requests_5m"] = p95, errRate, n
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (s *server) ping(ctx context.Context, url string) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := s.http.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	return nil
}

func health(err error) string {
	if err != nil {
		return "unhealthy: " + err.Error()
	}
	return "healthy"
}

func logChaos(ctx context.Context, cfg config.Config) {
	if c := httpx.ChaosEnabled(cfg.Chaos500Pct, cfg.FailHealth); c != "" {
		slog.WarnContext(ctx, "chaos flags enabled", "flags", c)
	}
}
