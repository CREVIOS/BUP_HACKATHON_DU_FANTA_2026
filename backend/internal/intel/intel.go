// Package intel hosts forecasting, stockout risk, detection, the allocation policy and Jev review triage.
// It is stateless and deliberately killable: the api falls back to a rule-based policy when it is down.
package intel

import (
	"context"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/config"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/httpx"
)

// TODO(P1/P3): POST /v1/recommendations — forecast, projection + ensemble risk, safe greedy, impact, Jev triage.
func Run(ctx context.Context, cfg config.Config) error {
	mux := httpx.NewMux("intel", nil)
	return httpx.Serve(ctx, cfg.HTTPAddr, mux)
}
