// Package version holds the build version, set at link time:
// go build -ldflags "-X github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/version.Version=$(git rev-parse --short HEAD)"
package version

var Version = "dev"
