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

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/api"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/config"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/ingestor"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/intel"
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

	var err error
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
