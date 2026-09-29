// Package intel hosts forecasting, stockout risk, detection, the allocation policy and Jev review triage.
// It is stateless and deliberately killable: the api falls back to a rule-based policy when it is down.
package intel

import (
	"context"
	"log/slog"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/config"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/httpx"
)

// TODO(P1/P3): POST /v1/recommendations — forecast, projection + ensemble risk, safe greedy, impact, Jev triage.
func Run(ctx context.Context, cfg config.Config) error {
	mux := httpx.NewMux("intel", nil, cfg.FailHealth)
	if c := httpx.ChaosEnabled(cfg.Chaos500Pct, cfg.FailHealth); c != "" {
		slog.WarnContext(ctx, "chaos flags enabled", "flags", c)
	}
	return httpx.Serve(ctx, cfg.HTTPAddr, httpx.Instrument(mux, cfg.Chaos500Pct))
}
