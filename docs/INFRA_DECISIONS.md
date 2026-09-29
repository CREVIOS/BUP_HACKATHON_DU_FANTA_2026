# Fuel Supply Intelligence Platform: Infrastructure & Stack Decisions

Status: v2.1 · 2026-09-29 · includes the independent review (fact-check with sources in §12)

> Implementation status: dependency/bootstrap, private operator access, and the pinned Tempo/Collector integration are documented in
> [infra/README.md](../infra/README.md). The ECS-era sections below remain historical
> until the full reconciliation in [INFRA_WORK_PLAN.md](INFRA_WORK_PLAN.md). Use the
> bootstrap guide for current pins, namespace ordering, the application-enable switch,
> localhost operator access, tracing configuration, and exact GitHub release trust. Live deployment and trace delivery remain unverified.

Runtime on AWS: **≤ 8 hours** (spin up before the demo, destroy after).
Fixed by the team: Go backend · AWS · RDS for the database · Terraform · CI/CD · automated rollback.

Guiding rule from the brief: *"Complexity itself will not guarantee a higher score."* Every component below
must show up in the demo or protect the demo. The judges run the submission locally, against the published
simulator image. That makes `docker compose up` the **primary** deliverable, and AWS is the live-ops showcase.
Both run the same images.


> **Update 2026-09-29 (supersedes the compute/deploy rows below): EKS, not ECS.** The team chose Kubernetes.
> Region **ap-southeast-1 (Singapore)**. EKS Auto Mode (managed nodes, ALB, EBS, pod identity) · Argo CD (GitOps from
> `deploy/charts/fuelops`) · **Argo Rollouts canaries** for `api`/`intel`, with automatic rollback when the smoke Job against canary pods
> fails or the Prometheus analysis sees canary 5xx > 2 % or p95 > 800 ms · kube-prometheus-stack (Prometheus, Grafana, alerts) ·
> RDS PostgreSQL 17 · ECR · GitHub Actions via OIDC builds images and bumps tags in git. Terraform is in `infra/`, manifests in `deploy/`.
> Simulator: 1 replica, `Recreate`, amd64 nodes; only the ingestor calls it (it wedges at ~15 concurrent requests).


---

## 1. Decisions at a glance

| Area | Decision | Rejected (why) |
|---|---|---|
| Backend | **Go 1.25**, one module, one image, 3 entrypoints: `api`, `ingestor`, `intel` | Microservice per concern; Python ML service (the team chose Go, and the model is simple) |
| HTTP | stdlib `net/http` (1.22+ pattern mux) | chi/gin/echo (the stdlib covers what we need) |
| DB access | `pgx/v5` + `sqlc`; migrations via `goose` (expand/contract only) | GORM |
| Frontend | React + Vite + TS + TanStack Query + Recharts + Tailwind, **embedded in `api`** (`go:embed`) | S3+CloudFront (a second deploy and rollback unit, plus CORS) |
| Live UI updates | SSE from Go API → browser | WebSockets (all updates flow one way) |
| Compute | **ECS on Fargate** behind one ALB | EKS (see §2); EC2 + compose (no managed rollback); App Runner |
| Deploy strategy | **`api`: ECS native blue/green** (bake + alarm rollback + smoke hook). **`intel`, `ingestor`, `simulator`: rolling + circuit breaker w/ rollback** | CodeDeploy (ECS does blue/green natively); blue/green on `intel` (the Service Connect test routing adds work nobody sees) |
| Database | **RDS PostgreSQL 17**, db.t4g.small, gp3, **Single-AZ** (`multi_az` var, off) | Multi-AZ (cheap for 8 h, but it adds ~10 min to provisioning and guards a 60–120 s failover nobody will watch); Aurora; DynamoDB |
| Cache | none: in-process last-known-good snapshot + Postgres | ElastiCache |
| Queue | **Postgres outbox** (`FOR UPDATE SKIP LOCKED`) | SQS |
| Service discovery | **ECS Service Connect** (`sim:8000`, `intel:8080`) | Cloud Map by hand, a mesh |
| Metrics | **OpenTelemetry Go SDK, two exporters**: Prometheus `/metrics` (local → Prometheus + Grafana) and **OTLP/HTTP → CloudWatch** (native OTLP + PromQL, SigV4 via task role) on AWS | ADOT sidecars + AMP + Grafana-on-ECS (one workspace, 7 sidecars, and an ALB sub-path we no longer need) |
| Dashboards | Local: Grafana (JSON in repo). AWS: CloudWatch dashboards (PromQL) | |
| Logs | `log/slog` JSON → CloudWatch Logs (awslogs); local: `docker compose logs` | Loki/ELK |
| Traces | **OpenTelemetry OTLP** from every process (`internal/obs`): `otelhttp` server + client spans, `otelpgx` DB spans, W3C context across api→intel and ingestor→sim. Exported to **Jaeger** locally (`http://localhost:16686`) and **Grafana Tempo** in k8s (via an in-namespace OTel Collector), viewable from Grafana. No-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset. | Direct-to-Tempo without a collector (no fan-out/batching); auto-instrumentation eBPF (heavier) |
| Rollback signals | CloudWatch **metric-math %** alarms: 5xx rate > 2 %, p95 > 800 ms; `treat_missing_data = notBreaching` | Raw 5xx count (INSUFFICIENT_DATA at low traffic, so it never fires) |
| IaC | **Terraform ≥ 1.11**, AWS provider **≥ 6.4**, S3 backend `use_lockfile = true` | DynamoDB lock table (deprecated); CDK/Pulumi |
| CI/CD | **GitHub Actions**, OIDC → IAM role, ECR immutable tags = git SHA | Jenkins, CodePipeline |
| Secrets | Secrets Manager; RDS `manage_master_user_password = true`; ECS `secrets` | `.env` in repo |
| LLM | **Bedrock, Claude Haiku 4.5** via **global** inference profile `global.anthropic.claude-haiku-4-5-20251001-v1:0` (Mumbai has no APAC profile for it). Explanations only, 3 s timeout, template fallback | API key in a secret; an LLM that decides |
| Load test | **k6**, thresholds in script, JSON summary committed as evidence | JMeter, Locust |
| Region | **ap-south-1 (Mumbai)**, closest to Dhaka | eu-west-3 (TalentForge prod lives there) |
| Account | **Separate account**, or at minimum a separate VPC + `fuelops-` prefix. Never inside `talentforge-prod-vpc` | |

