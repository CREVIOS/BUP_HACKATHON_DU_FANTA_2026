// Package intel hosts forecasting, stockout risk, detection, the allocation policy and Jev review triage.
// It is stateless and deliberately killable: when it is down the ingestor runs Evaluate in-process
// without Jev (the rule-based fallback), so decisions never stop.
package intel

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/config"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/httpx"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/obs"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/policy"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
)

func Run(ctx context.Context, cfg config.Config) error {
	jev := NewJev(cfg.TypesafeAPIKey)
	slog.InfoContext(ctx, "intel starting", "jev_enabled", jev != nil, "policy", policy.Version)
	mux := httpx.NewMux("intel", nil, cfg.FailHealth)
	mux.HandleFunc("POST /v1/plan", func(w http.ResponseWriter, r *http.Request) {
		var req PlanRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20)).Decode(&req); err != nil {
			httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body: " + err.Error()})
			return
		}
		if err := req.World.Validate(); err != nil {
			httpx.WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid world: " + err.Error()})
			return
		}
		httpx.WriteJSON(w, http.StatusOK, Evaluate(r.Context(), req, jev, "intel"))
	})
	if c := httpx.ChaosEnabled(cfg.Chaos500Pct, cfg.FailHealth); c != "" {
		slog.WarnContext(ctx, "chaos flags enabled", "flags", c)
	}
	return httpx.Serve(ctx, cfg.HTTPAddr, httpx.Instrument(mux, cfg.Chaos500Pct))
}

type PlanRequest struct {
	World        sim.World               `json:"world"`
	Demand       []sim.DemandObservation `json:"demand"`        // recent observations, for anomaly detection
	JevThreshold float64                 `json:"jev_threshold"` // p_auto needed to auto-execute; 0 = default
}

// Triaged is a recommendation plus the auto/review decision and the evidence behind it.
type Triaged struct {
	policy.Recommendation
	RuleVerdict string            `json:"rule_verdict"` // what the fixed rule says: auto | review
	RuleReasons []string          `json:"rule_reasons"`
	JevPAuto    *float64          `json:"jev_p_auto"` // nil: not asked (hard veto) or Jev unavailable
	Verdict     string            `json:"verdict"`    // final: auto | review
	Features    map[string]string `json:"features"`   // the qualitative state Jev saw
}

type JevStatus struct {
	Enabled   bool   `json:"enabled"`
	Asked     int    `json:"asked"`
	Model     string `json:"model,omitempty"`
	LatencyMS int64  `json:"latency_ms,omitempty"`
	Error     string `json:"error,omitempty"`
}

type PlanResponse struct {
	Tick            int                 `json:"tick"`
	PolicyVersion   string              `json:"policy_version"`
	Source          string              `json:"source"` // intel | fallback
	Recommendations []Triaged           `json:"recommendations"`
	Risks           []policy.Projection `json:"risks"`
	Cancel          []sim.Allocation    `json:"cancel"`
	Anomalies       []policy.Anomaly    `json:"anomalies"`
	Jev             JevStatus           `json:"jev"`
}

const (
	DefaultJevThreshold = 0.8
	residualRiskReview  = 0.25 // rule: a shipment that still leaves this much stockout risk needs a human
)

// Evaluate runs the whole decision pipeline: plan, detect, triage.
// Hard vetoes (planner review reasons: stale data, large shipment, an event touching the shipment, reroute)
// always force review and are never sent to Jev. Otherwise Jev's p_auto >= threshold decides; if Jev is
// disabled or fails, the fixed rule decides (brief §11: "prediction confidence too low -> human review").
func Evaluate(ctx context.Context, req PlanRequest, jev *Jev, source string) PlanResponse {
	w := req.World
	plan := policy.MakePlan(w, policy.DefaultOptions)
	anomalies := policy.Detect(w, req.Demand)
	resp := PlanResponse{
		Tick: plan.Tick, PolicyVersion: plan.PolicyVersion, Source: source,
		Risks: plan.Risks, Cancel: plan.Cancel, Anomalies: anomalies, Jev: JevStatus{Enabled: jev != nil},
		Recommendations: []Triaged{},
	}
	threshold := req.JevThreshold
	if threshold <= 0 || threshold > 1 {
		threshold = DefaultJevThreshold
	}
	crises := activeEvents(w)
	ask := map[string]int{}
	shipments := map[string]map[string]string{}
	for i, r := range plan.Recommendations {
		t := Triaged{Recommendation: r, Features: features(w, r, anomalies, crises)}
		t.RuleReasons = append([]string{}, r.ReviewReasons...)
		if len(crises) > 0 {
			t.RuleReasons = append(t.RuleReasons, "crisis active: "+strings.Join(crises, ", "))
		}
		if r.RiskAfter > residualRiskReview {
			t.RuleReasons = append(t.RuleReasons, fmt.Sprintf("low confidence: %.0f%% stockout risk remains after this shipment", r.RiskAfter*100))
		}
		if a := anomalyFor(anomalies, r.StationID, r.FuelType); a != nil && a.ExplainedBy == "" {
			t.RuleReasons = append(t.RuleReasons, fmt.Sprintf("unexplained demand %s (×%.2f of normal)", a.Direction, a.Ratio))
		}
		t.RuleVerdict = verdict(len(t.RuleReasons) == 0)
		t.Verdict = t.RuleVerdict
		if len(r.ReviewReasons) == 0 {
			id := fmt.Sprintf("s%d", i+1)
			ask[id], shipments[id] = i, t.Features
		}
		resp.Recommendations = append(resp.Recommendations, t)
	}
	if jev != nil && len(ask) > 0 {
		start := time.Now()
		p, model, err := jev.AskAuto(ctx, shipments)
		resp.Jev.LatencyMS = time.Since(start).Milliseconds()
		if err != nil {
			resp.Jev.Error = err.Error()
			obs.RecordFallback(ctx, "jev")
			slog.WarnContext(ctx, "jev unavailable; fixed review rule decides", "err", err)
		} else {
			resp.Jev.Asked, resp.Jev.Model = len(ask), model
			for id, i := range ask {
				v := p[id]
				resp.Recommendations[i].JevPAuto = &v
				resp.Recommendations[i].Verdict = verdict(v >= threshold)
			}
		}
	}
	return resp
}

