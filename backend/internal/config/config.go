// Package config reads all runtime configuration from environment variables.
package config

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	HTTPAddr       string        // listen address for this process's HTTP server
	DatabaseURL    string        // Postgres DSN
	SimBaseURL     string        // simulator base URL; only the ingestor may call it
	SimMaxInflight int           // hard cap on concurrent simulator requests (sim wedges at ~15, see docs/PLAN.md §2 #1)
	SimTimeout     time.Duration // per-request timeout to the simulator
	PollInterval   time.Duration // ingestor fallback poll interval
	IntelURL       string        // intel service base URL (api -> intel)
	TypesafeAPIKey string        // Jev; empty = rule-based fallback only
}

func Load() Config {
	return Config{
		HTTPAddr:       env("HTTP_ADDR", ":8080"),
		DatabaseURL:    env("DATABASE_URL", "postgres://fuelops:fuelops@localhost:5432/fuelops?sslmode=disable"),
		SimBaseURL:     env("SIM_BASE_URL", "http://localhost:8000"),
		SimMaxInflight: envInt("SIM_MAX_INFLIGHT", 4),
		SimTimeout:     envDuration("SIM_TIMEOUT", 1500*time.Millisecond),
		PollInterval:   envDuration("POLL_INTERVAL", time.Second),
		IntelURL:       env("INTEL_URL", "http://localhost:8082"),
		TypesafeAPIKey: os.Getenv("TYPESAFE_API_KEY"),
	}
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