---

## 2. Why not Kubernetes (EKS)?

Cost isn't the reason (the EKS control plane costs under $1 for 8 h). **Hackathon hours are.**

- EKS needs nodes, the AWS LB Controller, IAM for pods, metrics-server, Helm charts, and Argo CD/Rollouts before a single fuel feature exists. That's 1–2 days. ECS gives blue/green, alarm rollback, autoscaling and service discovery in a handful of Terraform resources.
- Judges run `docker compose up`, so K8s adds nothing to what they execute.
- Every controller is one more thing that can break live, and the brief says *"your job is to keep it working."*

**Where K8s would win:** Argo Rollouts canaries with rollback on *our own* Prometheus metrics (fallback rate, forecast error), not just ALB 5xx/latency. It also brings kube-prometheus-stack, Chaos Mesh and GitOps, and all of these are listed bonus items under DevOps (15 %).

**Switch rule:** move to EKS + Argo Rollouts + Argo CD **only if** a teammate has run production K8s and can have the cluster plus Argo up within half a day. Otherwise ECS, and spend the time on intelligence and product (40 %).

---

## 3. Architecture

```
                 ┌──────────────────────── AWS ap-south-1 · VPC 10.60.0.0/16 · 2 AZs ────────────────────────┐
 Operator ──TLS──▶ ALB (public) :443 prod listener ─▶ api (blue|green TG)    :9443 test listener (smoke hook) │
 Judges          │  private subnets ───────────────────────────────────────────────────────────────────────  │
                 │   api ×2 (autoscale 2–6) ──Service Connect──▶ intel ×2 ──(fail/timeout)──▶ rule fallback  │
                 │     │   ▲ SSE to browser                         │  forecast · detect · optimize · MC impact │
                 │     │   └──────── Postgres (RDS) ◀───────────────┘                                        │
                 │   ingestor ×1 ──SSE+REST──▶ simulator ×1 (published image, private, max 100 % / min 0 %)   │
                 │     └─ outbox worker ──POST /v1/allocations──▶ sim                                          │
                 │   all tasks ──OTLP/HTTP──▶ CloudWatch (metrics w/ PromQL, logs, Container Insights, alarms)│
                 │   intel ──▶ Bedrock global profile, Claude Haiku 4.5 (explanations only)                   │
                 └────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **api**: embedded SPA, REST for the UI, SSE fan-out, auth, approval workflow, **rule-based fallback allocator** (survives `intel` death), and **admin panel** proxying the simulator's `/admin/*` (admin role only). Stateless.
- **ingestor**: a singleton. It is the only SSE consumer. The SSE read loop only pushes into a coalescing channel, and a separate goroutine re-GETs REST, so a slow DB never makes us fall 200 events behind. It snapshots world state per tick and runs the outbox worker. It detects simulator resets (tick regresses or the seed changes) and opens a new `sim_epoch`.
- **intel**: forecast, anomaly detection, allocator, Monte Carlo impact. Stateless and **deliberately killable**.
- **simulator**: published image, unchanged, private. `deployment_maximum_percent = 100`, `minimum_healthy_percent = 0`, so a replacement never runs two worlds. Ephemeral storage means any restart is a reset, which `sim_epoch` handles. The raw console is reachable via the admin panel or an ECS Exec port-forward.

**Simulation speed.** The default is 8 ticks/s, which is a simulated day every 12 s. The ingestor and Monte Carlo (N=500 × 12 series) won't keep up, and the SSE buffer drops us. **Demo at ≤ 1 tick/s, or paused and driven by `/admin/step` from the admin panel.** Check whether `SIMULATION_SPEED` accepts fractions; if not, use 1 and step manually.

---

## 4. Intelligence (`intel`)

The simulator's demand model is documented: profile × hour-of-day × region factor × `demand_multiplier` × noise(σ≈0.1). We exploit that honestly.

| Capability | Method |
|---|---|
| Demand forecast | Seasonal baseline per (station, fuel, hour-of-day) × EWMA level ratio (actual/expected) × current `demand_multiplier`; interval from residual σ. **Not retrained on data flagged `X-Simulator-Stale`.** |
| Stockout prediction | Tick-by-tick projection with forecast demand + in-transit allocations + scheduled supply; **Monte Carlo (N=500)** → P(stockout within H), time-to-stockout |
| Anomaly detection | CUSUM / z-score on forecast residuals; supply delay/shortfall diffs on `/v1/supply-arrivals`. **Suppressed when station `status != OPEN`** (an outage zeroes the served liters, and that isn't anomalous demand) |
| Allocation | LP via gonum `lp.Simplex` (convert to standard form with `lp.Convert`) minimizing expected unmet demand + transit ticks under depot inventory, dispatch cap/tick, `max_shipment`, station capacity, route status. **CONSTRAINED depots stay eligible** (still shippable per the guide). Simplex can fail on degenerate cases, so the greedy allocator is always ready as a fallback |
| Fallback allocator (`api`) | Greedy by time-to-stockout, nearest available route, all 409 rules checked client-side |
| Human-in-the-loop | Needs approval if confidence is low, the quantity is large, a crisis is active, or any input is stale. Otherwise auto-mode (toggle) |
| GenAI | Haiku 4.5 turns the structured reasoning (signals, constraints, alternatives, before/after risk) into prose plus an incident summary. Never decides |
| RL | Skipped (optional). **Be honest in the demo**: on 6 routes greedy ≈ LP; the decision-quality win comes from forecast + Monte Carlo |
| Policy rollback | `policies` table (`version`, `params`, `active`); switch in the UI; every decision stores `policy_version` |

**Scenario scripts = replay + CI gate.** A JSON crisis script (`scenarios/*.json`: events, faults, step counts) is replayed through
the admin panel via `/admin/reset` → `/admin/events` + `/admin/faults` → `/admin/step`. Because the simulator is deterministic,
the same script drives the live demo, the brief's "simulation replay / scenario configuration", and the CI
**decision-quality gate** (`service_level ≥ baseline`).

---

## 5. Allocation submission rules (simulator contract)

- `idempotency_key = rec-<recommendation_id>-v<attempt>`. An edited quantity or a re-plan gets a new attempt number, because a key is burned forever once used, even after a cancel.
- Split quantities above `route.max_shipment` **before** submitting.
- Outbox retry policy: `503 FAULT_INJECTED` → exponential backoff. `DISPATCH_CAPACITY_EXCEEDED` → retry **next tick**. `DESTINATION_CAPACITY_EXCEEDED` / `INSUFFICIENT_INVENTORY` → re-plan. `ROUTE_DISRUPTED` → re-plan on an alternate route. `NOT_FOUND` / `ROUTE_MISMATCH` / 422 → bug, alert, no retry.
- Parse both error shapes: `{"detail":{code}}` (domain) and `{"error":{code}}` (injected fault).

---

## 6. Resilience matrix

| Failure | Detection | Behavior | Metric |
|---|---|---|---|
| Sim 503 / `error_rate` | status + `FAULT_INJECTED` | retry (backoff+jitter ×3) → breaker opens → **last-known-good snapshot**, UI "DEGRADED · data as of tick N" | `sim_requests_total{code}`, `breaker_state` |
| Sim `latency` | ctx timeout 1.5 s | same | `sim_request_duration_seconds` |
| `stale_data` | `X-Simulator-Stale: true` | mark stale, block auto-decisions and retraining, human review | `stale_responses_total` |
| `stream_disconnect` / dropped | 503 on stream or tick gap | REST polling every 2 s; reconnect w/ backoff; full resync | `sse_connected` |
| Sim reset | tick regressed / seed changed | new `sim_epoch` | log + UI notice |
| `intel` down | Service Connect timeout / breaker | `api` greedy fallback, UI badge "FALLBACK POLICY" | `fallback_activations_total` |
| Low confidence | MC interval width | human review | `human_review_requests_total` |
| Bedrock down | 3 s timeout | template explanation | `llm_fallback_total` |
| Invalid sim payload | schema validation | reject, keep previous snapshot, alert | `sim_invalid_payload_total` |
| DB down | pgx errors | api serves in-memory snapshot read-only; outbox resumes after recovery | `db_up` |
| Task crash | ALB / container health | ECS replaces; api ≥ 2 tasks across AZs | `UnHealthyHostCount` |
| Bad deploy | §8 | automatic rollback | ECS deployment events → SNS |

**Status page distinguishes** "simulator reachable" (`/v1/health`, bypasses faults) from "simulator data path" (last `/v1/*` result).
Otherwise it shows green during an `unavailable` fault.

---

## 7. Infrastructure (Terraform)

```
infra/
  bootstrap/   # one-time: tfstate bucket (versioned), GitHub OIDC provider + deploy role
  main.tf vpc.tf alb.tf ecs.tf services.tf rds.tf observability.tf iam.tf secrets.tf outputs.tf
  envs/demo.tfvars
```

- One root module and one env (`demo`). Local compose plus the CI sim-run replace a staging environment.
- **VPC**: 2 AZs; public (ALB, NAT) + private (tasks, RDS). **One NAT gateway**. `# ponytail: single-AZ NAT is a SPOF; add a 2nd if AZ failure is demoed`
- **ECR**: `fuelops`, immutable tags, scan-on-push, keep the last 30.
- **ECS**: Container Insights, Service Connect namespace `fuelops.local`, ECS Exec enabled.
  - `api`: `deployment_configuration { strategy = "BLUE_GREEN", bake_time_in_minutes = 5, lifecycle_hook { … POST_TEST_TRAFFIC_SHIFT → smoke Lambda } }`, `load_balancer.advanced_configuration { alternate_target_group_arn, production_listener_rule, test_listener_rule, role_arn }`, `alarms { alarm_names, enable = true, rollback = true }`
  - `intel`, `ingestor`: rolling, `deployment_circuit_breaker { enable = true, rollback = true }` + the same alarms
  - `simulator`: rolling, max 100 / min 0, image pinned `1.0.0`
  - All services: `lifecycle { ignore_changes = [task_definition] }`. **Terraform owns the infra, CI owns the revisions.**
- **Autoscaling**: `api` target-tracking at 60 % CPU, min 2 / max 6.
- **RDS**: PG 17, t4g.small, 20 GB gp3, encrypted, `multi_az = var.multi_az` (false), managed master password, Performance Insights. **Ephemeral env**: `deletion_protection = false`, `skip_final_snapshot = true`, `backup_retention_period = 1`, so `terraform destroy` is clean.
- **Logs**: 1-day retention. Export the Grafana/CloudWatch screenshots, k6 summaries and the decision audit (`pg_dump`) **before** destroy, since they are deliverables.
- **ALB**: HTTPS via ACM if we have a domain, otherwise HTTP on the ALB DNS. Test listener `:9443` restricted to the VPC.
- **IAM (intel, Bedrock)**: `bedrock:InvokeModel` on the **inference-profile ARN and** `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0` (the global profile routes to any commercial region). Enable model access in the account first.
- **Cost**: about **$2 total for 8 h** (ALB, NAT, RDS, ~7 small Fargate tasks). The $0 option is `terraform destroy` right after.
- **Timing**: a cold `terraform apply` takes ~15–20 min (RDS dominates). **Do a full apply → deploy → rollback demo → destroy rehearsal the day before**, and apply at least 1 h before judging.

---

## 8. CI/CD & automated rollback

**Every PR:**
1. `go vet`, `golangci-lint`, `go test -race ./...`, frontend `tsc` + `vitest`
2. `docker build` → Trivy (fail on fixable HIGH/CRITICAL)
3. **Sim integration + decision-quality gate**: `docker compose up` → replay `scenarios/ci-crisis.json` → assert `service_level ≥ baseline`, fallback activates with `intel` stopped, 0 unhandled 5xx under `error_rate 0.25`
4. `terraform fmt -check` / `validate` / `plan` → PR comment

**Merge to `main`:**
1. Build → push `fuelops:<sha>`
2. `terraform apply` (only if `infra/` changed)
3. Migrations as a one-off ECS task. **Expand/contract only**, so the previous image version keeps working and app rollback stays safe.
4. Deploy `intel` → `api` → `ingestor` (new task-def revisions)
5. `api` blue/green: green up → **smoke Lambda hits the test listener** (fail → rollback before any user traffic) → shift → **5-min bake while CI runs a k6 smoke load at the ALB**, so the alarms have data → alarm fires → instant flip back to blue
6. CI waits for the ECS deployment result and **goes red on rollback**
7. `workflow_dispatch`: full k6 load test → summary JSON artifact

**Rollback demo (two builds, two mechanisms):**
- `FAIL_HEALTH=1` build → green never gets healthy → the deployment fails and **blue keeps serving**
- `CHAOS_500_PCT=5` build → passes health, 500s on 5 % of requests → **the alarm fires during the bake → auto-rollback**

Other rollbacks: infra = `git revert` + apply (state bucket versioned); policy = switch active version in the UI.

---

## 9. Observability

- Instruments via the OTel metrics SDK. RED per endpoint; breaker state; SSE status; sim faults by code; forecast MAPE (predicted vs next-tick actual); alert rate; decisions/tick; fallback activations; human-review queue; MC confidence; `service_level`, unmet liters, and allocation failures (from `/v1/metrics`).
- **Local**: Prometheus + Grafana with 4 provisioned dashboards (Service, System, Intelligence, Operations).
- **AWS**: the same metrics via OTLP into CloudWatch, dashboards in PromQL, Container Insights for CPU/mem, alarms → SNS.
- **In-app System Status page** (brief §15): api, DB, simulator reachability vs data path, intel, decision engine, live p95, error rate.
- **Logs**: JSON with `sim_tick`, `sim_epoch`, `decision_id`. The decision audit lives in Postgres (UI) and in the logs.

---

## 10. Load testing (k6)

Scenarios: dashboard read, end-to-end decision (with MC), mixed. Ramp 10 → 200 VUs. Thresholds: p95 < 300 ms (read), < 1.5 s (decision), errors < 1 %.
Report avg/p50/p95/p99, RPS, errors, CPU/mem per stage. Show autoscaling kick in, and name the bottleneck (likely MC N in `intel`).

---

## 11. Security, access & docs

GitHub OIDC · Secrets Manager only · least-privilege task roles · SG chain ALB→api→intel/sim/RDS · RDS private + encrypted ·
roles `viewer` / `operator` / `admin` (JWT, bcrypt, seeded from a secret) · input validation at every boundary.
**README ships a read-only `viewer` login + the ALB URL for judges**, plus a documented assumptions section (brief §24: simulated only, no real dispatch).

---

## 12. Review log

Independent reviewer (subagent), fact-checked against AWS/HashiCorp docs:

| Claim in v1 | Result | Fix applied |
|---|---|---|
| ECS native blue/green (bake, alarms, hooks, test listener) | ✅ true (provider ≥ 6.4) | pinned provider |
| Circuit breaker also rolls back blue/green | ❌ rolling-only | breaker on rolling services only |
| Blue/green for Service-Connect-only `intel` | ✅ possible, not worth it | `intel` → rolling |
| `use_lockfile` in TF 1.10 | ⚠️ experimental in 1.10, GA in 1.11 | pinned ≥ 1.11 |
| ADOT sidecar → AMP recommended | ⚠️ outdated: CloudWatch ingests OTLP + PromQL natively (GA 2026) | switched to OTLP → CloudWatch |
| Haiku 4.5 via APAC profile in Mumbai | ❌ global profile only | `global.anthropic.claude-haiku-4-5-20251001-v1:0` + IAM fix |
| PG 17 on t4g.small in ap-south-1 | ✅ | — |
| gonum `lp.Simplex` | ✅ standard form; can fail on degenerate cases | greedy fallback always ready |

Design catches applied: zero-traffic alarms never fire (§8), idempotency key reuse (§5), 8 ticks/s outruns the pipeline (§3),
Multi-AZ dropped, outage false-positive anomalies, stale data blocks retraining, status-page reachability vs data path, scenario replay, judge access.

---

## 13. Open questions
1. Does anyone on the team have production K8s experience? (Decides §2.)
2. Which AWS account? A fresh one is recommended, not TalentForge prod.
3. Domain for TLS? (Optional.)
