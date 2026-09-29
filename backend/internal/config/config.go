// Package config reads all runtime configuration from environment variables.
package config

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	HTTPAddr       string        // listen address for this process's HTTP server
	DatabaseURL    string        // Postgres DSN
	SimBaseURL     string        // simulator base URL; only the ingestor may call it
	SimMaxInflight int           // hard cap on concurrent simulator requests (sim wedges at ~15, see docs/PLAN.md §2 #1)
	SimTimeout     time.Duration // per-request timeout to the simulator (5 s: a slow simulator is degraded, not down)
	PollInterval   time.Duration // ingestor fallback poll interval
	IntelURL       string        // intel service base URL (api -> intel)
	TypesafeAPIKey string        // Jev; empty = rule-based fallback only
	OpenAIAPIKey   string        // OPENAI_API_KEY; enables the llm.Client (internal/llm); empty = client disabled
	OpenAIModel    string        // OPENAI_MODEL; empty = llm package default
	OpenAIBaseURL  string        // OPENAI_BASE_URL; empty = api.openai.com (set for Azure/proxy/gateway)
	OperatorToken  string        // bearer token for operator actions (approve/reject/allocate/cancel); empty + no admin token = auth off
	AdminToken     string        // bearer token for admin actions (sim control, crisis/fault injection, policy settings)
	RequireAuth    bool          // deployed API refuses startup without both tokens; local development may omit this
	RLShadow       bool          // run the trained RL policy in shadow mode (never executes); default on
	Chaos500Pct    int           // rollback demo: % of non-probe requests answered with 500
	FailHealth     bool          // rollback demo: /healthz always 503
}

func Load() Config {
	return Config{
		HTTPAddr:       env("HTTP_ADDR", ":8080"),
		DatabaseURL:    env("DATABASE_URL", "postgres://fuelops:fuelops@localhost:5432/fuelops?sslmode=disable"),
		SimBaseURL:     env("SIM_BASE_URL", "http://localhost:8000"),
		SimMaxInflight: envInt("SIM_MAX_INFLIGHT", 4),
		SimTimeout:     envDuration("SIM_TIMEOUT", 5*time.Second),
		PollInterval:   envDuration("POLL_INTERVAL", time.Second),
		IntelURL:       env("INTEL_URL", "http://localhost:8082"),
		TypesafeAPIKey: os.Getenv("TYPESAFE_API_KEY"),
		OpenAIAPIKey:   os.Getenv("OPENAI_API_KEY"),
		OpenAIModel:    os.Getenv("OPENAI_MODEL"),
		OpenAIBaseURL:  os.Getenv("OPENAI_BASE_URL"),
		OperatorToken:  os.Getenv("OPERATOR_TOKEN"),
		AdminToken:     os.Getenv("ADMIN_TOKEN"),
		RequireAuth:    os.Getenv("REQUIRE_AUTH") != "" && os.Getenv("REQUIRE_AUTH") != "false",
		RLShadow:       os.Getenv("RL_SHADOW") != "false",
		Chaos500Pct:    min(envInt("CHAOS_500_PCT", 0), 100),
		FailHealth:     os.Getenv("FAIL_HEALTH") == "true" || os.Getenv("FAIL_HEALTH") == "1",
	}
}

// ValidateAPIAuth runs before the API connects to its database or opens a listener.
// Treat any nonempty REQUIRE_AUTH value except "false" as enabled so a typo
// cannot silently disable the deployment's authentication requirement.
func (c Config) ValidateAPIAuth() error {
	if c.RequireAuth && (strings.TrimSpace(c.OperatorToken) == "" || strings.TrimSpace(c.AdminToken) == "") {
		return errors.New("REQUIRE_AUTH is enabled: OPERATOR_TOKEN and ADMIN_TOKEN must both be nonempty")
	}
	return nil
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(k)); err == nil && v > 0 {
		return v
	}
	return def
}

func envDuration(k string, def time.Duration) time.Duration {
	if v, err := time.ParseDuration(os.Getenv(k)); err == nil && v > 0 {
		return v
	}
	return def
}
