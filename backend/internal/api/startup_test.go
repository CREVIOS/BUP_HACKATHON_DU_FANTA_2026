package api

import (
	"context"
	"strings"
	"testing"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/config"
)

func TestRunRejectsMissingTokensBeforeConnecting(t *testing.T) {
	err := Run(context.Background(), config.Config{
		RequireAuth: true,
		DatabaseURL: "not a database URL",
		HTTPAddr:    "invalid listen address",
	})
	if err == nil || !strings.Contains(err.Error(), "REQUIRE_AUTH is enabled") {
		t.Fatalf("expected authentication failure before any database/listener setup; got %v", err)
	}
}
