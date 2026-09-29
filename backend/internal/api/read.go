package api

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/httpx"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/policy"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
	"github.com/jackc/pgx/v5"
)

// overview is the dashboard header: where the world is, how well it is served, what needs attention.
func (s *server) overview(w http.ResponseWriter, r *http.Request) {
	snap, ok := s.snapshot(w, r)
	if !ok {
		return
	}
	ctx, wd := r.Context(), snap.World
	var crit, warn, info, queue int
	var autoExec, fallback bool
	err := s.db.QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE severity = 'CRITICAL'), count(*) FILTER (WHERE severity = 'WARN'), count(*) FILTER (WHERE severity = 'INFO'),
		COALESCE(bool_or(kind = 'decision_engine_fallback'), false),
		(SELECT count(*) FROM recommendations WHERE status = 'PROPOSED' AND epoch_id = $1),
		(SELECT auto_execute FROM settings WHERE id = 1)
		FROM alerts WHERE resolved_at IS NULL AND epoch_id = $1`, snap.EpochID).Scan(&crit, &warn, &info, &fallback, &queue, &autoExec)
	if err != nil {
		internalErr(w, err)
		return
	}
	active, upcoming := 0, 0
	for _, e := range wd.Events {
		switch {
		case e.Status == "ACTIVE":
			active++
		case e.Status == "SCHEDULED":
			upcoming++
		}
	}
	totals := map[string]map[string]float64{"depots": {}, "stations": {}, "in_transit": {}}
	for _, d := range wd.Depots {
		for f, v := range d.Inventory {
			totals["depots"][f] += v
		}
	}
	for _, st := range wd.Stations {
		for f, v := range st.Inventory {
			totals["stations"][f] += v
		}
	}
	for _, byFuel := range policy.InTransit(wd) {
		for f, arr := range byFuel {
			for _, v := range arr {
				totals["in_transit"][f] += v
			}
		}
	}
	age := time.Since(snap.CapturedAt).Seconds()
	source := "intel"
	if fallback {
		source = "fallback"
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"simulation_only": true,
		"epoch_id":        snap.EpochID, "tick": wd.Instance.Tick, "sim_time": wd.Instance.SimTime, "sim_status": wd.Instance.Status,
		"tick_minutes": wd.Instance.TickMinutes, "scenario_id": wd.Instance.ScenarioID,
		"stale": snap.Stale, "data_age_seconds": age, "degraded": snap.Stale || fallback,
		"sim_metrics":     snap.Metrics,
		"open_alerts":     map[string]int{"critical": crit, "warn": warn, "info": info},
		"review_queue":    queue,
		"disruptions":     map[string]int{"active": active, "scheduled": upcoming},
		"decision_source": source, "auto_execute": autoExec,
		"inventory_liters": totals,
	})
}

type fuelState struct {
	Inventory   float64  `json:"inventory"`
	Capacity    float64  `json:"capacity"`
	Fill        float64  `json:"fill"`
	InTransit   *float64 `json:"in_transit,omitempty"`
	StockoutP   *float64 `json:"stockout_prob,omitempty"`
	TTSTicks    *int     `json:"time_to_stockout_ticks,omitempty"` // -1 = none within 12 h
	TTSHours    *float64 `json:"time_to_stockout_hours,omitempty"`
	RiskLevel   string   `json:"risk_level,omitempty"`
	DemandNext  *float64 `json:"demand_next_12h,omitempty"`
	PendingRoom *float64 `json:"room_after_in_transit,omitempty"`
}

// network is the live map: every depot, station and route with inventory, status and risk.
func (s *server) network(w http.ResponseWriter, r *http.Request) {
	snap, ok := s.snapshot(w, r)
	if !ok {
		return
	}
	wd := snap.World
	risks := riskBySeries(wd)
	transit := policy.InTransit(wd)
	left := policy.DispatchLeft(wd)
	var depots, stations, routes []map[string]any
	for _, d := range wd.Depots {
		fuels := map[string]fuelState{}
		for _, f := range sim.FuelTypes {
			fuels[f] = fuelState{Inventory: d.Inventory[f], Capacity: d.Capacity[f], Fill: ratio(d.Inventory[f], d.Capacity[f])}
		}
		depots = append(depots, map[string]any{"id": d.ID, "name": d.Name, "region_id": d.RegionID, "status": d.Status,
			"dispatch_capacity_per_tick": d.DispatchCapacityPerTick, "dispatch_left_this_tick": left[d.ID], "fuels": fuels})
	}
	for _, st := range wd.Stations {
		fuels := map[string]fuelState{}
		for _, f := range sim.FuelTypes {
			p := risks[st.ID+":"+f]
			it := sumArr(transit[st.ID][f])
			room := st.Capacity[f] - st.Inventory[f] - it
			fuels[f] = fuelState{Inventory: st.Inventory[f], Capacity: st.Capacity[f], Fill: ratio(st.Inventory[f], st.Capacity[f]),
				InTransit: &it, StockoutP: &p.StockoutProb, TTSTicks: &p.TimeToStockout, TTSHours: hours(p.TimeToStockout, wd),
				RiskLevel: riskLevel(p), DemandNext: &p.DemandHorizon, PendingRoom: &room}
		}
		stations = append(stations, map[string]any{"id": st.ID, "name": st.Name, "region_id": st.RegionID, "status": st.Status,
			"demand_profile": st.DemandProfile, "demand_multiplier": st.DemandMultiplier, "fuels": fuels})
	}
	for _, rt := range wd.Routes {
		routes = append(routes, map[string]any{"id": rt.ID, "source_depot_id": rt.SourceDepotID, "destination_station_id": rt.DestinationStationID,
			"transit_ticks": rt.TransitTicks, "max_shipment": rt.MaxShipment, "status": rt.Status,
			"usable_now": !policy.RouteDisruptedAt(wd, rt.ID, wd.Instance.Tick), "cross_region": regionOf(wd, rt.SourceDepotID) != regionOf(wd, rt.DestinationStationID),
			"disruptions": disruptionsOf(wd, rt.ID)})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"tick": wd.Instance.Tick, "regions": wd.Regions, "depots": depots, "stations": stations, "routes": routes})
}

// risk lists every (station, fuel) series, most urgent first: the projected-shortage view.
func (s *server) risk(w http.ResponseWriter, r *http.Request) {
	snap, ok := s.snapshot(w, r)
	if !ok {
		return
	}
	wd := snap.World
	names := map[string]string{}
	for _, st := range wd.Stations {
		names[st.ID] = st.Name
	}
	out := []map[string]any{}
	for _, p := range policy.Risks(wd, policy.DefaultOptions) {
		out = append(out, map[string]any{"station_id": p.StationID, "station_name": names[p.StationID], "fuel_type": p.FuelType,
			"risk_level": riskLevel(p), "stockout_prob": p.StockoutProb, "time_to_stockout_ticks": p.TimeToStockout,
			"time_to_stockout_hours": hours(p.TimeToStockout, wd), "on_hand": p.OnHand, "in_transit": p.InTransit,
			"capacity": p.Capacity, "demand_next_12h": p.DemandHorizon, "cover_ratio": ratio(p.Position(), p.DemandHorizon)})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"tick": wd.Instance.Tick, "horizon_ticks": policy.DefaultOptions.Horizon,
		"method": "tick-by-tick projection of on-hand + in-transit − forecast demand; probability from a uniform-noise ensemble",
		"series": out})
}

// demand returns observed demand with the forecast recorded before each tick, plus the forecast ahead.
// Query: station_id, fuel_type (optional filters), ticks (history, default 96), horizon (forecast, default 48).
func (s *server) demand(w http.ResponseWriter, r *http.Request) {
	snap, ok := s.snapshot(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	ticks, horizon := intParam(q.Get("ticks"), 96, 1, 2000), intParam(q.Get("horizon"), 48, 0, 192)
	station, fuel := q.Get("station_id"), q.Get("fuel_type")
	wd := snap.World
	rows, err := s.db.Query(r.Context(), `SELECT o.station_id, o.fuel_type, o.tick, o.demand_liters, o.served_liters, o.unmet_liters, f.expected
		FROM demand_observations o LEFT JOIN forecasts f USING (epoch_id, tick, station_id, fuel_type)
		WHERE o.epoch_id = $1 AND o.tick >= $2 AND ($3 = '' OR o.station_id = $3) AND ($4 = '' OR o.fuel_type = $4)
		ORDER BY o.station_id, o.fuel_type, o.tick`, snap.EpochID, wd.Instance.Tick-ticks, station, fuel)
	if err != nil {
		internalErr(w, err)
		return
	}
	type point struct {
		Tick     int      `json:"tick"`
		Demand   float64  `json:"demand"`
		Served   float64  `json:"served"`
		Unmet    float64  `json:"unmet"`
		Forecast *float64 `json:"forecast"`
	}
	type ahead struct {
		Tick     int     `json:"tick"`
		Expected float64 `json:"expected"`
		Low      float64 `json:"low"`
		High     float64 `json:"high"`
	}
	type series struct {
		StationID string  `json:"station_id"`
		FuelType  string  `json:"fuel_type"`
		History   []point `json:"history"`
		Forecast  []ahead `json:"forecast"`
	}
	hist := map[string][]point{}
	for rows.Next() {
		var st, f string
		var p point
		if err := rows.Scan(&st, &f, &p.Tick, &p.Demand, &p.Served, &p.Unmet, &p.Forecast); err != nil {
			internalErr(w, err)
			return
		}
		hist[st+":"+f] = append(hist[st+":"+f], p)
	}
	if err := rows.Err(); err != nil {
		internalErr(w, err)
		return
	}
	fc := policy.NewForecaster(wd)
	out := []series{}
	for _, st := range wd.Stations {
		if station != "" && st.ID != station {
			continue
		}
		noise := policy.Noise(st)
		for _, f := range sim.FuelTypes {
			if fuel != "" && f != fuel {
				continue
			}
			sr := series{StationID: st.ID, FuelType: f, History: hist[st.ID+":"+f], Forecast: []ahead{}}
			if sr.History == nil {
				sr.History = []point{}
			}
			for t := wd.Instance.Tick; t < wd.Instance.Tick+horizon; t++ {
				e := fc.Expected(st, f, t)
				if st.Status != "OPEN" {
					e = 0 // demand still arrives during an outage but none of it can be served
				}
				sr.Forecast = append(sr.Forecast, ahead{Tick: t, Expected: e, Low: e * (1 - noise), High: e * (1 + noise)})
			}
			out = append(out, sr)
		}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"tick": wd.Instance.Tick, "series": out})
}

// regionalDemand aggregates demand, service and the 12 h forecast per region and fuel. Query: ticks (default 96).
func (s *server) regionalDemand(w http.ResponseWriter, r *http.Request) {
	snap, ok := s.snapshot(w, r)
	if !ok {
		return
	}
	wd := snap.World
	ticks := intParam(r.URL.Query().Get("ticks"), 96, 1, 2000)
	rows, err := s.db.Query(r.Context(), `SELECT station_id, fuel_type, sum(demand_liters), sum(served_liters), sum(unmet_liters)
		FROM demand_observations WHERE epoch_id = $1 AND tick >= $2 GROUP BY 1, 2`, snap.EpochID, wd.Instance.Tick-ticks)
	if err != nil {
		internalErr(w, err)
		return
	}
	type agg struct {
		Demand        float64 `json:"demand"`
		Served        float64 `json:"served"`
		Unmet         float64 `json:"unmet"`
		ServiceLevel  float64 `json:"service_level"`
		ForecastNext  float64 `json:"forecast_next_12h"`
		MaxMultiplier float64 `json:"max_demand_multiplier"`
	}
	stationRegion := map[string]string{}
	for _, st := range wd.Stations {
		stationRegion[st.ID] = st.RegionID
	}
	regions := map[string]map[string]*agg{}
	get := func(region, fuel string) *agg {
		if regions[region] == nil {
			regions[region] = map[string]*agg{}
		}
		if regions[region][fuel] == nil {
			regions[region][fuel] = &agg{}
		}
		return regions[region][fuel]
	}
	for rows.Next() {
		var st, f string
		var d, sv, u float64
		if err := rows.Scan(&st, &f, &d, &sv, &u); err != nil {
			internalErr(w, err)
			return
		}
		a := get(stationRegion[st], f)
		a.Demand, a.Served, a.Unmet = a.Demand+d, a.Served+sv, a.Unmet+u
	}
	if err := rows.Err(); err != nil {
		internalErr(w, err)
		return
	}
	fc := policy.NewForecaster(wd)
	for _, st := range wd.Stations {
		for _, f := range sim.FuelTypes {
			a := get(st.RegionID, f)
			a.MaxMultiplier = math.Max(a.MaxMultiplier, st.DemandMultiplier)
			for t := wd.Instance.Tick; t < wd.Instance.Tick+policy.DefaultOptions.Horizon; t++ {
				a.ForecastNext += fc.Expected(st, f, t)
			}
		}
	}
	out := []map[string]any{}
	for _, rg := range wd.Regions {
		fuels := map[string]*agg{}
		for _, f := range sim.FuelTypes {
			a := get(rg.ID, f)
			a.ServiceLevel = 1
			if a.Demand > 0 {
				a.ServiceLevel = a.Served / a.Demand
			}
			fuels[f] = a
		}
		var ids []string
		for _, st := range wd.Stations {
			if st.RegionID == rg.ID {
				ids = append(ids, st.ID)
			}
		}
		out = append(out, map[string]any{"region_id": rg.ID, "name": rg.Name, "demand_factor": rg.DemandFactor, "station_ids": ids, "fuels": fuels})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"tick": wd.Instance.Tick, "window_ticks": ticks, "regions": out})
}

// supply lists incoming depot supply with delay/shortfall against the schedule first seen this epoch,
// and how much would be lost to a full depot (the simulator clips supply at capacity).
func (s *server) supply(w http.ResponseWriter, r *http.Request) {
	snap, ok := s.snapshot(w, r)
	if !ok {
		return
	}
	wd := snap.World
	first := map[string]sim.SupplyArrival{}
	var raw []byte
	if err := s.db.QueryRow(r.Context(), `SELECT payload->'supply_arrivals' FROM snapshots WHERE epoch_id = $1 ORDER BY id LIMIT 1`,
		snap.EpochID).Scan(&raw); err == nil {
		var list []sim.SupplyArrival
		if json.Unmarshal(raw, &list) == nil {
			for _, a := range list {
				first[a.ID] = a
			}
		}
	}
	depots := map[string]sim.Depot{}
	for _, d := range wd.Depots {
		depots[d.ID] = d
	}
	out := []map[string]any{}
	for _, a := range wd.Supply {
		f, seen := first[a.ID]
		if !seen {
			f = a
		}
		item := map[string]any{"id": a.ID, "depot_id": a.DepotID, "fuel_type": a.FuelType, "quantity": a.Quantity,
			"planned_tick": a.PlannedTick, "actual_tick": a.ActualTick, "status": a.Status,
			"original_planned_tick": f.PlannedTick, "original_quantity": f.Quantity,
			"delay_ticks": a.PlannedTick - f.PlannedTick, "shortfall_liters": math.Max(0, f.Quantity-a.Quantity)}
		if a.Status != "ARRIVED" {
			d := depots[a.DepotID]
			item["eta_ticks"] = a.PlannedTick - wd.Instance.Tick
			item["clip_risk_liters"] = math.Max(0, a.Quantity-(d.Capacity[a.FuelType]-d.Inventory[a.FuelType]))
		}
		out = append(out, item)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"tick": wd.Instance.Tick, "arrivals": out})
}

// events lists disruptions (crisis events) with what they do, in plain words.
func (s *server) events(w http.ResponseWriter, r *http.Request) {
	snap, ok := s.snapshot(w, r)
	if !ok {
		return
	}
	wd := snap.World
	out := []map[string]any{}
	for _, e := range wd.Events {
		out = append(out, map[string]any{"id": e.ID, "type": e.Type, "status": e.Status, "start_tick": e.StartTick,
			"end_tick": e.EndTick, "parameters": e.Parameters, "starts_in_ticks": e.StartTick - wd.Instance.Tick,
			"ends_in_ticks": e.EndTick - wd.Instance.Tick, "effective": eventEffective(e), "description": describeEvent(e)})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"tick": wd.Instance.Tick, "events": out})
}

// allocations lists simulator allocations (linked to our recommendations) and our not-yet-sent queue.
func (s *server) allocations(w http.ResponseWriter, r *http.Request) {
	snap, ok := s.snapshot(w, r)
	if !ok {
		return
	}
	type link struct {
		RecID  int64
		Status string
	}
	links := map[string]link{}
	rows, err := s.db.Query(r.Context(), `SELECT o.idempotency_key, o.recommendation_id, o.status FROM outbox o
		JOIN recommendations r ON r.id = o.recommendation_id WHERE r.epoch_id = $1`, snap.EpochID)
	if err != nil {
		internalErr(w, err)
		return
	}
	for rows.Next() {
		var k string
		var l link
		if err := rows.Scan(&k, &l.RecID, &l.Status); err != nil {
			internalErr(w, err)
			return
		}
		links[k] = l
	}
	out := []map[string]any{}
	for _, a := range snap.World.Allocations {
		m := structMap(a)
		m["origin"] = "external"
		if l, ok := links[a.IdempotencyKey]; ok {
			m["origin"], m["recommendation_id"] = "fuelops", l.RecID
		}
		out = append(out, m)
	}
	qrows, err := s.db.Query(r.Context(), `SELECT o.id, o.recommendation_id, o.status, o.attempts, o.last_error, o.body, o.updated_at
		FROM outbox o JOIN recommendations r ON r.id = o.recommendation_id
		WHERE r.epoch_id = $1 AND o.status <> 'SENT' ORDER BY o.id DESC LIMIT 50`, snap.EpochID)
	if err != nil {
		internalErr(w, err)
		return
	}
	queued, err := pgx.CollectRows(qrows, func(row pgx.CollectableRow) (map[string]any, error) {
		var id, rec int64
		var status string
		var attempts int
		var lastErr *string
		var body []byte
		var at time.Time
		err := row.Scan(&id, &rec, &status, &attempts, &lastErr, &body, &at)
		return map[string]any{"outbox_id": id, "recommendation_id": rec, "status": status, "attempts": attempts,
			"last_error": lastErr, "request": json.RawMessage(body), "updated_at": at}, err
	})
	if err != nil {
		internalErr(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"tick": snap.World.Instance.Tick, "allocations": out, "queued": queued})
}

// quality is the intelligence evidence: forecast error vs a naive baseline, decision mix, fallback use.
// Query: ticks (window, default 96).
func (s *server) quality(w http.ResponseWriter, r *http.Request) {
	snap, ok := s.snapshot(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	ticks := intParam(r.URL.Query().Get("ticks"), 96, 1, 5000)
	from := snap.World.Instance.Tick - ticks
	var n int
	var mape, naive *float64
	if err := s.db.QueryRow(ctx, `SELECT count(*), avg(abs(o.demand_liters - f.expected) / o.demand_liters),
			avg(abs(o.demand_liters - f.naive) / o.demand_liters) FILTER (WHERE f.naive IS NOT NULL)
		FROM forecasts f JOIN demand_observations o USING (epoch_id, tick, station_id, fuel_type)
		WHERE f.epoch_id = $1 AND f.tick >= $2 AND o.demand_liters > 0`, snap.EpochID, from).Scan(&n, &mape, &naive); err != nil {
		internalErr(w, err)
		return
	}
	counts := func(sql string) (map[string]int, error) {
		rows, err := s.db.Query(ctx, sql, snap.EpochID)
		if err != nil {
			return nil, err
		}
		out := map[string]int{}
		for rows.Next() {
			var k string
			var v int
			if err := rows.Scan(&k, &v); err != nil {
				return nil, err
			}
			out[k] = v
		}
		return out, rows.Err()
	}
	bySource, err1 := counts(`SELECT source || ':' || COALESCE(verdict, 'none'), count(*) FROM recommendations WHERE epoch_id = $1 GROUP BY 1`)
	byStatus, err2 := counts(`SELECT status, count(*) FROM recommendations WHERE epoch_id = $1 GROUP BY 1`)
	outbox, err3 := counts(`SELECT o.status, count(*) FROM outbox o JOIN recommendations r ON r.id = o.recommendation_id WHERE r.epoch_id = $1 GROUP BY 1`)
	alertKinds, err4 := counts(`SELECT kind, count(*) FROM alerts WHERE epoch_id = $1 GROUP BY 1`)
	for _, e := range []error{err1, err2, err3, err4} {
		if e != nil {
			internalErr(w, e)
			return
		}
	}
	var jevAsked int
	var jevAvg *float64
	var agree, disagree int
	if err := s.db.QueryRow(ctx, `SELECT count(jev_p_auto), avg(jev_p_auto),
			count(*) FILTER (WHERE jev_p_auto IS NOT NULL AND verdict = rule_verdict),
			count(*) FILTER (WHERE jev_p_auto IS NOT NULL AND verdict <> rule_verdict)
		FROM recommendations WHERE epoch_id = $1`, snap.EpochID).Scan(&jevAsked, &jevAvg, &agree, &disagree); err != nil {
		internalErr(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"tick": snap.World.Instance.Tick, "window_ticks": ticks,
		"forecast": map[string]any{"observations": n, "mape": mape, "naive_mape": naive,
			"note": "expected demand is recorded before each tick is simulated; naive = the previous tick's observed demand"},
		"recommendations": map[string]any{"by_source_verdict": bySource, "by_status": byStatus},
		"outbox":          outbox,
		"jev":             map[string]any{"asked": jevAsked, "avg_p_auto": jevAvg, "agreed_with_rule": agree, "overrode_rule": disagree},
		"alerts_by_kind":  alertKinds,
		"sim_metrics":     snap.Metrics,
	})
}

// --- helpers ---

func riskBySeries(w sim.World) map[string]policy.Projection {
	m := map[string]policy.Projection{}
	for _, p := range policy.Risks(w, policy.DefaultOptions) {
		m[p.StationID+":"+p.FuelType] = p
	}
	return m
}

// riskLevel grades a series by how soon it runs dry (the planner acts on the same horizon):
// critical ≤ 8 ticks (2 h), high ≤ 24 ticks (6 h) or near-certain within 12 h, elevated = likely within 12 h.
func riskLevel(p policy.Projection) string {
	tts := p.TimeToStockout
	switch {
	case tts >= 0 && tts <= 8:
		return "critical"
	case (tts >= 0 && tts <= 24) || p.StockoutProb >= 0.9:
		return "high"
	case p.StockoutProb >= 0.3 || tts >= 0:
		return "elevated"
	}
	return "normal"
}

func hours(ticks int, w sim.World) *float64 {
	if ticks < 0 {
		return nil
	}
	h := float64(ticks) * float64(max(w.Instance.TickMinutes, 1)) / 60
	return &h
}

func ratio(a, b float64) float64 {
	if b <= 0 {
		return 0
	}
	return a / b
}

func sumArr(m map[int]float64) float64 {
	t := 0.0
	for _, v := range m {
		t += v
	}
	return t
}

func intParam(v string, def, lo, hi int) int {
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return min(max(n, lo), hi)
}

func regionOf(w sim.World, id string) string {
	for _, d := range w.Depots {
		if d.ID == id {
			return d.RegionID
		}
	}
	for _, s := range w.Stations {
		if s.ID == id {
			return s.RegionID
		}
	}
	return ""
}

func disruptionsOf(w sim.World, route string) []map[string]any {
	out := []map[string]any{}
	for _, e := range w.Events {
		if e.Type != "route_disruption" || e.Status == "RESOLVED" {
			continue
		}
		for _, id := range stringList(e.Parameters["route_ids"]) {
			if id == route {
				out = append(out, map[string]any{"event_id": e.ID, "status": e.Status, "start_tick": e.StartTick, "end_tick": e.EndTick})
			}
		}
	}
	return out
}

func stringList(v any) []string {
	raw, _ := v.([]any)
	var out []string
	for _, x := range raw {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// eventEffective: route/station/depot events with an empty id list do nothing in the simulator.
func eventEffective(e sim.Event) bool {
	key := map[string]string{"route_disruption": "route_ids", "station_outage": "station_ids", "depot_constraint": "depot_ids"}[e.Type]
	return key == "" || len(stringList(e.Parameters[key])) > 0
}

func describeEvent(e sim.Event) string {
	p := e.Parameters
	window := fmt.Sprintf("ticks %d–%d", e.StartTick, e.EndTick)
	scope := func() string {
		ids := append(stringList(p["station_ids"]), stringList(p["region_ids"])...)
		ids = append(ids, stringList(p["depot_ids"])...)
		if len(ids) == 0 {
			return "everywhere"
		}
		return fmt.Sprint(ids)
	}
	switch e.Type {
	case "demand_spike":
		m := 1.5 // the simulator's default
		if v, ok := p["multiplier"].(float64); ok {
			m = v
		}
		return fmt.Sprintf("demand ×%.2f %s, %s", m, scope(), window)
	case "route_disruption":
		return fmt.Sprintf("routes %v unusable, %s: new shipments rejected, PENDING ones fail at departure", stringList(p["route_ids"]), window)
	case "station_outage":
		return fmt.Sprintf("stations %v closed, %s: all their demand is unmet", stringList(p["station_ids"]), window)
	case "depot_constraint":
		return fmt.Sprintf("depots %v marked constrained, %s (the simulator does not change capacity)", stringList(p["depot_ids"]), window)
	case "shipment_delay":
		d, _ := p["delay_ticks"].(float64)
		return fmt.Sprintf("scheduled supply %s delayed by %.0f ticks (applied once at tick %d)", scope(), d, e.StartTick)
	case "supply_shortfall":
		f, _ := p["factor"].(float64)
		return fmt.Sprintf("scheduled supply %s cut to ×%.2f (applied once at tick %d)", scope(), f, e.StartTick)
	}
	return e.Type + " " + window
}

func structMap(v any) map[string]any {
	b, _ := json.Marshal(v)
	m := map[string]any{}
	_ = json.Unmarshal(b, &m)
	return m
}