func verdict(auto bool) string {
	if auto {
		return "auto"
	}
	return "review"
}

// features turns computed numbers into the qualitative state Jev judges (it is weak at arithmetic).
func features(w sim.World, r policy.Recommendation, anomalies []policy.Anomaly, crises []string) map[string]string {
	f := map[string]string{
		"fuel":                         r.FuelType,
		"stockout_risk_now":            bucket(r.RiskBefore),
		"stockout_risk_after_shipment": bucket(r.RiskAfter),
		"data_freshness":               map[bool]string{true: "stale (simulator flagged its data stale)", false: "fresh"}[w.Stale],
		"active_crises":                "none",
		"demand_signal":                "normal",
	}
	switch tts := r.TimeToStockout; {
	case tts < 0:
		f["margin"] = "comfortable: no stockout expected within 12 hours"
	case tts <= r.TransitTicks+4:
		f["margin"] = "critical: stockout expected before or right after this shipment arrives"
	case tts <= 24:
		f["margin"] = "tight: stockout expected within 6 hours"
	default:
		f["margin"] = "moderate: stockout expected within 12 hours"
	}
	f["route"] = "direct (depot in the station's own region)"
	if regionOfDepot(w, r.DepotID) != regionOfStation(w, r.StationID) {
		f["route"] = "cross-region (slower, draws on the other region's depot)"
	}
	if h, ok := r.Signals["demand_next_horizon"].(float64); ok && h > 0 {
		switch day := r.Quantity / (2 * h); { // horizon is 12 h
		case day < 0.3:
			f["shipment_size"] = "small (under a third of a day's demand)"
		case day < 1:
			f["shipment_size"] = "normal (under one day's demand)"
		default:
			f["shipment_size"] = "large (more than a day's demand)"
		}
	}
	for _, d := range w.Depots {
		if d.ID == r.DepotID && d.Capacity[r.FuelType] > 0 {
			left := (d.Inventory[r.FuelType] - r.Quantity) / d.Capacity[r.FuelType]
			f["depot_stock_after_shipment"] = map[bool]string{true: "healthy", false: "low"}[left >= 0.25]
		}
	}
	if len(crises) > 0 {
		f["active_crises"] = strings.Join(crises, ", ")
	}
	if a := anomalyFor(anomalies, r.StationID, r.FuelType); a != nil {
		f["demand_signal"] = "abnormal " + a.Direction + ", no visible cause"
		if a.ExplainedBy != "" {
			f["demand_signal"] = "abnormal " + a.Direction + ", explained by an active demand spike"
		}
	}
	return f
}

func bucket(p float64) string {
	switch {
	case p >= 0.7:
		return "high"
	case p >= 0.3:
		return "medium"
	default:
		return "low"
	}
}

func activeEvents(w sim.World) []string {
	seen := map[string]bool{}
	for _, e := range w.Events {
		if e.Status == "ACTIVE" {
			seen[e.Type] = true
		}
	}
	out := make([]string, 0, len(seen))
	for t := range seen {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

func anomalyFor(as []policy.Anomaly, station, fuel string) *policy.Anomaly {
	for i := range as {
		if as[i].StationID == station && as[i].FuelType == fuel {
			return &as[i]
		}
	}
	return nil
}

func regionOfDepot(w sim.World, id string) string {
	for _, d := range w.Depots {
		if d.ID == id {
			return d.RegionID
		}
	}
	return ""
}

func regionOfStation(w sim.World, id string) string {
	for _, s := range w.Stations {
		if s.ID == id {
			return s.RegionID
		}
	}
	return ""
}
