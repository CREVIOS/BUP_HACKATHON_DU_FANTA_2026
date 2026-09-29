# BUP_HACKATHON_DU_FANTA_2026 — Fuel Supply Intelligence & Resilience Platform

## Quick start
```bash
cp .env.example .env          # optional: TYPESAFE_API_KEY for Jev
docker compose up --build
```
| Service | URL |
|---|---|
| API (status) | http://localhost:8080/api/status |
| API (state) | http://localhost:8080/api/state |
| Ingestor health | http://localhost:8081/healthz |
| Intel health | http://localhost:8082/healthz |
| Simulator admin | http://localhost:8000/admin |

## Layout
| Path | Owner | What |
|---|---|---|
| `backend/` | backend track | Go 1.26 module, one image `fuelops api\|ingestor\|intel\|migrate` |
| `frontend/` | frontend track | Vite + React + TS operator UI (separate nginx container: `/` → SPA, `/api` → api:8080) |
| `infra/`, `deploy/` | DevOps track | Terraform (AWS, EKS), Helm, Argo |
| `docs/` | all | `PLAN.md` (execution plan), `BRIEF.md`, `INFRA_DECISIONS.md`, `SIMULATOR_GUIDE.pdf`, `API.md`, `research/` |

## Backend contract
- Each process exposes `/healthz`, `/version`, `/metrics`. Ports: api `:8080`, ingestor `:8081`, intel `:8082`.
- Env: `HTTP_ADDR`, `DATABASE_URL`, `SIM_BASE_URL`, `SIM_MAX_INFLIGHT` (default 4), `INTEL_URL`, `TYPESAFE_API_KEY`.
- Rollback-demo flags (api, intel): `CHAOS_500_PCT=0..100` (500 on that % of non-probe requests), `FAIL_HEALTH=true` (`/healthz` → 503).
- `/healthz` = readiness ("ready to serve"); use TCP for liveness. Metrics: `http_requests_total{route,method,code}`, `http_request_duration_seconds{route,method}`, `sim_requests_total{path,code}`, `sim_inflight`, `sim_tick`.
- **Only the ingestor talks to the simulator**, with at most 4 requests in flight. The simulator permanently wedges at ~15 concurrent requests (see `docs/PLAN.md` §2).

## Dev
```bash
cd backend && go test -race ./... && go vet ./...
```
