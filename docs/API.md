# FuelOps Operator API — contracts

Served by `fuelops api` on **:8000**. The frontend calls it on the same origin under `/api` (Next.js rewrites `/api/*` → `api:8000`).
Machine-readable spec: `/openapi.yaml` · Swagger UI `/docs` · ReDoc `/redoc`. A test fails if any registered route is missing from it.
All examples below were captured from a live run against the real simulator image (trimmed where marked `…`).

**Contents**
1. [Architecture and data flow](#1-architecture-and-data-flow)
2. [Conventions](#2-conventions) — auth, errors, ticks, epochs, units
3. [End-to-end flows](#3-end-to-end-flows)
4. [Shared types](#4-shared-types)
5. [Endpoint reference](#5-endpoint-reference)
6. [Live stream (SSE)](#6-live-stream-sse)
7. [Alert catalog](#7-alert-catalog)
8. [Error codes](#8-error-codes)
9. [Internal contracts](#9-internal-contracts) — intel, Jev, outbox, command queue, database
10. [Health, metrics, tracing](#10-health-metrics-tracing)

---

## 1. Architecture and data flow

```
                    ┌──────────────────────── Postgres ────────────────────────┐
 simulator ◀──────▶ │ ingestor (the ONLY simulator client, advisory-locked)    │
  (organizer        │  every cycle (SSE tick hint, or 1 s):                    │
   image)           │   1. fenced world snapshot  → snapshots                  │
   ≤ 4 in flight    │   2. demand history mirror  → demand_observations        │
                    │   3. on a new tick / event change: POST intel /v1/plan   │
                    │      (in-process fallback if intel is down)              │
                    │      → recommendations, forecasts, alerts                │
                    │      → 'auto' verdicts approved + queued in outbox       │
                    │      → cancel PENDING allocations doomed by a disruption │
                    │   4. drain outbox → POST /v1/allocations                 │
                    │  every 250 ms: execute sim_commands (step, events, …)    │
                    └──────────────────────────────────────────────────────────┘
                                          ▲  reads + writes intents
 browser ──REST/SSE──▶ api (stateless, N replicas; never calls the simulator)
                        └─▶ intel /healthz (status panel only)
 intel (stateless): planner + risk + anomaly detection + Jev triage ──▶ TypeSafe Jev (optional)
```

Why this shape: the simulator permanently wedges at ~15 concurrent requests and silently destroys fuel in several cases,
so exactly one careful process talks to it; everything the UI needs is served from Postgres.

## 2. Conventions

### Base, format, units
- JSON in and out (`Content-Type: application/json`), UTF-8. Request bodies are limited to 64 KiB and **unknown fields are rejected** (400 `INVALID_BODY`).
- Liters are floats. Probabilities are 0–1. Fuel types: `DIESEL`, `PETROL`, `OCTANE`.
- Everything is **simulated**; `GET /api/overview` returns `"simulation_only": true` for the UI banner.

### Time: ticks and epochs
- A **tick** is the simulator's step (15 simulated minutes by default; `tick_minutes` is in `/api/overview`). `tick` in any response is the
  simulator's *next tick to be processed*: an allocation created now departs when that tick is processed and arrives `transit_ticks` later.
- Hours are derived as `ticks × tick_minutes / 60`.
- An **epoch** is one simulator world. A simulator reset (tick goes backwards, or seed/scenario changes) opens a new epoch.
  Recommendations, alerts and allocations are scoped to the current epoch. Allocation ids restart at 1 after a reset.
- `sim_time` is the simulator's clock, a naive ISO timestamp in UTC (no offset), e.g. `"2026-01-01T16:00:00"`.

### Auth (brief §18)
| Role | How | Can |
|---|---|---|
| viewer | no header | every `GET` (except `/api/admin/*`), `POST /api/simulate` (what-if, read-only) |
| operator | `Authorization: Bearer $OPERATOR_TOKEN` | + approve, reject, manual allocation, cancel allocation, acknowledge alert |
| admin | `Authorization: Bearer $ADMIN_TOKEN` | + simulator control, crisis & fault injection, policy settings, command log |

- Optional `X-Actor: <name>` (1–64 chars `[A-Za-z0-9 ._@-]`) is recorded with the role in audit fields, e.g. `"operator:asif"`. Tokens are per role, so the name is informational, not authenticated.
- If **neither** token is set, auth is off and every caller is admin (local dev; the api logs a warning). `GET /api/me` reports it.
- Missing or insufficient role → **401** `UNAUTHORIZED`.

### Errors
One shape for every error from this API:
```json
{ "error": { "code": "UNSAFE", "message": "this shipment would be rejected or lose fuel",
             "details": ["would overflow station-mirpur: room 1200 L counting 5000 L in transit (the simulator destroys overflow)"] } }
```
`details` is present when there is a list (validation violations). Codes are in [§8](#8-error-codes).
**503 `NO_SNAPSHOT`** means the ingestor has not read the simulator yet (first seconds after startup).

### Consistency
Reads come from the latest persisted snapshot, which is tick-fenced (read between two identical `/v1/instance` ticks) and refreshed whenever
anything in the world changes. `data_age_seconds` in `/api/overview` says how old it is. During a simulator outage the API keeps
serving the last-known-good snapshot and `/api/status` shows `fuel_simulator: "unhealthy: …"`.

---

## 3. End-to-end flows

### 3.1 Dashboard loop (every screen)
1. On load: `GET /api/overview`, `/api/network`, `/api/risk`, `/api/alerts`, `/api/recommendations?status=PROPOSED`, `/api/status`.
2. Open `GET /api/stream`. On each event refetch only what changed ([§6](#6-live-stream-sse)): `tick` → overview/network/risk/demand/supply/events;
   `alerts` → alerts; `recommendations` → recommendations/decisions; `allocations` → allocations; `commands` → command log.
3. If the stream drops, the browser's `EventSource` reconnects (`retry: 3000`); meanwhile poll `/api/overview` every few seconds.

### 3.2 Recommendation lifecycle
```
 ingestor decides a tick
        │
        ▼
   triage ── hard veto? ──yes──────────────────────────────┐
        │ no                                               │
        ▼                                                  ▼
   Jev p_auto ≥ threshold ?   (Jev off/failing → fixed rule)   verdict = review
        │ yes: verdict = auto        │ no: verdict = review         │
        ▼                            ▼                              ▼
 auto_execute on? ─yes─▶ APPROVED (decision AUTO_EXECUTE)     PROPOSED ──▶ operator
        │ no                         │                         │  approve ─▶ APPROVED (decision APPROVE)
        └──────────▶ PROPOSED        │                         │  reject  ─▶ REJECTED (decision REJECT)
                                     ▼                         │  superseded / 8 ticks / reset ─▶ EXPIRED
                         outbox (exact body stored)            
                                     │  pre-flight vs live world fails ─▶ FAILED (last_error "PREFLIGHT: …")
                                     │  simulator 4xx                   ─▶ FAILED (last_error "<CODE>: …")
                                     │  5xx/timeout ×5, key not visible ─▶ FAILED (FAILED_PERMANENT)
                                     ▼
                         POST /v1/allocations ─▶ SUBMITTED  (sim allocation PENDING → IN_TRANSIT → ARRIVED)
```
- **Hard vetoes** (always review, never sent to Jev): stale data; quantity > `review_above_liters` (5000); an unresolved event whose
  `route_ids`/`station_ids`/`depot_ids` touch the shipment; rerouted around a disrupted faster route.
- **Fixed rule** (used when Jev is disabled or fails): review if any crisis event is ACTIVE, if stockout risk after the shipment is > 25 %,
  or if the series has an unexplained demand anomaly; otherwise auto.
- A new recommendation for the same station+fuel expires the older PROPOSED one. PROPOSED ones older than 8 ticks expire.
- Approval is re-validated against the live world (422 `UNSAFE` with details) and again by the outbox before the first send.

### 3.3 Operator approves a shipment
```
GET  /api/recommendations?status=PROPOSED           → pick id 130
GET  /api/recommendations/130                       → evidence, still_valid, violations
POST /api/simulate {…same station/fuel/route, other quantity…}  → what-if (optional)
POST /api/recommendations/130/approve {"reason":"confirmed with depot","quantity":3500}   (operator)
     → 200 status APPROVED, outbox.status PENDING
SSE  recommendations/allocations
GET  /api/recommendations/130                       → status SUBMITTED, outbox.status SENT, sim_allocation_id 1
GET  /api/allocations                               → allocation 1 PENDING → IN_TRANSIT → ARRIVED as ticks advance
GET  /api/decisions                                 → APPROVE by "operator:asif", outcome.sim_status
```

### 3.4 Crisis during the demo (brief §22 steps 9–10)
```
POST /api/admin/sim/events {"type":"route_disruption","duration_ticks":6,"parameters":{"route_ids":["route-gazipur-mirpur"]}}   (admin)
  → ingestor injects it and immediately re-decides:
    • a PENDING allocation on that route is CANCELLED (depot refunded) — otherwise the simulator FAILs it and keeps the fuel
    • alert loss_prevented (history) and disruption (open, CRITICAL)
    • next tick's plan reroutes via route-patiya-mirpur (review: "rerouted around disrupted route-gazipur-mirpur")
```

### 3.5 Failures (brief §11)
| Injected | What the API shows | Recovery |
|---|---|---|
| `POST /api/admin/sim/faults {"type":"unavailable",…}` | `/api/status.fuel_simulator = "unhealthy: no successful simulator poll for 13s"`; reads keep serving last-known-good (`data_age_seconds` grows) | faults clear → next poll → healthy |
| `{"type":"stale_data"}` | `fuel_simulator = "degraded: simulator reports stale data"`, alert `stale_data`, every recommendation forced to review | clears with the fault |
| `{"type":"error_rate"|"latency"}` | ingestor retries (same bytes), p95 of simulator calls in metrics | automatic |
| intel stopped | `/api/status.decision_engine = "degraded: fallback policy active (…)"`, `/api/overview.decision_source = "fallback"`, alert `decision_engine_fallback` | intel back → next tick `intel` |
| Jev failing | alert `jev_unavailable` (INFO), `/api/status.jev = "degraded: …"`, fixed rule decides | automatic |
| simulator reset | new `epoch_id`; pending proposals expire, unsent outbox fails, alerts resolve | — |

---

## 4. Shared types

### 4.1 Projection (a station+fuel risk series)
| Field | Type | Meaning |
|---|---|---|
| `station_id`, `fuel_type` | string | series |
| `on_hand` | number | liters at the station now |
| `in_transit` | number | PENDING (not doomed) + IN_TRANSIT liters to this station |
| `capacity` | number | station tank capacity for this fuel |
| `demand_next_12h` / `demand_horizon` | number | expected demand over the 48-tick horizon |
| `time_to_stockout_ticks` | int | ticks until the mean path runs dry; **-1 = not within 12 h** |
| `time_to_stockout_hours` | number \| null | same in hours; `null` when -1 |
| `stockout_prob` | number | P(any unmet demand within 12 h), 64-path uniform-noise ensemble |
| `risk_level` | enum | `critical` ≤ 2 h · `high` ≤ 6 h or prob ≥ 0.9 · `elevated` prob ≥ 0.3 or any stockout within 12 h · `normal` |

### 4.2 Recommendation
```json
{
  "id": 130, "epoch_id": 2, "tick": 64,
  "station_id": "station-mirpur", "fuel_type": "OCTANE",
  "depot_id": "depot-patiya", "route_id": "route-patiya-mirpur", "quantity": 4000,
  "policy_version": "greedy-v1",
  "source": "intel",                     // intel | fallback | manual
  "risk_before": 1, "risk_after": 0,     // P(stockout in 12 h) without / with this shipment
  "rule_verdict": "review",              // what the fixed rule says
  "jev_p_auto": null, "jev_model": null, // null: hard veto (not asked) or Jev unavailable; else e.g. 0.78, "jev-1.13.0"
  "verdict": "review",                   // final: auto | review
  "status": "PROPOSED",                  // PROPOSED | APPROVED | REJECTED | SUBMITTED | EXPIRED | FAILED
  "created_at": "2026-09-29T12:39:47.523395+06:00",
  "explanation": { … see 4.3 … },
  "outbox": null                         // or {"status":"SENT","attempts":1,"last_error":null,"sim_allocation_id":1}
}
```
`outbox.status`: `PENDING` (queued) · `SENT` · `REJECTED` (simulator 4xx or pre-flight) · `FAILED_PERMANENT` (gave up / reset).

### 4.3 Explanation (brief §9 — why, signals, constraints, impact, confidence, alternatives)
```json
{
  "arrival_tick": 68, "transit_ticks": 4, "time_to_stockout": 11,
  "binding_constraint": "depot dispatch capacity this tick",   // what capped the quantity
  "signals": { "on_hand": 1753.897, "in_transit": 0, "capacity": 9000, "reorder_point": 3486,
               "demand_next_horizon": 5103, "demand_multiplier": 1.8, "horizon_ticks": 48 },
  "alternatives": [ { "route_id": "route-gazipur-mirpur", "depot_id": "depot-gazipur", "transit_ticks": 2,
                      "rejected": "only 0 L possible (depot dispatch capacity this tick)" } ],
  "review_reasons": ["route_disruption event 2 affects this shipment"],        // hard vetoes
  "rule_reasons":   ["route_disruption event 2 affects this shipment", "crisis active: demand_spike"],
  "features": {                                    // the qualitative state Jev judges (code computes every number)
    "fuel": "OCTANE", "margin": "tight: stockout expected within 6 hours",
    "route": "cross-region (slower, draws on the other region's depot)",
    "shipment_size": "normal (under one day's demand)", "active_crises": "demand_spike",
    "demand_signal": "abnormal spike, explained by an active demand spike", "data_freshness": "fresh",
    "stockout_risk_now": "high", "stockout_risk_after_shipment": "low", "depot_stock_after_shipment": "healthy"
  },
  "…": "plus the recommendation's own fields repeated"
}
```
`binding_constraint` is one of: `station room incl. in-transit`, `route max_shipment`, `depot inventory (after captive reserve)`, `depot dispatch capacity this tick`.
Manual allocations carry `{"manual": true, "reason": "...", "what_if": {…§5.12 response…}}` instead.

### 4.4 Command (simulator control)
```json
{ "id": 21, "kind": "step", "payload": {"count": 4}, "status": "DONE",
  "result": {"tick": 64, "stepped": 4}, "error": null,
  "requested_by": "admin:asif", "created_at": "…", "done_at": "…" }
```
`kind`: `step | run | pause | reset | event | fault | faults_clear | cancel_allocation` · `status`: `PENDING | DONE | FAILED`.

---

## 5. Endpoint reference

| # | Method & path | Role | Purpose |
|---|---|---|---|
| 5.1 | `GET /api/overview` | viewer | dashboard header |
| 5.2 | `GET /api/status` | viewer | §15 system status |
| 5.3 | `GET /api/network` | viewer | depots, stations, routes, live |
| 5.4 | `GET /api/risk` | viewer | projected shortage risk |
| 5.5 | `GET /api/demand` | viewer | demand history + forecast per series |
| 5.6 | `GET /api/demand/regions` | viewer | regional demand |
| 5.7 | `GET /api/supply` | viewer | incoming supply, delays, shortfalls |
| 5.8 | `GET /api/events` | viewer | disruptions |
| 5.9 | `GET /api/alerts` · `POST /api/alerts/{id}/ack` | viewer · operator | alerts |
| 5.10 | `GET /api/recommendations` · `GET /api/recommendations/{id}` | viewer | recommendations |
| 5.11 | `POST /api/recommendations/{id}/approve` · `/reject` | operator | human decision |
| 5.12 | `POST /api/simulate` | viewer | what-if |
| 5.13 | `GET /api/allocations` · `POST /api/allocations` · `POST /api/allocations/{id}/cancel` | viewer · operator · operator | shipments |
| 5.14 | `GET /api/decisions` | viewer | decision history |
| 5.15 | `GET /api/intel/quality` | viewer | intelligence evidence |
| 5.16 | `GET /api/policy` · `PUT /api/policy` | viewer · admin | policy settings |
| 5.17 | `POST /api/admin/sim/step\|run\|pause\|reset` | admin | simulator control |
| 5.18 | `POST /api/admin/sim/events` | admin | inject crisis |
| 5.19 | `POST /api/admin/sim/faults` · `/faults/clear` | admin | inject software fault |
| 5.20 | `GET /api/admin/commands` · `/{id}` | admin | command log |
| 5.21 | `GET /api/me` | viewer | caller's role |
| 5.22 | `GET /api/state` | viewer | raw latest snapshot (debug) |
| 5.23 | `GET /api/stream` | viewer | SSE ([§6](#6-live-stream-sse)) |

### 5.1 `GET /api/overview`
Dashboard header. No parameters. `503 NO_SNAPSHOT` before the first poll.
```json
{
  "simulation_only": true,
  "epoch_id": 2, "scenario_id": "baseline",
  "tick": 64, "sim_time": "2026-01-01T16:00:00", "sim_status": "PAUSED", "tick_minutes": 15,
  "stale": false,                 // simulator flagged its data stale (stale_data fault)
  "data_age_seconds": 7.73,       // age of the snapshot being served
  "degraded": false,              // stale OR decision engine on fallback
  "sim_metrics": { "served_demand_liters": 56276.406, "unmet_demand_liters": 0, "service_level": 1,
                   "allocation_liters": 0, "allocation_failures": 0 },   // from the simulator (refreshed every ~5 s); may be null at startup
  "open_alerts": { "critical": 1, "warn": 11, "info": 7 },
  "review_queue": 6,              // PROPOSED recommendations waiting for a human
  "disruptions": { "active": 1, "scheduled": 1 },
  "decision_source": "intel",     // intel | fallback
  "auto_execute": true,
  "inventory_liters": { "depots": {"DIESEL": 149000, "PETROL": 101000, "OCTANE": 59000},
                        "stations": {"DIESEL": 8133.563, "PETROL": 9689.253, "OCTANE": 6313.914},
                        "in_transit": {} }
}
```

### 5.2 `GET /api/status`
Brief §15 System Status. Always 200. Component values: `"healthy"`, `"degraded: <reason>"`, `"unhealthy: <reason>"`.
| Field | Source |
|---|---|
| `backend_api` | this process |
| `database` | Postgres ping |
| `fuel_simulator` | ingestor heartbeat (unhealthy if no successful poll for > 10 s; a PAUSED simulator is healthy); `degraded` when data is flagged stale |
| `prediction_service` | intel `/healthz` |
| `decision_engine` | intel reachable, else `degraded: fallback policy active (…)` (decisions continue in-process) |
| `jev` | `configured` · `disabled: fixed review rule only` · `degraded: unavailable, fixed review rule deciding` |
| `p95_latency_ms`, `error_rate`, `requests_5m` | this replica's API requests over 5 min (excludes the SSE stream, probes and admin simulator commands) |
```json
{ "backend_api": "healthy", "database": "healthy", "fuel_simulator": "healthy", "prediction_service": "healthy",
  "decision_engine": "healthy", "jev": "configured", "p95_latency_ms": 12.4, "error_rate": 0, "requests_5m": 812 }
```

### 5.3 `GET /api/network`
The live map. `503 NO_SNAPSHOT`.
```json
{
  "tick": 64,
  "regions": [ { "id": "region-dhaka", "name": "Dhaka Division", "demand_factor": 1 }, … ],
  "depots": [ {
    "id": "depot-gazipur", "name": "Gazipur Depot", "region_id": "region-dhaka", "status": "OPEN",   // OPEN | CONSTRAINED (cosmetic in the simulator)
    "dispatch_capacity_per_tick": 12000, "dispatch_left_this_tick": 12000,                         // shared across all fuels
    "fuels": { "DIESEL": { "inventory": 78000, "capacity": 90000, "fill": 0.867 }, … } } ],
  "stations": [ {
    "id": "station-mirpur", "name": "Mirpur Fuel Station", "region_id": "region-dhaka",
    "status": "OPEN",                                   // OPEN | OUTAGE
    "demand_profile": "urban_high", "demand_multiplier": 1.8,   // >1 while a demand_spike is active
    "fuels": { "PETROL": { "inventory": 2862.86, "capacity": 14000, "fill": 0.204,
                           "in_transit": 0, "room_after_in_transit": 11137.14,
                           "stockout_prob": 1, "time_to_stockout_ticks": 10, "time_to_stockout_hours": 2.5,
                           "risk_level": "high", "demand_next_12h": 9568.125 }, … } } ],
  "routes": [ {
    "id": "route-gazipur-mirpur", "source_depot_id": "depot-gazipur", "destination_station_id": "station-mirpur",
    "transit_ticks": 2, "max_shipment": 7000, "status": "AVAILABLE",     // AVAILABLE | DISRUPTED
    "usable_now": true,              // false if disrupted at the departure tick, including scheduled events starting now
    "cross_region": false,
    "disruptions": [ { "event_id": 2, "status": "SCHEDULED", "start_tick": 66, "end_tick": 70 } ] } ]
}
```
`room_after_in_transit` is the most a new shipment can carry without overflow (the simulator ignores in-transit fuel and destroys the excess).

### 5.4 `GET /api/risk`
Every station×fuel series, most urgent first (soonest stockout, then highest probability, then lowest cover).
```json
{ "tick": 64, "horizon_ticks": 48,
  "method": "tick-by-tick projection of on-hand + in-transit − forecast demand; probability from a uniform-noise ensemble",
  "series": [ { "station_id": "station-tongi", "station_name": "Tongi Industrial Station", "fuel_type": "DIESEL",
                "risk_level": "critical", "stockout_prob": 1, "time_to_stockout_ticks": 0, "time_to_stockout_hours": 0,
                "on_hand": 0, "in_transit": 0, "capacity": 18000, "demand_next_12h": 7980,
                "cover_ratio": 0 } ] }      // (on_hand+in_transit)/demand_next_12h
```

### 5.5 `GET /api/demand`
| Query | Default | Meaning |
|---|---|---|
| `station_id` | all | filter |
| `fuel_type` | all | filter |
| `ticks` | 96 (1–2000) | history window |
| `horizon` | 48 (0–192) | forecast ticks ahead |
```json
{ "tick": 64,
  "series": [ { "station_id": "station-mirpur", "fuel_type": "PETROL",
    "history":  [ { "tick": 63, "demand": 146.728, "served": 146.728, "unmet": 0,
                    "forecast": 137.8125 } ],          // forecast recorded BEFORE that tick was simulated (null if none)
    "forecast": [ { "tick": 64, "expected": 285.47, "low": 256.92, "high": 314.02 } ] } ] }   // band = ±profile noise
```
The forecast is the published demand model (profile × hour-of-day × region factor × current multiplier, plus scheduled spikes). Expected is 0 while a station is in OUTAGE.

### 5.6 `GET /api/demand/regions`
Query `ticks` (default 96, 1–2000) = aggregation window.
```json
{ "tick": 64, "window_ticks": 96,
  "regions": [ { "region_id": "region-dhaka", "name": "Dhaka Division", "demand_factor": 1,
                 "station_ids": ["station-mirpur", "station-tongi"],
                 "fuels": { "DIESEL": { "demand": 16187.28, "served": 15912.44, "unmet": 274.84, "service_level": 0.983,
                                        "forecast_next_12h": 15725.63, "max_demand_multiplier": 1.8 }, … } } ] }
```

### 5.7 `GET /api/supply`
Scheduled depot supply. Delay and shortfall are measured against the schedule **as first seen in this epoch** (the simulator overwrites
`planned_tick`/`quantity` in place when a `shipment_delay`/`supply_shortfall` event fires).
```json
{ "tick": 64,
  "arrivals": [
    { "id": "supply-101", "depot_id": "depot-gazipur", "fuel_type": "DIESEL", "status": "SCHEDULED",   // SCHEDULED | DELAYED | ARRIVED
      "quantity": 12000, "planned_tick": 64, "actual_tick": null,
      "original_quantity": 12000, "original_planned_tick": 64, "delay_ticks": 0, "shortfall_liters": 0,
      "eta_ticks": 0,                 // not ARRIVED only
      "clip_risk_liters": 0 },        // not ARRIVED only: liters that would be lost to a full depot right now
    { "id": "supply-001", "status": "ARRIVED", "actual_tick": 12, … } ] }
```

### 5.8 `GET /api/events`
Crisis events (organizer-injected, preloaded, or via 5.18), newest first.
```json
{ "tick": 64,
  "events": [ { "id": 2, "type": "route_disruption", "status": "SCHEDULED",     // SCHEDULED | ACTIVE | RESOLVED
                "start_tick": 66, "end_tick": 70, "starts_in_ticks": 2, "ends_in_ticks": 6,
                "parameters": { "route_ids": ["route-patiya-mirpur"] },
                "effective": true,     // false: route/station/depot event with an empty id list — the simulator ignores it
                "description": "routes [route-patiya-mirpur] unusable, ticks 66–70: new shipments rejected, PENDING ones fail at departure" } ] }
```
Event windows are **inclusive** (`start_tick…end_tick`). `shipment_delay` and `supply_shortfall` apply once, at `start_tick`.

### 5.9 Alerts
**`GET /api/alerts`** — query `state=open|all` (default `open`), `limit` (default 200, max 2000). Open first, then CRITICAL → WARN → INFO, newest first.
```json
{ "alerts": [ { "id": 458, "epoch_id": 2, "tick": 19,          // tick first detected
                "kind": "stockout_risk", "severity": "CRITICAL", "subject": "station-tongi:DIESEL",
                "detail": { "stockout_prob": 1, "on_hand": 0, "in_transit": 0, "demand_next_12h": 7980,
                            "time_to_stockout_ticks": 0, "time_to_stockout_hours": 0 },
                "open": true, "created_at": "…", "resolved_at": null, "acked_at": null, "acked_by": null } ] }
```
An alert stays open while its condition holds (`detail` and `severity` refresh each tick) and resolves by itself when it clears. Kinds: [§7](#7-alert-catalog).

**`POST /api/alerts/{id}/ack`** (operator) — no body. `200 {"id": 458, "acked_by": "operator:asif"}` · `409 NOT_ACKABLE` (unknown or already acked).

### 5.10 Recommendations
**`GET /api/recommendations`** — current epoch, newest first. Query `status` = comma list (e.g. `PROPOSED` or `APPROVED,SUBMITTED`), `limit` (default 100, max 1000).
```json
{ "tick": 64, "recommendations": [ { …Recommendation (4.2)… } ] }
```
**`GET /api/recommendations/{id}`** — any epoch. `404 NOT_FOUND` · `400 INVALID_ID`.
```json
{ "recommendation": { …Recommendation… },
  "decisions": [ { "id": 3, "actor": "operator:asif", "action": "APPROVE", "reason": "confirmed with depot", "created_at": "…" } ],
  "sim_allocation": { …simulator allocation, when submitted and still in the current world… },
  "still_valid": true,      // PROPOSED only: safe to execute against the live world AND same epoch
  "violations": [] }        // PROPOSED only: what would fail now
```

### 5.11 Approve / reject (operator)
**`POST /api/recommendations/{id}/approve`** — body optional:
```json
{ "reason": "confirmed with depot",   // optional, ≤ 500 chars
  "quantity": 3500 }                  // optional edit, floored to whole liters; re-validated
```
| Status | When |
|---|---|
| 200 | Recommendation with `status: "APPROVED"`, `outbox.status: "PENDING"`; the ingestor submits within ~1 s |
| 401 | not operator/admin |
| 404 / 400 | unknown / bad id |
| 409 `NOT_PROPOSED` | already approved, rejected, expired, … |
| 409 `EXPIRED` | proposed in an earlier epoch (simulator reset since) |
| 422 `UNSAFE` | executing now would be rejected by the simulator or lose fuel; `details` lists why |

**`POST /api/recommendations/{id}/reject`** — body `{"reason": "depot crew unavailable"}` (required, 1–500 chars) → 200 Recommendation `status: "REJECTED"`. Errors as approve, plus 400 `INVALID_BODY` without a reason.

### 5.12 `POST /api/simulate` — what-if (no side effects)
```json
{ "station_id": "station-mirpur", "fuel_type": "PETROL", "route_id": "route-gazipur-mirpur", "quantity": 4000 }
```
```json
{ "tick": 33, "proposal": { …as sent… },
  "valid": true,
  "violations": [],            // every reason it would be rejected or lose fuel (see list below)
  "before": { "stockout_prob": 1, "time_to_stockout_ticks": 39, "time_to_stockout_hours": 9.75, "risk_level": "high", "position": 4347.4 },
  "after":  { "stockout_prob": 0, "time_to_stockout_ticks": -1, "time_to_stockout_hours": null, "risk_level": "normal", "position": 8347.4 },
  "risk_reduction": 1,
  "arrival_tick": 35 }
```
Violations checked (same function the outbox pre-flight uses): unknown route/station/fuel, non-positive quantity, route does not serve
the station, station not OPEN, **route disrupted at the departure tick** (scheduled or active), quantity > route `max_shipment`,
depot inventory, **per-depot all-fuel dispatch capacity left this tick**, **station room counting in-transit**.
`before`/`after` are omitted if the station or route is unknown.

### 5.13 Allocations
**`GET /api/allocations`** — simulator allocations of the current world, plus our submissions that are not `SENT`.
```json
{ "tick": 33,
  "allocations": [ { "id": 1, "idempotency_key": "fuelops-e1-r5", "source_depot_id": "depot-gazipur",
                     "destination_station_id": "station-tongi", "route_id": "route-gazipur-tongi", "fuel_type": "DIESEL",
                     "quantity": 6500, "created_tick": 32, "departure_tick": 32, "expected_arrival_tick": 34,
                     "actual_arrival_tick": null, "status": "IN_TRANSIT",   // PENDING | IN_TRANSIT | ARRIVED | FAILED | CANCELLED
                     "failure_reason": null,
                     "origin": "fuelops",          // fuelops (ours) | external (made outside this system)
                     "recommendation_id": 5 } ],
  "queued": [ { "outbox_id": 9, "recommendation_id": 44, "status": "REJECTED", "attempts": 1,
                "last_error": "PREFLIGHT: would overflow station-mirpur: …",
                "request": { …exact POST /v1/allocations body… }, "updated_at": "…" } ] }
```
**`POST /api/allocations`** (operator) — the operator's own shipment:
```json
{ "station_id": "station-mirpur", "fuel_type": "PETROL", "route_id": "route-gazipur-mirpur", "quantity": 4000,
  "reason": "pre-position before spike" }            // reason required, 1–500 chars; quantity floored
```
→ **201** Recommendation (`source: "manual"`, `policy_version: "manual"`, `status: "APPROVED"`, `verdict: "review"`, explanation carries the what-if) and an APPROVE decision; submitted via the outbox.
Errors: 422 `UNSAFE` (with details) · 409 `DUPLICATE` (a manual allocation for this station+fuel already made this tick) · 400 · 401.

**`POST /api/allocations/{id}/cancel`** (operator) — `{id}` is the **simulator** allocation id; only `PENDING` can be cancelled (the depot is refunded).
→ 200 Command (4.4) with `result` = the cancelled simulator allocation · 404 `NOT_FOUND` · 409 `CANNOT_CANCEL` · 502 `SIM_COMMAND_FAILED`.

### 5.14 `GET /api/decisions`
Audit trail across epochs, newest first. Query `limit` (default 100, max 1000).
```json
{ "decisions": [ {
    "id": 7, "created_at": "…", "actor": "auto", "action": "AUTO_EXECUTE",    // APPROVE | REJECT | AUTO_EXECUTE
    "reason": "rule: no review reasons",                                       // or "jev p_auto 0.93 >= 0.80", or the operator's text
    "recommendation": { "id": 41, "epoch_id": 1, "tick": 64, "station_id": "station-coxsbazar", "fuel_type": "DIESEL",
                        "route_id": "route-patiya-coxsbazar", "quantity": 4000, "status": "SUBMITTED", "source": "intel",
                        "verdict": "auto", "risk_before": 1, "risk_after": 0 },
    "outcome": { "submission": "SENT", "error": null, "sim_allocation_id": 7,
                 "sim_status": "ARRIVED" } } ] }     // sim_status only when the allocation is in the current world
```

### 5.15 `GET /api/intel/quality`
Evidence for judges. Query `ticks` (window for forecast error, default 96).
```json
{ "tick": 64, "window_ticks": 96,
  "forecast": { "observations": 768, "mape": 0.054, "naive_mape": 0.085,
                "note": "expected demand is recorded before each tick is simulated; naive = the previous tick's observed demand" },
  "recommendations": { "by_source_verdict": { "intel:review": 70 }, "by_status": { "EXPIRED": 64, "PROPOSED": 6 } },
  "outbox": { "SENT": 2 },
  "jev": { "asked": 21, "avg_p_auto": 0.457, "agreed_with_rule": 3, "overrode_rule": 18 },
  "alerts_by_kind": { "stockout_risk": 11, "demand_anomaly": 6, "disruption": 1, "disruption_upcoming": 2 },
  "sim_metrics": { … } }
```

### 5.16 Policy
**`GET /api/policy`**
```json
{ "policy_version": "greedy-v1", "auto_execute": true, "jev_threshold": 0.8, "jev_configured": true,
  "updated_by": "admin", "updated_at": "…",
  "options": { "horizon_ticks": 48, "monte_carlo_runs": 64, "safety_ticks": 24, "min_lot_liters": 500, "review_above_liters": 5000 },
  "review_rule": [ "hard veto (always review): …", "otherwise Jev decides: …", "if Jev is off or fails, the fixed rule decides: …" ] }
```
**`PUT /api/policy`** (admin) — `{"auto_execute": false}` and/or `{"jev_threshold": 0.85}` (0 < x ≤ 1). Omitted fields keep their value.
→ 200 same shape as GET. Takes effect at the next decided tick.

### 5.17 Simulator control (admin)
The api validates and queues a command; the ingestor executes it; the api waits up to 25 s.
**200** = done (Command) · **202** = still running (Command with `status: "PENDING"`; poll 5.20) · **502** `SIM_COMMAND_FAILED` =
`{"error": {...}, "command": {...}}` with the simulator's reason.

| Endpoint | Body | Effect / `result` |
|---|---|---|
| `POST /api/admin/sim/step` | `{"count": 4}` (1–96, default 1; body optional) | steps one tick at a time and runs the full decide → submit cycle after each, exactly as if running. `{"tick": 64, "stepped": 4}` |
| `POST /api/admin/sim/run` | — | real-time ticking (`SIMULATION_SPEED` ticks/s). `{"tick", "status": "RUNNING"}` |
| `POST /api/admin/sim/pause` | — | `{"tick", "status": "PAUSED"}` |
| `POST /api/admin/sim/reset` | — | back to tick 0, paused; opens a new epoch. `{"tick": 0, "status": "PAUSED"}` |

### 5.18 `POST /api/admin/sim/events` (admin) — inject a crisis
```json
{ "type": "demand_spike",
  "start_tick": 70,          // optional absolute tick; if omitted: current tick + start_in
  "start_in": 0,             // optional, 0–2000
  "duration_ticks": 12,      // 1–2000; the window is inclusive: start…start+duration
  "parameters": { "multiplier": 1.8, "region_ids": ["region-dhaka"] } }
```
| `type` | Allowed parameters | Rules enforced here (the simulator does not) |
|---|---|---|
| `demand_spike` | `multiplier` (0.05–10, default 1.5), `station_ids`, `region_ids` | multiplier 0 would permanently crash the simulator's tick loop; empty filters = all stations |
| `route_disruption` | `route_ids` | ≥ 1 id (empty = no effect in the simulator) |
| `station_outage` | `station_ids` | ≥ 1 id |
| `depot_constraint` | `depot_ids` | ≥ 1 id (status only; the simulator changes no capacity) |
| `shipment_delay` | `delay_ticks` (1–500, default 2), `depot_ids`, `fuel_types` | empty = all |
| `supply_shortfall` | `factor` (0–1, default 0.5), `depot_ids`, `fuel_types` | empty = all |

All ids must exist in the live world; unknown parameters are rejected. → 400 `INVALID_EVENT` with `details`, or the Command whose
`result` is the simulator's event row (`{"id", "type", "status", "start_tick", "end_tick", "parameters"}`). After injecting, the ingestor
re-decides immediately (e.g. cancels PENDING allocations the event dooms).

### 5.19 Faults (admin)
**`POST /api/admin/sim/faults`**
```json
{ "type": "latency", "duration_seconds": 60, "parameters": { "delay_ms": 1000 } }
```
| `type` | Parameter | Effect in the simulator |
|---|---|---|
| `latency` | `delay_ms` 0–10000 | every `/v1` request delayed |
| `unavailable` | — | every `/v1` request 503 (health stays OK) |
| `error_rate` | `rate` 0–1 | that share of `/v1` requests 503 |
| `stale_data` | — | `X-Simulator-Stale: true` on reads |
| `stream_disconnect` | — | new SSE connections refused |

`duration_seconds` 1–3600 (wall clock). → Command (`result` = the simulator's fault row) · 400 `INVALID_FAULT`.
**`POST /api/admin/sim/faults/clear`** → Command `{"status": "cleared"}`.

### 5.20 Command log (admin)
`GET /api/admin/commands?limit=50` → `{"commands": [Command…]}` newest first · `GET /api/admin/commands/{id}` → Command · 404.

### 5.21 `GET /api/me`
`{"role": "operator", "actor": "operator:asif", "auth_enabled": true}` — use it to show or hide action buttons.

### 5.22 `GET /api/state`
Raw latest snapshot for debugging: `{"tick", "stale", "captured_at", "age_seconds", "snapshot": {instance, regions, depots, stations, routes, events, allocations, supply_arrivals, stale, metrics}}`, or `{"tick": null}` before the first poll.

---

## 6. Live stream (SSE)

`GET /api/stream` → `text/event-stream`. No auth. Starts with `retry: 3000`, then the latest `tick` event, then changes as they happen
(checked every 500 ms, and immediately after a write on the same replica). `: keepalive` every 15 s.

| Event | `data` | Refetch |
|---|---|---|
| `tick` | `{"tick": 64, "sim_status": "PAUSED", "stale": false}` (any new snapshot, not only new ticks) | overview, network, risk, demand, supply, events |
| `alerts` | `{"open": 19}` | alerts |
| `recommendations` | `{"latest_id": 130}` (new recommendation or decision) | recommendations, decisions |
| `allocations` | `{"tick": 64}` (outbox change or new snapshot) | allocations |
| `commands` | `{"latest_id": 21}` | command log |

```js
const es = new EventSource("/api/stream");
es.addEventListener("tick", () => queryClient.invalidateQueries({ queryKey: ["overview"] }));
es.addEventListener("alerts", () => queryClient.invalidateQueries({ queryKey: ["alerts"] }));
```
Events carry no payload beyond what changed; a slow client may miss one, and its next refetch catches it up.

---

## 7. Alert catalog

`subject` format in brackets. Standing alerts open while the condition holds and resolve by themselves; one-shot alerts are stored already resolved (history).

| kind | subject | severity | Opens when | detail |
|---|---|---|---|---|
| `stockout_risk` | `station:FUEL` | CRITICAL ≤ 2 h to stockout, else WARN | ≤ 6 h to stockout, or P(stockout in 12 h) ≥ 0.9 (OPEN stations) | `stockout_prob, on_hand, in_transit, demand_next_12h, time_to_stockout_ticks, time_to_stockout_hours` |
| `station_outage` | `station` | CRITICAL | station status OUTAGE | `status, message` |
| `demand_anomaly` | `station:FUEL` | WARN unexplained · INFO explained | mean(observed/normal) over the last 4 ticks departs from 1 by > max(4σ, 10 %) | `direction (spike\|drop), ratio, threshold, window_ticks, message` |
| `disruption` | `event-ID` | CRITICAL route/station, else WARN | event ACTIVE | `type, start_tick, end_tick, parameters` |
| `disruption_upcoming` | `event-ID` | INFO | event SCHEDULED within 8 ticks | + `starts_in_ticks` |
| `supply_delay` | supply id | WARN | `planned_tick` later than first seen (not yet arrived) | `depot_id, fuel_type, original_tick, planned_tick, delay_ticks` |
| `supply_shortfall` | supply id | WARN | `quantity` below first seen | `original_liters, liters, missing_liters` |
| `depot_low` | `depot:FUEL` | WARN | depot below 10 % of capacity | `inventory, capacity, fill` |
| `allocation_failed` | `allocation-ID` | CRITICAL | a simulator allocation FAILED (its fuel was not refunded) | `route_id, liters, fuel_type, reason` |
| `stale_data` | `simulator` | WARN | simulator flags data stale | `message` |
| `decision_engine_fallback` | `intel` | WARN | intel unreachable; fallback decided | `error, message` |
| `jev_unavailable` | `jev` | INFO | Jev call failed; fixed rule decided | `error, message` |
| `loss_prevented` *(one-shot)* | `allocation-ID` | INFO | a doomed PENDING allocation was cancelled | `allocation_id, route_id, liters, fuel_type, message` |

---

## 8. Error codes

| HTTP | code | Where |
|---|---|---|
| 400 | `INVALID_BODY` | malformed JSON, unknown field, missing reason, bad range |
| 400 | `INVALID_ID` | path id not a positive integer |
| 400 | `INVALID_QUERY` | `/api/alerts?state=` not `open`/`all` |
| 400 | `INVALID_EVENT` / `INVALID_FAULT` | crisis/fault input rejected (`details`) |
| 401 | `UNAUTHORIZED` | missing/insufficient role |
| 404 | `NOT_FOUND` | recommendation, allocation or command |
| 409 | `NOT_PROPOSED` | approve/reject a non-PROPOSED recommendation |
| 409 | `EXPIRED` | recommendation from an earlier epoch |
| 409 | `DUPLICATE` | second manual allocation for the same station+fuel in one tick |
| 409 | `CANNOT_CANCEL` | allocation is not PENDING |
| 409 | `NOT_ACKABLE` | alert unknown or already acknowledged |
| 422 | `UNSAFE` | would be rejected by the simulator or lose fuel (`details`) |
| 500 | `INTERNAL` | unexpected (logged) |
| 502 | `SIM_COMMAND_FAILED` | the simulator refused an admin command |
| 503 | `NO_SNAPSHOT` | no simulator data yet |

---

## 9. Internal contracts

### 9.1 intel `POST /v1/plan` (ingestor → intel, :8082)
Request (16 MiB max; world validated, 400 on invalid):
```json
{ "world": { …sim.World: instance, regions, depots, stations, routes, events, allocations, supply_arrivals, stale… },
  "demand": [ { "station_id", "fuel_type", "tick", "demand_liters" }, … ],   // ticks ≥ now − 4, for anomaly detection
  "jev_threshold": 0.8 }
```
Response:
```json
{ "tick": 64, "policy_version": "greedy-v1", "source": "intel",
  "recommendations": [ { …policy.Recommendation…, "rule_verdict", "rule_reasons", "jev_p_auto", "verdict", "features" } ],
  "risks": [ …Projection… ],
  "cancel": [ …PENDING allocations doomed by a disruption at departure… ],
  "anomalies": [ { "station_id", "fuel_type", "direction", "ratio", "threshold", "window_ticks", "explained_by" } ],
  "jev": { "enabled": true, "asked": 3, "model": "jev-1.13.0", "latency_ms": 840, "error": "" } }
```
The ingestor rejects a response whose `tick` differs from the request. Timeout 4 s. On any failure it runs the same `Evaluate`
in-process with Jev disabled and `source: "fallback"`.

### 9.2 Jev (intel → TypeSafe, optional)
`POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY`, timeout 2 s, one call per tick with one Noul per
non-vetoed recommendation:
```json
{ "model": "jev-latest",
  "state": { "context": "Operations center of a SIMULATED fuel supply network …",
             "shipments": { "s1": { "margin": "…", "route": "…", "shipment_size": "…", "demand_signal": "…", … } } },
  "questions": { "s1": { "type": "noul",
                         "instructions": "May shipment `shipments.s1` execute automatically, without a human operator reviewing it first?",
                         "criteria": { "true": "Routine replenishment: …", "false": "Unusual or high-stakes: …" } } } }
```
Response `answers.s1.noul` ∈ [0,1] is validated (missing/out of range = failure → fixed rule). No numbers are sent; code computes them.

### 9.3 Outbox → simulator
- Idempotency key `fuelops-e{epoch_id}-r{recommendation_id}`; body `{"idempotency_key","source_depot_id","destination_station_id","route_id","fuel_type","quantity"}` stored once and resent byte-for-byte.
- Before the first attempt: the same validation as `/api/simulate` against the live world; failing → `REJECTED` with `PREFLIGHT: …`.
- 201 → `SENT` + `sim_allocation_id`, recommendation `SUBMITTED`. 4xx (except `DISPATCH_CAPACITY_EXCEEDED`) → `REJECTED`, recommendation `FAILED`.
  5xx / timeout / dispatch cap → retry (≤ 5 attempts); if the key appears in the simulator's allocations it is marked `SENT` (the earlier attempt succeeded).

### 9.4 Command queue (`sim_commands`)
api inserts `{kind, payload, requested_by}`; the ingestor executes in id order (non-idempotent simulator calls are never retried) and writes
`status`, `result`, `error`, `done_at`. Payloads: `step {count}` · `event {type, start_tick?, start_in, duration_ticks, parameters}` ·
`fault {type, duration_seconds, parameters}` · `cancel_allocation {allocation_id}` · `run|pause|reset|faults_clear {}`.

### 9.5 Tables (migration `00004_operator.sql`)
`recommendations` (+ `depot_id, source, verdict, jev_model`; status adds `FAILED`) · `decisions` · `outbox` · `alerts` (+ `acked_at, acked_by`;
one open alert per `(epoch, kind, subject)`) · `settings` (single row: `auto_execute`, `jev_threshold`) · `forecasts` (expected + naive per
tick/series, for prediction error) · `sim_commands` · plus `snapshots`, `sim_epochs`, `demand_observations`, `ingestor_heartbeat`.

### 9.6 Single writer
The ingestor takes Postgres advisory lock `0x6675656c` on a dedicated connection before doing anything. A second copy waits (its `/healthz`
is 503 "standby") and takes over when the first dies. On restart it resumes the latest matching epoch, so approvals and the outbox survive.

---

## 10. Health, metrics, tracing

Every process: `GET /healthz` (readiness: 200 `{"status":"ok"}` / 503 `{"status":"unhealthy","error":…}`) · `GET /version` · `GET /metrics`.

**Prometheus** — every process: `http_requests_total{route,method,code}`, `http_request_duration_seconds{route,method}`.
Ingestor: `sim_requests_total{path,code}`, `sim_inflight` (must stay ≤ 4), `sim_request_duration_seconds{path}`, `sim_stale_responses_total`,
`sim_tick`, `sim_service_level`, `sim_sse_connected`, `sim_sse_reconnects_total{reason}`, `ingestor_snapshots_total`, `ingestor_poll_errors_total`,
`decisions_total{source,verdict}`, `decision_fallback_total`, `review_queue_depth`, `stockout_probability{station,fuel}`, `alerts_open{severity}`,
`outbox_results_total{result}`, `allocations_cancelled_to_prevent_loss_total`, `forecast_mape{model=forecast|naive}`.
Intel: `jev_requests_total{result}`, `jev_request_duration_seconds`.

**OpenTelemetry** — enabled when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (OTLP/gRPC). Spans for HTTP server/client and Postgres queries; trace
context propagates api→intel, ingestor→intel, ingestor→simulator and intel→Jev. OTel metrics: `fuelops_snapshots_total`,
`fuelops_poll_errors_total`, `fuelops_fallback_activations_total{component=intel|jev}`, `fuelops_sim_service_level`, `fuelops_sim_tick`.
Local: Jaeger `:16686`, collector metrics `:8889`.

**Chaos flags** (api, intel) for the rollback demo: `CHAOS_500_PCT` (0–100), `FAIL_HEALTH` (true/1). Probes, `/metrics`, `/version` are never failed.

**Configuration**: `DATABASE_URL`, `SIM_BASE_URL`, `SIM_MAX_INFLIGHT` (4), `SIM_TIMEOUT` (1.5s), `POLL_INTERVAL` (1s), `INTEL_URL`,
`TYPESAFE_API_KEY` (optional), `OPERATOR_TOKEN`, `ADMIN_TOKEN`, `HTTP_ADDR`.
