package sim

import (
	"strings"
	"time"
)

// Instance mirrors GET /v1/instance.
type Instance struct {
	ID              int    `json:"id"`
	ScenarioID      string `json:"scenario_id"`
	ScenarioVersion string `json:"scenario_version"`
	Seed            int64  `json:"seed"`
	SimTime         string `json:"sim_time"`
	Tick            int    `json:"tick"`
	TickMinutes     int    `json:"tick_minutes"`
	Status          string `json:"status"` // PAUSED | RUNNING
}

// ParseSimTime parses sim_time. The simulator emits it WITHOUT a UTC offset
// (SQLite drops tz info) even though the guide shows "+00:00"; both are accepted as UTC.
func ParseSimTime(s string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC(), nil
	}
	return time.ParseInLocation("2006-01-02T15:04:05.999999999", strings.TrimSpace(s), time.UTC)
}
