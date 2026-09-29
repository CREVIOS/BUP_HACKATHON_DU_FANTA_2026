// Package api serves the operator frontend's REST API. It reads from Postgres and never calls the simulator:
// only the ingestor may (docs/PLAN.md §2 #1 — the simulator wedges at ~15 concurrent requests).
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
	s := &server{db: db, intelURL: cfg.IntelURL, http: &http.Client{Timeout: time.Second, Transport: otelhttp.NewTransport(http.DefaultTransport)}}
	mux := httpx.NewMux("api", func(ctx context.Context) error { return db.Ping(ctx) }, cfg.FailHealth)
	mux.HandleFunc("GET /api/state", s.state)
	mux.HandleFunc("GET /api/status", s.status)
	registerDocs(mux) // /openapi.yaml, /docs (Swagger UI), /redoc
	logChaos(cfg)
	return httpx.Serve(ctx, cfg.HTTPAddr, httpx.Instrument(mux, cfg.Chaos500Pct))
}

type server struct {
	db       *pgxpool.Pool
	intelURL string
	http     *http.Client
}

// state returns the latest snapshot. TODO(P1): stations, depots, risk, recommendations.
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

// status is the brief's §15 "System Status" panel: health of every component.
func (s *server) status(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	out := map[string]string{"backend_api": "healthy"}

	out["database"] = health(s.db.Ping(ctx))

	// Judged by the ingestor's last successful poll, not the last new tick: a PAUSED simulator is healthy.
	var age float64
	err := s.db.QueryRow(ctx, `SELECT EXTRACT(EPOCH FROM now() - last_ok_at) FROM ingestor_heartbeat WHERE id = 1`).Scan(&age)
	if errors.Is(err, pgx.ErrNoRows) {
		err = errors.New("ingestor has not polled the simulator yet")
	} else if err == nil && age > 10 {
		err = fmt.Errorf("no successful simulator poll for %.0fs", age)
	}
	out["fuel_simulator"] = health(err)

	out["decision_engine"] = health(s.ping(ctx, s.intelURL+"/healthz"))
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

func logChaos(cfg config.Config) {
	if c := httpx.ChaosEnabled(cfg.Chaos500Pct, cfg.FailHealth); c != "" {
		slog.Warn("chaos flags enabled", "flags", c)
	}
}
