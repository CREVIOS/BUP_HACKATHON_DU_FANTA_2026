package policy

import (
	"fmt"
	"math"
	"sort"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
)

// Anomaly is a (station, fuel) series whose recent observed demand departs from normal demand.
type Anomaly struct {
	StationID   string  `json:"station_id"`
	FuelType    string  `json:"fuel_type"`
	Direction   string  `json:"direction"` // spike | drop
	Ratio       float64 `json:"ratio"`     // mean observed / normal over the window
	Threshold   float64 `json:"threshold"` // |ratio-1| that counts as abnormal
	Window      int     `json:"window_ticks"`
	ExplainedBy string  `json:"explained_by"` // "" = no visible cause: investigate
}

// DetectWindow is how many past ticks Detect averages over.
const DetectWindow = 4

// Detect compares recent observed demand with normal demand (multiplier 1) for every series.
// The engine's jitter is uniform ±noise, so one tick's ratio has sd noise/√3 and a k-tick mean has
// sd noise/√(3k); a series is flagged when |mean ratio − 1| > max(4 sd, 0.10).
// obs may contain any ticks; only the last DetectWindow ticks before now are used.
func Detect(w sim.World, obs []sim.DemandObservation) []Anomaly {
	f := NewForecaster(w)
	now := w.Instance.Tick
	type acc struct {
		ratio float64
		n     int
	}
	byKey := map[seriesKey]*acc{}
	stations := map[string]sim.Station{}
	for _, s := range w.Stations {
		stations[s.ID] = s
	}
	for _, o := range obs {
		s, ok := stations[o.StationID]
		if !ok || o.Tick >= now || o.Tick < now-DetectWindow {
			continue
		}
		normal := f.Baseline(s, o.FuelType, o.Tick)
		if normal <= 0 {
			continue
		}
		k := seriesKey{o.StationID, o.FuelType}
		if byKey[k] == nil {
			byKey[k] = &acc{}
		}
		byKey[k].ratio += o.DemandLiters / normal
		byKey[k].n++
	}
	var out []Anomaly
	for k, a := range byKey {
		if a.n < DetectWindow/2 {
			continue
		}
		s := stations[k.station]
		mean := a.ratio / float64(a.n)
		thr := math.Max(4*Noise(s)/math.Sqrt(3*float64(a.n)), 0.10)
		if math.Abs(mean-1) <= thr {
			continue
		}
		an := Anomaly{StationID: k.station, FuelType: k.fuel, Direction: "spike", Ratio: round3(mean), Threshold: round3(thr), Window: a.n}
		if mean < 1 {
			an.Direction = "drop"
		}
		if m := s.DemandMultiplier; math.Abs(m-1) > 1e-9 {
			an.ExplainedBy = fmt.Sprintf("demand_multiplier ×%.2f (active demand_spike)", m)
		}
		out = append(out, an)
	}
	sort.Slice(out, func(i, j int) bool {
		return math.Abs(out[i].Ratio-1) > math.Abs(out[j].Ratio-1)
	})
	return out
}

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }
