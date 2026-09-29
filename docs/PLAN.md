# Fuel Supply Intelligence & Resilience Platform — Execution Plan

v3 · 2026-09-29 · Builds on `INFRA_DECISIONS.md` (the team's fixed stack: Go · AWS ECS · RDS · Terraform · CI/CD · rollback).
Inputs: the participant brief (`BRIEF.md`), the integration guide (PDF), **the simulator's real source**
(from `asifmahmoud414/bup-fuel-supply-simulator:1.0.0`), live experiments on that container, three Codex reviews
(`research/`), and a live test of the Jev API.

---

## 0. TL;DR

1. **The score is the whole product.** Product/UX 20 · Intelligence 20 · Architecture 15 · DevOps 15 · Resilience 10 ·
   Observability+Perf 10 · Demo 10. Build **one working operator flow first**, then deepen it.
2. **The allocation math is easy.** A naive policy holds service_level **1.000** until the fuel physically runs out.
   Intelligence points come from *proven* forecasting, calibrated stockout risk, detection, and explainable recommendations
   with a measured impact, all compared against baselines.
3. **The simulator has traps.** It *destroys fuel* in two undocumented ways and **permanently crashes at ~15 concurrent requests.**
   One fenced writer (the ingestor) talks to it, with a concurrency cap of 4. Nothing else touches it.
4. **Jev has one job:** decide *"may this recommendation auto-execute, or must a human review it?"* (brief §11/§24).
   It's evaluated for calibration against the fixed rule, never overrides the hard safety rules, and falls back to the rule when unavailable.
   It's cut from the story if it doesn't beat the rule.
5. **The demo is paused and step-driven** (`/admin/step`), so every beat is deterministic.

---

## 1. Score-driven scope

| Weight | Criterion | Must-have | Stretch (only after must-haves are green) |
|---|---|---|---|
| 20 | Product & UX | **One operator screen:** inventory per station/depot/fuel, entity status, regional demand, incoming supply, disruptions, risk, recommendation card, approve/reject, decision history, health · degraded/error states · a **"SIMULATION ONLY — no real dispatch"** banner · a documented judge login | Map view, command bar |
| 20 | Intelligence | Forecast (MAPE) · stockout risk (calibrated) · residual-anomaly detection · **safe greedy allocator** · impact estimate · Jev review triage · **an evaluation table vs baselines (§9)** | LP optimizer (only if it beats greedy), Claude explanations |
| 15 | Architecture | sim → ingestor (fenced single writer) → Postgres → intel → decisions → API/UI → monitoring; outbox + idempotency; a diagram with normal *and* fallback flows | — |
| 15 | DevOps | Fresh-clone `docker compose up` · CI: lint/test/build/Trivy+secret scan/**sim regression gate** · Terraform ECS · **one** auto-rollback demo · `/version` shows the build SHA | Blue/green with a bake window |
| 10 | Resilience | One deterministic failure at a time: intel down → fallback; sim `unavailable` → degraded mode + last-known-good; stale → forced review; SSE loss → polling | RDS failover |
| 10 | Observability+Perf | **One** Grafana overview (RED, resources, intelligence, fallback, decisions) + alerts · **one** complete k6 report · the simulator's concurrency limit characterised | Tracing |
| 10 | Demo | A scripted 14-step story (§7), rehearsed twice, with a backup recording | — |

Cut: RL (explained in the demo), K8s, the digital twin (replaced by replay against the real sim), 4 dashboards, and a 2 h soak.

---

## 2. Simulator ground truth (the code wins over the guide)

✅ = reproduced live. 📄 = read in source (file:line refs are in `research/codex_independent.md`).

| # | Fact | Design consequence |
|---|------|--------------------|
| 1 | ✅ **Permanent crash at ~15 concurrent requests** (each `/v1` request holds 2 pooled DB connections; the pool is 5+10). `/v1/health` hangs too, and only a restart recovers it. Fine at ≤12. | Only the ingestor calls the sim, semaphore **4**. The API and k6 never reach the sim. |
| 2 | ✅ An allocation POSTed at tick T while a route disruption **starts at T** → FAILED at departure, **fuel not refunded**. | Check disruptions over the *departure tick*; cancel PENDING allocations on a new disruption. |
| 3 | ✅ The station capacity check **ignores in-transit fuel**; overflow is **silently destroyed** while the allocation still shows ARRIVED (full qty). | Track in-transit; cap at projected room *at arrival*. |
| 4 | 📄 Supply arriving at a full depot is clipped and lost. | Keep depot headroom before known supply ticks. |
| 5 | ✅ `route_disruption` / `station_outage` / `depot_constraint` with **empty ids do nothing** (the guide says "all"). | The admin panel warns about this. |
| 6 | 📄 `depot_constraint` doesn't change capacity; `stale_data` only adds a header (the data is fresh). | Handle both *visibly* anyway (the brief expects it). |
| 7 | ✅ SSE has **no departed/arrived/failed events**. | Poll `/v1/allocations`; SSE only says "a tick happened". |
| 8 | 📄 A subscriber that overflows is dropped **but the stream stays open sending keepalives** (a zombie). | Watchdog: sim tick advanced + no SSE tick for 3 s → reconnect + resync. |
| 9 | ✅ An idempotent replay returns **201**; body equality is `float==float`. | The outbox persists the exact body; retries resend the same key and the same body. |
| 10 | 📄 Tick order: events start → supply → departures → arrivals → demand → events resolve. Lead time = `transit_ticks`. **Events cover S…S+D inclusive.** | Inclusive windows. |
| 11 | 📄 In-transit fuel **arrives even at a station in OUTAGE**; outage demand is unavoidable unmet demand. | Show "unavoidable loss" separately in the UI. |
| 12 | 📄 The dispatch cap is per depot, **across all fuels**, per creation tick; it binds only within a single tick. | A greedy budget per depot per tick. |
| 13 | 📄 **Captive stations:** Tongi ← Gazipur only; Cox's Bazar ← Patiya only. | Reserve for them first. |
| 14 | 📄 Demand = `daily/96 × hour_factor × region × demand_multiplier × (1+U(±noise))`. Every parameter is published in guide §8.5–8.6; the noise is **uniform**. | The forecaster matches the generating process. |
| 15 | ✅ `sim_time` has no timezone suffix; the real tick rate at SPEED=8 is **~6.5/s** (the amd64 image runs emulated on ARM Macs). | Parse naive timestamps as UTC; never derive the tick from the wall clock. |
| 16 | 📄 The image always loads `baseline.yaml`; `/admin/reset` forces `tick_minutes=15`; `/v1/metrics` does a full table scan. | Other scenarios are test-only (bind-mount); poll metrics ≤ 0.2 Hz. |
| 17 | 📄 A REST read is not an atomic snapshot. | Fence each snapshot with `/v1/instance` before and after. |

**Fuel ceiling:** baseline runs out of petrol at tick 527; final_combined at tick 367. The naive policy held 1.000 through tick 384 on baseline,
and on final_combined it served 99.8% of all the fuel that exists.

---

## 3. Changes to `INFRA_DECISIONS.md`

| INFRA says | Problem | Change |
|---|---|---|
| `ingestor` singleton via `desired_count=1` | ECS rolling deploys briefly run two tasks → two writers | **Postgres advisory lock** for the writer role + a unique decision key `(sim_epoch, tick, station, fuel, policy_version)` |
| `api` ×2–6 with a fallback allocator | Several tasks could POST to the sim | The API only *reads* and *approves*; all submissions go through the fenced outbox worker |
| k6 ramp to 200 VUs | Any path that proxies to the sim crashes it permanently | The API serves from Postgres/memory; k6 asserts `sim_inflight_max ≤ 4` |
| Simulator on Fargate | The image is **amd64-only**, and SQLite lives on the task's ephemeral disk | `cpuArchitecture = X86_64`, `desired_count = 1`, a restart = a world reset (the `sim_epoch` logic already handles this) |
| MC "σ≈0.1" | The noise is uniform ±noise | Sample uniform, **64–100 runs, cached**, only for at-risk station/fuel pairs |
| SSE loss "by 503 or tick gap" | Misses the zombie stream | Add the keepalive-only watchdog |
| Outbox "retries only 503s" | Timeouts and 500s are also ambiguous | Retry 5xx/timeout with the same key and body; on ambiguity, look up the key in `/v1/allocations` |
| LP + MC + CUSUM + Bedrock in the MVP | Too broad | Greedy + projection + residual detection + templates in the MVP; LP and Claude are stretch goals |
| CI gate "service_level ≥ baseline" | `error_rate` is unseeded, so it's nondeterministic | Run the gate with events only; faults go in a separate, non-gating job |
| 4 dashboards, blue/green + 2 rollback paths | Over-weighted for 15%+10% | One overview dashboard; **one** demonstrated auto-rollback (circuit breaker or alarm), recorded as evidence |
| Bedrock as the model | The user chose Jev | Jev = review triage (§5); Bedrock/Claude is optional explanation text |

---

## 4. Intelligence layer (`intel`, Go): MVP first

| Capability | MVP method | Evidence in §9 |
|---|---|---|
| Demand forecast | Published formula × EWMA level ratio from `/v1/demand-history` × `demand_multiplier` (incl. scheduled spikes) | MAPE vs a naive "last value" baseline |
| Stockout risk | Deterministic forward projection (on-hand + in-transit + scheduled supply − forecast) + a small uniform-noise ensemble (64–100 runs) → time-to-stockout, P(stockout within H) | Brier score / reliability buckets on replays |
| Detection | Residual z-score/EWMA vs the forecast, plus a supply-arrivals diff (delay/shortfall) | Detection delay and false-positive rate on injected *surprise* events |
| Allocation | **Safe greedy:** order by time-to-stockout; every constraint from §2 (#2, #3, #4, #12, #13) and route max; direct route first, cross route on disruption or shortage | Unmet L, FAILED = 0, overflow = 0 vs "do nothing" |
| Impact | Re-run the projection/ensemble with and without the recommendation → "risk 71% → 12%", computed at runtime, never hard-coded | Shown on the card |
| Explanation | A **structured template** from computed signals: why at risk, binding constraints, alternatives, confidence | — |
| Stretch | LP (gonum) if it beats greedy on §9; Claude text on top of the template | — |
| Exact jitter replica | **Not used** (it would look like exploitation, and it adds ~0 value) | — |

---

## 5. Jev: one job, measured

A live call from this machine returned HTTP 200 in 0.6–1.2 s with about 660 input tokens, and cost almost nothing. The endpoint is `POST https://api.typesafe.ai/v1/systemone` with `Bearer $TYPESAFE_API_KEY` and model `jev-latest` (currently jev-1.13.0).
TypeSafe's docs: it is weak at numbers, math and dates. **Code computes the numbers; Jev judges the meaning.**

**Question** (one Noul per recommendation): *"May this recommendation execute automatically without human review?"*
Its state holds only qualitative features computed in code, for example: `margin=critical`, `snapshot=stale|fresh`,
`departure_overlaps_disruption=false`, `forecast_residual=abnormal`, `route=cross_region`, `qty_vs_typical=large`, `active_events=[spike]`.

Decision logic:
1. **Hard safety vetoes are pure code and always win:** stale snapshot, a disruption overlapping departure, an overflow risk, or qty > X → human review.
2. Otherwise `p_auto = jev.noul`. Auto-execute if `p_auto ≥ θ`, else send it to the review queue.
3. If Jev fails or times out (2 s), fall back to the fixed rule (`MC confidence < c || crisis_active` → review).

Proof (goes in §9): label replayed recommendations by outcome (safe/unsafe). Report the Brier score and the **review-rate reduction at
zero unsafe auto-executions**, Jev vs the fixed rule. θ is picked before the demo. **If Jev doesn't beat the rule, remove it from the demo story.**

UI: the card shows `Jev p_auto 0.82 · model jev-1.13.0 · rule would say: review`. Metrics: `jev_latency`, `jev_fallback_total`, `review_queue_depth`.
Secrets: `.env` locally (git-ignored, created), Secrets Manager on AWS. **Rotate the key.** CI runs once with the key unset and must still pass.

---

## 6. Step-by-step build plan

Tracks: **A** ingestor/backend · **B** intel · **C** frontend · **D** DevOps/observability. Every phase has a gate.

**P0 · Foundation (everyone, ~3 h)**
- [ ] Go module, `fuelops api|ingestor|intel|migrate`, compose (sim + 3 services + postgres + prometheus + grafana), Makefile, `.env.example`.
- [ ] Schema: snapshots, outbox (key + exact body), recommendations, decisions (policy_version, rule verdict, jev p), alerts, sim_epoch.
- [ ] CI skeleton: vet, golangci-lint, `go test -race`, build, Trivy + secret scan.
- ✅ Gate: `docker compose up` on a **fresh clone** shows the sim tick in the ingestor logs.

**P1 · Vertical slice (A + B + C together) ← the most important phase**
- [ ] Ingestor: sim client (semaphore 4, timeouts, retry, breaker, 3 error shapes, validation), tick-fenced snapshots, polling of allocations.
- [ ] Intel: forecast + projection + safe greedy for **one** risk.
- [ ] API + UI: the one operator screen, a recommendation card, approve → outbox → track PENDING → IN_TRANSIT → ARRIVED.
- ✅ Gate: a non-team member does "see risk → inspect → approve → watch it arrive" unaided. **A demo exists from here on.**

**P2 · Safety & resilience (A)**
- [ ] Advisory-lock writer, decision dedup, identical-body retries, the 409 code matrix, cancel-on-disruption, depot headroom, captive reservation.
- [ ] SSE + zombie watchdog + polling fallback, epoch/reset detection, last-known-good + a DEGRADED banner, stale → forced review.
- ✅ Gate: every fault type → no crash; kill -9 the ingestor ×20 → 0 duplicates; two ingestors running → only one writes.

**P3 · Intelligence depth + evaluation (B)**
- [ ] Ensemble stockout probability, residual detection, the impact estimate, templates, the Jev triage with fallback.
- [ ] **A replay harness against the real sim** (`/admin/reset` + `/admin/step` + scripted events) → the §9 table.
- ✅ Gate: §9 is filled with real numbers; greedy beats "do nothing"; 0 FAILED, 0 overflow.

**P4 · UX completion (C)**
- [ ] Regional demand, incoming supply, entity status, crisis timeline, decision history, System Status, admin panel (inject events/faults, step/reset, empty-list warning), degraded/error/empty states, the simulation banner.

**P5 · DevOps & observability (D)**
- [ ] One Grafana overview + alert rules (sim errors, breaker open, fallback active, review queue, p95).
- [ ] CI sim regression gate (events-only crisis script: service_level ≥ baseline, 0 FAILED, 0 overflow) + a no-Jev-key job.
- [ ] Terraform (INFRA §5 + the §3 fixes), GitHub OIDC, ECR, ECS; **one** auto-rollback demonstrated and recorded; `/version`.

**P6 · Load (D)**: see §8. **P7 · Deliverables gate:** see §10.

---

## 7. Demo script: paused, step-driven, deterministic

Start: `/admin/reset` → paused. The presenter drives the ticks with a "Step ×N" button in our admin panel.

| # | Beat (brief §22) | Action | Judges see |
|---|---|---|---|
| 1–2 | Normal ops, dashboard | Step ×8 | Full screen, all green, forecast bands, "SIMULATION ONLY" |
| 3 | Demand rises | Inject a **surprise** `demand_spike region-dhaka ×1.8, start=now, 16` (not pre-scheduled, so detection is real) | Actual demand breaks out of the forecast band |
| 4 | Risk detected | Step ×3 | Residual-anomaly alert, with detection delay shown |
| 5 | Shortage predicted | — | "Mirpur PETROL: stockout in X h, P = Y%" (computed live) |
| 6–7 | Recommendation, inspected | — | Card: qty, route, binding constraints, alternatives, risk Y% → Z%, Jev p_auto + rule verdict → **review required** |
| 8 | Allocation executed | Approve → Step ×1 | PENDING → IN_TRANSIT |
| 9 | Crisis | While a *second* allocation is PENDING: inject `route_disruption route-gazipur-mirpur start=now` | The system **cancels the PENDING allocation before the fuel is lost** and re-routes via Patiya |
| 10 | Adapts | Step ×4 | New recommendation, "combined crisis" banner |
| 11 | Failure injected | `docker stop intel`, then `POST /admin/faults {unavailable, 60 s}` (deterministic, **one at a time**) | — |
| 12 | Monitoring detects it | — | Grafana alert, System Status red |
| 13 | Fallback | Step ×2 | "FALLBACK POLICY", "DEGRADED · data as of tick N", breaker open |
| 14 | Operations continue | `docker start intel`, clear faults, Step ×4 | Recovery, service_level 1.000, **0 L lost** |
| + | DevOps | Show the recorded auto-rollback + the CI gate run | Evidence tied to a commit SHA |

---

## 8. Concurrency, latency and load

Measured on this Mac (sim under amd64 emulation):

| Target | Result |
|---|---|
| Sim `GET /v1/stations` c=1 | p50 3 ms · p95 15 ms · ~270 rps |
| c=4 / 8 / 12 | p95 15 / 28 / 47 ms · ~380 rps plateau (single event loop) |
| c=16 | **every request times out; the server stays dead until restarted** |
| Tick rate at SPEED=8 | ~6.5 ticks/s |
| Jev round trip | 0.6–1.2 s |

Load evidence (the brief needs avg/p50/p95/p99, throughput, error rate, concurrency, resources):
1. **k6 on our dashboard read path** (`GET /api/state`), ramping 10 → 200 VUs over 10–15 min. Thresholds: p95 < 300 ms, errors < 1%. CPU/mem from Grafana. Guard: `sim_inflight_max ≤ 4`.
2. *(Optional)* a short decision-path test (`POST /api/recommendations:compute`) to name the bottleneck.
3. **Simulator limit characterisation** on an isolated, throwaway sim container: c = 1…12, with the crash at 16 documented. This proves we understand the dependency's limits.
4. Committed results: `evidence/loadtest/*.json` + a markdown table + screenshots.

---

## 9. Decision-quality evaluation (replay against the real sim, fixed horizons)

Horizons: 96 and 384 ticks. Scripts: none, the final_combined events, and a surprise crisis. Policies: do-nothing · naive fill · **our greedy** · (LP if built).

| Metric | Do-nothing | Naive | Ours |
|---|---|---|---|
| service_level @96 / @384 | | | |
| Unmet liters (avoidable / unavoidable) | | | |
| FAILED allocations / overflow liters | | | |
| Forecast MAPE (vs last-value baseline) | | | |
| Stockout P: Brier score | | | |
| Detection delay / false-positive rate | | | |
| Review rate at 0 unsafe auto (rule vs Jev) | | | |

Filled by the P3 harness; it goes in the README and the demo.

---

## 10. Deliverables gate (brief §19)

- [ ] Fresh-clone `docker compose up`, rehearsed on a second machine
- [ ] README: prerequisites, configuration (`.env.example`), judge login, reset procedure, deployment, assumptions, data sources
- [ ] Architecture diagram: normal flow, fallback flow, writer fencing, data ownership, monitoring
- [ ] `evidence/`: resilience run output, dashboard/alert screenshots, the k6 workload + results, the deployment revision, rollback proof, the §9 table
- [ ] "Traps we found" doc (§2): robustness findings, presented as engineering tests
- [ ] `/version` build SHA, secret scan green, **Jev key rotated**
- [ ] Demo rehearsed twice + a backup recording

---

## 11. Open questions for the team

1. Finals duration and people per track?
2. Judging: local compose only, or AWS too? (Plan: local is primary, AWS is recorded evidence.)
3. Internet at judging? (The core flow works without Jev/Bedrock either way.)
4. OK to state that we read the simulator source (reading, not modifying)?

---

## 12. Codex discussion log

- **R1** (independent + adversarial review of the guide + source): agreed on all the §2 facts. Codex added the zombie SSE, inclusive event ends, outage arrivals, captive stations, the scenario lock and the snapshot race, and corrected the dispatch-cap claim.
  I reproduced the pool crash live (Codex couldn't confirm it from source alone).
- **R2** (judge-style review of v2): accepted all 10 of its changes: a vertical slice first, greedy MVP with LP as a stretch, cutting the twin, a paused demo, the evaluation table,
  closing the UX gaps, Jev reduced to evaluated triage, writer fencing, simplified AWS/dashboards/load work, and the deliverables gate.
- **Disagreements resolved:** the jitter replica is not used · Jev stays (the user's choice) but in the one role where calibrated probabilities matter, and it must earn its place in §9.
