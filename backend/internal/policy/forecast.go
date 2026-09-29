// Package policy is the decision core: demand forecast, inventory projection, stockout risk and the
// safe greedy allocation planner. Pure functions over a sim.World — no I/O — so intel (primary) and the
// fallback path run identical, testable logic.
package policy

import (
	"time"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
)

// profile is the published demand model (simulator guide §8.5–8.6). The simulator does not expose these
// over the API; they are documented constants, so hard-coding them is using the spec, not the source.
type profile struct {
	daily map[string]float64 // liters per simulated day
	noise float64            // demand jitter is uniform in [1-noise, 1+noise]
	hour  func(h int) float64
}

var profiles = map[string]profile{
	"urban_high": {map[string]float64{"DIESEL": 8500, "PETROL": 10500, "OCTANE": 5600}, 0.10, func(h int) float64 {
		return pick((h >= 7 && h < 10) || (h >= 16 && h < 21), 1.45, 0.70)
	}},
	"industrial": {map[string]float64{"DIESEL": 14000, "PETROL": 4500, "OCTANE": 2200}, 0.08, func(h int) float64 {
		return pick(h >= 6 && h < 18, 1.55, 0.45)
	}},
	"highway": {map[string]float64{"DIESEL": 10500, "PETROL": 11000, "OCTANE": 6200}, 0.12, func(h int) float64 {
		return pick((h >= 6 && h < 10) || (h >= 16 && h < 21), 1.35, 0.75)
	}},
	"regional": {map[string]float64{"DIESEL": 7200, "PETROL": 7600, "OCTANE": 3600}, 0.10, func(h int) float64 {
		return pick(h >= 7 && h < 21, 1.25, 0.65)
	}},
}

func pick(c bool, a, b float64) float64 {
	if c {
		return a
	}
	return b
}

// ticksPerDay is fixed at 96 by the engine (daily/96 per tick) regardless of TICK_MINUTES.
const ticksPerDay = 96

// Forecaster predicts expected demand per (station, fuel, tick). Since every model input is published or
// visible over REST (profile, hour factor, region factor, current demand_multiplier, scheduled spikes),
// the forecast is exact in expectation; only the uniform jitter is unpredictable.
type Forecaster struct {
	start       time.Time // sim_time of the current tick
	now         int       // current tick
	tickMinutes int
	region      map[string]float64 // region id -> demand_factor
	spikes      []sim.Event        // SCHEDULED demand_spike events (future multiplier changes)
	active      []sim.Event        // ACTIVE demand_spike events (already in demand_multiplier until they expire)
}

func NewForecaster(w sim.World) *Forecaster {
	start, _ := sim.ParseSimTime(w.Instance.SimTime)
	f := &Forecaster{start: start, now: w.Instance.Tick, tickMinutes: max(w.Instance.TickMinutes, 1), region: map[string]float64{}}
	for _, r := range w.Regions {
		f.region[r.ID] = r.DemandFactor
	}
	for _, e := range w.Events {
		if e.Type == "demand_spike" && e.Status == "SCHEDULED" {
			f.spikes = append(f.spikes, e)
		}
		if e.Type == "demand_spike" && e.Status == "ACTIVE" {
			f.active = append(f.active, e)
		}
	}
	return f
}

// Expected demand at tick t (>= now) for station s. ACTIVE spikes are already in s.DemandMultiplier and are
// removed after their end tick (the engine resolves them after demand on end_tick); SCHEDULED spikes are applied
// over their inclusive [start, end] window.
func (f *Forecaster) Expected(s sim.Station, fuel string, t int) float64 {
	m := s.DemandMultiplier
	for _, e := range f.spikes {
		if t >= e.StartTick && t <= e.EndTick && spikeApplies(e, s) {
			m *= floatParam(e.Parameters, "multiplier", 1.5)
		}
	}
	for _, e := range f.active {
		if t > e.EndTick && spikeApplies(e, s) {
			m /= floatParam(e.Parameters, "multiplier", 1.5)
		}
	}
	return f.Baseline(s, fuel, t) * m
}

// Baseline is "normal" demand (multiplier 1). Detection compares observed demand against it.
func (f *Forecaster) Baseline(s sim.Station, fuel string, t int) float64 {
	p, ok := profiles[s.DemandProfile]
	if !ok {
		return 0
	}
	hour := f.start.Add(time.Duration((t-f.now)*f.tickMinutes) * time.Minute).Hour()
	return p.daily[fuel] / ticksPerDay * p.hour(hour) * f.regionFactor(s.RegionID)
}

// Noise returns the station profile's uniform jitter half-width.
func Noise(s sim.Station) float64 { return profiles[s.DemandProfile].noise }

func (f *Forecaster) regionFactor(id string) float64 {
	if v, ok := f.region[id]; ok {
		return v
	}
	return 1
}

func spikeApplies(e sim.Event, s sim.Station) bool {
	stations, regions := strParam(e.Parameters, "station_ids"), strParam(e.Parameters, "region_ids")
	if len(stations) == 0 && len(regions) == 0 {
		return true // demand_spike honours empty filters as "all" (unlike route/station/depot events)
	}
	return contains(stations, s.ID) || contains(regions, s.RegionID)
}

func floatParam(p map[string]any, k string, def float64) float64 {
	if v, ok := p[k].(float64); ok {
		return v
	}
	return def
}

func strParam(p map[string]any, k string) []string {
	raw, _ := p[k].([]any)
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
