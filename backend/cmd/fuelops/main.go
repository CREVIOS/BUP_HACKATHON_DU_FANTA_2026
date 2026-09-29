// Command fuelops is the single backend binary. One image, four entrypoints:
//
//	fuelops api       operator REST API (reads Postgres, never calls the simulator)
//	fuelops ingestor  sole simulator client: snapshots + allocation outbox (single writer)
//	fuelops intel     forecasting, risk, detection, allocation policy, Jev triage
//	fuelops migrate   apply database migrations and exit
//	fuelops replay    drive a THROWAWAY simulator with /admin/step and report decision quality (eval + CI gate)
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/api"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/config"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/ingestor"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/intel"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/obs"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/store"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/version"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: fuelops api|ingestor|intel|migrate|replay")
		os.Exit(2)
	}
	cmd := os.Args[1]
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", cmd, "version", version.Version))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cfg := config.Load()

	// OpenTelemetry: traces + OTel metrics via OTLP. No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
	shutdownOTel, err := obs.Setup(ctx, "fuelops-"+cmd, version.Version)
	if err != nil {
		// Telemetry must never take the service down (brief §11): log and run without it.
		slog.Error("otel setup failed; continuing without telemetry", "err", err)
		shutdownOTel = func(context.Context) error { return nil }
	}
	defer func() {
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := shutdownOTel(sctx); err != nil {
			slog.Warn("otel shutdown", "err", err)
		}
	}()
	if obs.Enabled() {
		slog.Info("opentelemetry enabled", "endpoint", os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
	}

	switch cmd {
	case "api":
		err = api.Run(ctx, cfg)
	case "ingestor":
		err = ingestor.Run(ctx, cfg)
	case "intel":
		err = intel.Run(ctx, cfg)
	case "migrate":
		err = store.Migrate(ctx, cfg.DatabaseURL)
	case "replay":
		err = runReplay(ctx, cfg, os.Args[2:])
	default:
		err = fmt.Errorf("unknown command %q", cmd)
	}
	if err != nil {
		slog.Error("exit", "err", err)
		os.Exit(1)
	}
}
