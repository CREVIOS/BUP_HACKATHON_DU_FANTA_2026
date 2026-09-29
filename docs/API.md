# Backend API (served by `fuelops api` on :8080, same origin as the frontend under /api)

## GET /api/state
Latest simulator snapshot.
```json
{ "tick": 42, "stale": false, "captured_at": "2026-09-29T09:30:00Z", "age_seconds": 0.8,
  "snapshot": { "instance": { "scenario_id": "baseline", "seed": 12345, "tick": 42, "status": "RUNNING", "sim_time": "2026-01-01T10:30:00", "tick_minutes": 15 } } }
```
Before the first poll: `{ "tick": null }`. TODO(P1): stations, depots, routes, events, allocations, supply, risk.

## GET /api/status
Brief §15 System Status. Each value is `"healthy"` or `"unhealthy: <reason>"`. `fuel_simulator` is judged by the ingestor's last successful poll (a PAUSED sim is healthy); the run state is `snapshot.instance.status` in `/api/state`.
```json
{ "backend_api": "healthy", "database": "healthy", "fuel_simulator": "healthy", "decision_engine": "healthy" }
```

## Every process
`GET /healthz` → 200 `{"status":"ok"}` or 503 `{"status":"unhealthy","error":"..."}` · `GET /version` → `{"service","version"}` · `GET /metrics` (Prometheus).

## Metrics (every process)
`http_requests_total{route,method,code}` and `http_request_duration_seconds{route,method}`, where `route` = the mux pattern (e.g. `GET /api/state`, `unmatched`). The ingestor also exports `sim_requests_total{path,code}`, `sim_inflight`, `sim_request_duration_seconds{path}`, `sim_stale_responses_total` and `sim_tick`.

## Tracing & OTel metrics (every process)
Enabled when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (OTLP/gRPC; also honors `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_RESOURCE_ATTRIBUTES`). Spans: HTTP server + client (`otelhttp`, span named by route), Postgres queries (`otelpgx`); W3C trace context propagates api→intel and ingestor→simulator. OTel metrics (exported via OTLP, in addition to the Prometheus `/metrics` above): `fuelops_snapshots_total`, `fuelops_poll_errors_total`, `fuelops_fallback_activations_total{component}`, `fuelops_sim_service_level`, `fuelops_sim_tick`. Local: Jaeger UI `:16686`, collector metrics `:8889`. Unset the env var and the SDK is a no-op.

## Chaos flags (api, intel)
`CHAOS_500_PCT` (0–100) and `FAIL_HEALTH` (true/1). Probes, `/metrics` and `/version` are never chaos-failed.

## Planned (P1)
`GET /api/recommendations`, `POST /api/recommendations/{id}/approve|reject`, `GET /api/alerts`, `GET /api/decisions`, `GET /api/stream` (SSE to browser).
