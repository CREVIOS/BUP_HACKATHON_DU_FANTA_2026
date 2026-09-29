# BUP_HACKATHON_DU_FANTA_2026 — Fuel Supply Intelligence & Resilience Platform

## Quick start
```bash
cp .env.example .env          # optional: TYPESAFE_API_KEY for Jev
docker compose up --build
```
| Service | URL |
|---|---|
| Operator UI | http://localhost:3000 |
| API (status) | http://localhost:8000/api/status |
| API (state) | http://localhost:8000/api/state |
| Ingestor health | http://localhost:8081/healthz |
| Intel health | http://localhost:8082/healthz |

## Layout
| Path | Owner | What |
|---|---|---|
| `backend/` | backend track | Go 1.26 module, one image `fuelops api\|ingestor\|intel\|migrate` |
| `frontend/` | frontend track | Next.js + React + TS operator UI (standalone Node image on port 3000; ALB routes `/api` directly to the API) |
| `infra/`, `deploy/` | DevOps track | Terraform (AWS, EKS), Helm, Argo |
| `docs/` | all | `PLAN.md` (execution plan), `BRIEF.md`, `INFRA_DECISIONS.md`, `SIMULATOR_GUIDE.pdf`, `API.md`, `research/` |

## Backend contract
- **Operator API contracts (every endpoint, request/response, flows, errors): [`docs/API.md`](docs/API.md)** · live spec at `/docs` on the api.
- Each process exposes `/healthz`, `/version`, `/metrics`. Ports: api `:8080`, ingestor `:8081`, intel `:8082`.
- Env: `HTTP_ADDR`, `DATABASE_URL`, `SIM_BASE_URL`, `SIM_MAX_INFLIGHT` (default 4), `INTEL_URL`, `TYPESAFE_API_KEY`, `OTEL_EXPORTER_OTLP_ENDPOINT` (unset = tracing off).
- Rollback-demo flags (api, intel): `CHAOS_500_PCT=0..100` (500 on that % of non-probe requests), `FAIL_HEALTH=true` (`/healthz` → 503).
- `/healthz` = readiness ("ready to serve"); use TCP for liveness. Metrics: `http_requests_total{route,method,code}`, `http_request_duration_seconds{route,method}`, `sim_requests_total{path,code}`, `sim_inflight`, `sim_tick`.
- **Tracing (OpenTelemetry):** when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, every process emits OTLP spans (HTTP server/client via `otelhttp`, Postgres via `otelpgx`) and OTel metrics (`fuelops_*`). `docker compose up` wires this to Jaeger — trace UI at http://localhost:16686, OTel metrics at http://localhost:8889/metrics. Unset the var to run without it; Prometheus `/metrics` is unaffected either way.
- **Only the ingestor talks to the simulator**, with at most 4 requests in flight. The simulator permanently wedges at ~15 concurrent requests (see `docs/PLAN.md` §2).

## Dev
```bash
cd backend && go test -race ./... && go vet ./...
```

## Infrastructure

See [infra/README.md](infra/README.md) for pinned dependencies, bootstrap ordering,
application activation, [private operator access](infra/README.md#private-operator-access),
GitHub OIDC configuration, existing-environment adoption, and validation commands.
Application creation defaults to disabled; the Helm chart requires full commit SHA
image tags before it can render. Remaining deployment fixes are tracked in
[docs/INFRA_WORK_PLAN.md](docs/INFRA_WORK_PLAN.md).
