package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/config"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/replay"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
)

// runReplay: fuelops replay -ticks 384 -policy greedy -events final_combined [-min-service 0.999]
func runReplay(ctx context.Context, cfg config.Config, args []string) error {
	fs := flag.NewFlagSet("replay", flag.ExitOnError)
	ticks := fs.Int("ticks", 96, "ticks to simulate")
	pol := fs.String("policy", "greedy", "greedy | none")
	events := fs.String("events", "", "\"\" | final_combined")
	checks := fs.String("checkpoints", "96,192,288,384,480,576", "comma-separated ticks to record service level")
	minService := fs.Float64("min-service", 0, "fail (exit 1) if final service_level is below this")
	fs.Parse(args)

	var cps []int
	for _, s := range strings.Split(*checks, ",") {
		if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
			cps = append(cps, n)
		}
	}
	res, err := replay.Run(ctx, sim.New(cfg.SimBaseURL, cfg.SimMaxInflight, cfg.SimTimeout),
		replay.Config{Ticks: *ticks, Policy: *pol, Events: *events, Checkpoint: cps})
	if err != nil {
		return err
	}
	json.NewEncoder(os.Stdout).Encode(res)
	fmt.Fprintln(os.Stderr, res)
	if res.ServiceLevel < *minService || (*pol == "greedy" && (res.Failed > 0 || res.OverflowL > 0)) {
		return fmt.Errorf("gate failed: service_level=%.6f (min %.6f) failed=%d overflow_L=%.1f", res.ServiceLevel, *minService, res.Failed, res.OverflowL)
	}
	return nil
}
