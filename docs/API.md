# Backend API (served by `fuelops api` on :8080, same origin as the frontend under /api)

## GET /api/state
Latest simulator snapshot.
```json
{ "tick": 42, "stale": false, "captured_at": "2026-09-29T09:30:00Z", "age_seconds": 0.8,
  "snapshot": { "instance": { "scenario_id": "baseline", "seed": 12345, "tick": 42, "status": "RUNNING", "sim_time": "2026-01-01T10:30:00", "tick_minutes": 15 } } }
```
Before the first poll: `{ "tick": null }`. TODO(P1): stations, depots, routes, events, allocations, supply, risk.

## GET /api/status
Brief §15 System Status. Each value is `"healthy"` or `"unhealthy: <reason>"`.
```json
{ "backend_api": "healthy", "database": "healthy", "fuel_simulator": "healthy", "decision_engine": "healthy" }
```

## Every process
`GET /healthz` → 200 `{"status":"ok"}` or 503 `{"status":"unhealthy","error":"..."}` · `GET /version` → `{"service","version"}` · `GET /metrics` (Prometheus).

## Planned (P1)
`GET /api/recommendations`, `POST /api/recommendations/{id}/approve|reject`, `GET /api/alerts`, `GET /api/decisions`, `GET /api/stream` (SSE to browser).
