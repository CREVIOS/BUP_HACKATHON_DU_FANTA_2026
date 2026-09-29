package intel

import (
	"fmt"
	"math"
	"sync"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/policy"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/rl"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
)

// RLVersion identifies the trained policy in recommendations.policy_version.
const RLVersion = "ppo-seed11-7be470b"

// LowConfidence is the policy probability below which an RL shipment always goes to a human (brief §11:
// "prediction confidence too low -> human review requested").
const LowConfidence = 0.5

var (
	actorOnce sync.Once
	actor     *rl.Actor
	actorErr  error
)

func loadActor() (*rl.Actor, error) {
	actorOnce.Do(func() { actor, actorErr = rl.LoadActor() })
	return actor, actorErr
}

// RLInfo is the model's side of a recommendation (brief §9): what it chose, how sure it was, and what else it
// could have done — every valid plan with its probability, plus the planner's rule-based baseline for comparison.
type RLInfo struct {
	Model            string      `json:"model"`
	Action           int         `json:"action"`
	Strategy         string      `json:"strategy"`
	Confidence       float64     `json:"confidence"` // the policy's probability for the chosen plan
	BaselineAction   int         `json:"baseline_action"`
	BaselineStrategy string      `json:"baseline_strategy"`
	AgreesBaseline   bool        `json:"agrees_with_baseline"`
	PlanShipments    int         `json:"plan_shipments"` // shipments in the chosen plan (this card is one of them)
	PlanLiters       float64     `json:"plan_liters"`
	Options          []rl.Option `json:"options"` // every valid plan, most probable first
}

// rlRecommendations turns the trained policy's plan for this tick into recommendation cards. It returns an error
// (the caller falls back to greedy) when the model cannot be trusted with this world: stale data, untrusted clock,
// or a topology it was not trained on.
func rlRecommendations(req PlanRequest) ([]policy.Recommendation, *RLInfo, error) {
	a, err := loadActor()
	if err != nil {
		return nil, nil, fmt.Errorf("rl model unavailable: %w", err)
	}
	w := req.World
	d, err := a.Decide(w, max(req.Epoch, 1), req.Demand, req.Reservations)
	if err != nil {
		return nil, nil, err
	}
	info := &RLInfo{Model: fmt.Sprintf("%s@%s seed %d", a.Meta.Repo, a.Meta.Revision[:7], a.Meta.Seed),
		Action: d.Action, Strategy: d.Strategy, Confidence: d.Confidence(), BaselineAction: d.BaselineAction,
		BaselineStrategy: d.BaselineStrategy, AgreesBaseline: d.Action == d.BaselineAction,
		PlanShipments: len(d.Shipments), PlanLiters: d.Liters}
	for _, o := range d.Options {
		if o.Valid {
			info.Options = append(info.Options, o)
		}
	}
	sortOptions(info.Options)

	o := policy.DefaultOptions
	routes := map[string]sim.Route{}
	for _, r := range w.Routes {
		routes[r.ID] = r
	}
	var recs []policy.Recommendation
	for _, s := range d.Shipments {
		p := policy.Proposal{StationID: s.StationID, FuelType: s.FuelType, RouteID: s.RouteID, Quantity: s.Quantity}
		before, after, err := policy.Impact(w, p, o)
		if err != nil {
			return nil, nil, err
		}
		rt := routes[s.RouteID]
		r := policy.Recommendation{
			StationID: s.StationID, FuelType: s.FuelType, DepotID: s.DepotID, RouteID: s.RouteID, Quantity: s.Quantity,
			TransitTicks: rt.TransitTicks, ArrivalTick: w.Instance.Tick + rt.TransitTicks,
			RiskBefore: before.StockoutProb, RiskAfter: after.StockoutProb, TimeToStockout: before.TimeToStockout,
			ShortfallBefore: math.Round(before.ExpectedShortfall), ShortfallAfter: math.Round(after.ExpectedShortfall),
			Binding: "RL plan: " + d.Strategy + " (quantity set by the shared planner within stock, dispatch, route and room limits)",
			Signals: map[string]any{
				"on_hand": before.OnHand, "in_transit": before.InTransit, "capacity": before.Capacity,
				"demand_next_horizon": math.Round(before.DemandHorizon), "horizon_ticks": o.Horizon,
				"demand_multiplier": stationMultiplier(w, s.StationID),
				"model_confidence":  math.Round(info.Confidence*1000) / 1000,
			},
			Alternatives: routeAlternatives(w, s.StationID, s.RouteID),
		}
		r.ReviewReasons = policy.ReviewReasons(w, r, o)
		if info.Confidence < LowConfidence {
			r.ReviewReasons = append(r.ReviewReasons, fmt.Sprintf("low model confidence: the policy gives this plan %.0f%%", info.Confidence*100))
		}
		r.ReviewRequired = len(r.ReviewReasons) > 0
		recs = append(recs, r)
	}
	return recs, info, nil
}

// routeAlternatives lists the other routes to the station and why the RL plan did not use them.
func routeAlternatives(w sim.World, station, chosen string) []policy.Alternative {
	var out []policy.Alternative
	for _, r := range w.Routes {
		if r.DestinationStationID != station || r.ID == chosen {
			continue
		}
		why := "not used by the RL plan (the planner picks the lowest lead time, adjusted for depot headroom or scarcity in those modes)"
		if policy.RouteDisruptedAt(w, r.ID, w.Instance.Tick) {
			why = fmt.Sprintf("route disrupted at departure tick %d", w.Instance.Tick)
		}
		out = append(out, policy.Alternative{RouteID: r.ID, DepotID: r.SourceDepotID, TransitTicks: r.TransitTicks, Rejected: why})
	}
	return out
}

func stationMultiplier(w sim.World, id string) float64 {
	for _, s := range w.Stations {
		if s.ID == id {
			return s.DemandMultiplier
		}
	}
	return 1
}

func sortOptions(xs []rl.Option) {
	for i := 1; i < len(xs); i++ {
		for j := i; j > 0 && xs[j].Probability > xs[j-1].Probability; j-- {
			xs[j], xs[j-1] = xs[j-1], xs[j]
		}
	}
}
