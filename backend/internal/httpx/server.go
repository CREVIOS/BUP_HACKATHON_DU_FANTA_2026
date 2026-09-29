// Package httpx holds the HTTP plumbing shared by every fuelops process:
// /healthz, /version, /metrics, JSON helpers and graceful shutdown.
package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/version"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// NewMux returns a mux with the standard endpoints. /healthz means "ready to serve" (readiness probe;
// liveness is TCP). healthy reports readiness; nil means always ready. failHealth forces 503 (rollback demo).
func NewMux(service string, healthy func(context.Context) error, failHealth bool) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if failHealth {
			WriteJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unhealthy", "error": "FAIL_HEALTH set"})
			return
		}
		if healthy != nil {
			if err := healthy(r.Context()); err != nil {
				WriteJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unhealthy", "error": err.Error()})
				return
			}
		}
		WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /version", func(w http.ResponseWriter, r *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]string{"service": service, "version": version.Version})
	})
	mux.Handle("GET /metrics", promhttp.Handler())
	return mux
}

func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// Serve runs srv until ctx is cancelled, then drains in-flight requests.
func Serve(ctx context.Context, addr string, h http.Handler) error {
	srv := &http.Server{Addr: addr, Handler: h, ReadHeaderTimeout: 5 * time.Second}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	slog.InfoContext(ctx, "http listening", "addr", addr)
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}
