# FuelOps reinforcement learning design

Design date: 2026-09-29. Budget: one GPU for approximately one day.
Status: design, not an implemented or trained policy. All thresholds below are proposed starting values, not measured results.

## 1. Recommendation and intended outcome

Build a **single centralized Maskable PPO policy that selects a complete feasible replenishment plan each decision tick**. A deterministic planner supplies the plans, and a deterministic validator controls execution. Train offline in a fast, tested environment; export the small actor into the existing Go intelligence process. Keep safe greedy available at all times.

The learned decision is how aggressively to replenish, which station needs scarce inventory first, and when to preserve or redistribute depot inventory. Code retains responsibility for liters, capacities, statuses, idempotency, approval, and simulator writes.

This is RL because a selected plan changes inventories and future options, and its return includes subsequent shortages and losses. It is not a classifier trained to imitate greedy. It is also not unrestricted continuous control: the candidate family intentionally limits the policy's choices.

Success means useful improvement over a tuned, event-aware baseline on held-out scenarios, with no regression in allocation validity, operational resilience, or ordinary-case service. No algorithm can be called the best before that comparison.

Scope assumptions:

- The target is the published BUP simulator: two depots, four stations, six routes, three fuels, normally 15-minute ticks.
- Preserve the Go backend and local-compose/AWS architecture. Python is an offline training dependency.
- No real fuel infrastructure, online exploration, or autonomous model retraining during judging.
- One day is a compute budget after the training environment works, not a promise to implement the entire platform and prove RL in 24 hours.
- The official judging horizon is unspecified. Evaluate multiple horizons and train a continuing controller; never give it a fabricated countdown to judging.

## 2. Evidence and the actual opportunity

The brief permits RL but requires comparison to a reasonable heuristic. Local research reports that a naive replenishment policy already attains service level 1.0 over substantial ordinary windows, with finite fuel eventually dominating. Those are existing project reports; they were not reproduced while writing this design.

Consequently, ordinary early baseline episodes cannot establish an RL advantage. The useful questions are:

1. Can the policy pre-position fuel before a visible disruption without overflowing stations?
2. Can it preserve Gazipur fuel for Tongi and Patiya fuel for Cox's Bazar while serving flexible stations from another depot?
3. Can it leave useful depot headroom before supply arrives?
4. Can it improve service under unseen combinations of demand, delayed supply, and route loss?
5. At equal service, can it reduce shipment requests and unnecessary long-route movements?

Rationing does not create fuel. Aggregate service level values every served liter equally. Fairness is reported separately; making fairness a competing objective requires an explicit product decision.

Existing documents disagree in places: earlier sections propose a digital twin, LP, and several Jev roles, while later reviews reduce them. This document adds the requested RL design without rewriting those concurrent plans. It recommends one training environment, one shared feasible planner, and Jev only as optional review assistance.

## 3. Algorithm choice

| Approach | Strength | Limitation | Decision |
|---|---|---|---|
| Candidate-plan Maskable PPO | Small discrete action space, established implementation, easily inspected choices, compact Go actor | Cannot discover a shipment plan outside the candidate family | Primary design |
| Direct allocation RL, e.g. autoregressive PPO or continuous SAC | Can learn more flexible quantities and routing | Coupled constraints, action projection, harder training and deployment parity | Add only if candidate limits demonstrably block improvement |
| Forecast-driven rolling-horizon optimization | Strong use of known dynamics; often very competitive on a tiny network | Forecast/model error; more planning compute | Strong comparator when already available; plausible eventual winner |

A masked DQN is also viable for this small discrete task, but implementing custom replay/mask handling is unnecessary for the first experiment. Start with the maintained Maskable PPO implementation. Its documentation supports discrete actions, requires mask-aware evaluation, and currently does not support recurrent policies. [Maskable PPO documentation](https://sb3-contrib.readthedocs.io/en/master/modules/ppo_mask.html)

## 4. Operational architecture

```text
Official simulator REST/SSE
          |
  existing ingestor: coherent snapshot + allocation reconciliation
          |
  forecast + features + feasible candidate plans
          |
  exported PPO actor inside Go intel
          |
  chosen plan + alternatives + estimated impact
          |
  deterministic validation and human-review rules
          |
  transaction: decision batch + recommendations + immutable outbox bodies
          |
  one fenced ingestor writer -> official allocation API
          |
  actual arrivals, demand and outcomes -> history, UI and monitoring

Model failure -> safe greedy -> same validator, approval rules and writer
Untrusted simulator state -> degraded read-only mode and review queue

Offline only:
scenario generator -> fast environment -> PPO training -> held-out evaluation
                                             |
                                  export actor and manifest
                                             |
                          Python/Go parity + official-image replay
```

The actor cannot call the simulator, change an event, bypass review, reset the world, or mutate inventory. Admin endpoints belong to the isolated evaluation harness and explicit operator controls.

## 5. Environment and tick semantics

Define a Gymnasium environment with `Discrete(13)` actions and a fixed ordered feature vector. One environment step means choose one shipment plan, apply its orders, process exactly one simulator engine pass, and observe the resulting state and reward.

Use this reference convention: the public instance reports logical tick T before the next engine pass processes T. The local source review reports that an order created at T normally departs during that pass at T, with arrival at T + transit_ticks. After processing T, the public instance reports T+1. Thus a transit of two does not mean arrival after only two calls to `step` from the pre-T observation. Make this a boundary fixture rather than relying on the example response in the guide.

Engine order, as recorded in the project source review:

1. Activate scheduled events.
2. Apply supplies to depots.
3. Depart pending allocations.
4. Deliver arriving allocations.
5. Generate demand and serve it.
6. Resolve events, then increment the public tick.

Event windows are inclusive at both ends. Existing in-transit shipments are not blocked by later route disruptions. Outage demand remains positive and unserved; fuel already in transit can still arrive during an outage.

Never terminate an episode merely because a station stocks out. Recovery is part of the task. For the default continuing task, a training-length limit is `truncated=True`, with value bootstrapping. An explicitly defined finite-horizon objective would instead require a remaining-time observation and terminal handling. [Gymnasium time-limit guidance](https://gymnasium.farama.org/tutorials/gymnasium_basics/handling_time_limits/)

In live operation, coalesce wake-ups and act on observed simulation ticks. Do not infer time from wall-clock speed. If ticks are skipped, record elapsed ticks, recompute from fresh state, and discard expired plans. Train skipped-decision cases as multiple ordinary world steps with no new action between them; this preserves the per-tick discount convention.

## 6. Observation contract

Stable entity/fuel ordering and fixed normalization are part of the model artifact. IDs determine placement, not learned numeric values. Reject an unknown topology rather than silently reshuffling features.

| Group | Features |
|---|---|
| Each of 12 station/fuel pairs | On-hand/capacity, pending and in-transit quantities, inbound ETA buckets, estimated ticks of cover, demand forecast over 4/8/24/48 ticks, recent demand mean and variability, unmet demand over the past 8 ticks, station status |
| Each of 6 depot/fuel pairs | Inventory/capacity, allocated-but-unreconciled reservations, headroom, upcoming supply in 4/8/24/48/96-tick buckets plus later-supply total and next ETA, estimated captive-station need |
| Each of 6 routes | Current availability, transit, max shipment, time until next known disruption and its end, whether departure in the execution window is exposed |
| Global | Sine/cosine time of day, simulation tick interval, snapshot age, missing/stale flags, recent skipped-decision count, remaining dispatch allowance per depot, visible event summaries |
| Each of 13 candidate plans | Quantity per station/fuel, selected-route encoding, total liters, request count, liter-transit proxy, resulting coverage summary, depot-headroom summary and valid mask |

Use scale factors such as tank capacity, 96 ticks/day, and known dispatch capacity. Give clipped/unavailable features explicit flags. Do not quietly convert missing inventory to zero. Keep feature construction identical in training and serving.

Start with an 8-tick rolling demand summary instead of recurrence. The observation is an approximate information state in a partially observed problem: hidden future injections and compressed history mean it is not a fully observable exact MDP.

Information exclusions:

- No scenario seed, future RNG values, scenario filename, hidden scenario schedule, training split ID, or future realized demand.
- A scheduled event returned by the public API is legitimate information. A surprise event is revealed only when injected/exposed.
- The trainer and critic receive the same observation restrictions.
- Fit forecasts and any learned scaling on training data only. Use actual `demand_liters`, not `served_liters`, to avoid interpreting stockouts as low demand.
- If current `demand_multiplier` already includes an active event, do not multiply that event a second time. Forecast scheduled changes and resolutions explicitly.

## 7. Action contract: thirteen complete plans

Action 0 is WAIT: no new allocation. Actions 1–12 cross three target coverage levels (8, 24, 48 ticks) with four deterministic ordering strategies:

| Strategy | Candidate construction rule |
|---|---|
| Urgency | Sort station/fuel pairs by earliest forecast stockout, then stable IDs; prefer shortest feasible route |
| Captive protection | Before allocating to a flexible station, reserve depot fuel for its captive station's coverage target; otherwise use urgency order |
| Supply headroom | First allocate useful station replenishment from depots forecast to clip upcoming supply, then urgency order; never ship fuel merely to dispose of it |
| Balanced scarcity | Sort by lowest forecast cover; choose a feasible source with the greatest residual days of supply after captive reservations, then shortest route |

The strategies are different planner configurations, not separate learned agents. The policy learns when to choose each. Cover targets use forecast demand integrated across the next H ticks and account for shipment arrival times; lead-time shortage remains visible rather than being erased by a total-inbound number.

For each station/fuel, compute a requested top-up from target demand plus a fixed forecast-error margin minus on-hand and usable inbound inventory. Clamp by physical feasibility. A target below current inventory creates no order. Evaluate arrival timing to prioritize shortages that can actually be prevented.

Each candidate contains at most one new shipment per station/fuel, so at most 12 shipments. Cap it by the chosen route's per-shipment maximum; excess can be reconsidered next tick. This matches the existing recommendation uniqueness by `(epoch,tick,station,fuel,policy)` and avoids a schema expansion for split routes. If this cap demonstrably binds, introduce explicit shipment children as a later action-space revision.

Construct each candidate on an independent copy of the same resource ledger. Within one candidate, subtract every proposed order from depot inventory, cross-fuel dispatch allowance, and destination room before constructing the next order. No independent per-station overbooking.

Always include the deployed safe-greedy configuration in the candidate set; select its coverage/ordering on validation, then freeze it. Collapse identical plans by masking all but a stable representative. WAIT remains valid. If an external random test supplies a masked action, return a controlled invalid-action result with no mutation; do not crash or silently map it to another shipment.

At inference use masked argmax, not random sampling. Mask invalid logits before selection; among valid logits within 1e-4 of the maximum, choose the lowest action ID. Use this deployment rule in validation and test evaluation from the start. Actor entropy or softmax probability is not a calibrated probability that a plan is safe.

The action-space ceiling is explicit: the actor cannot invent arbitrary reserve levels, separate coverage targets for every station, or multiple same-tick shipments to one station/fuel. Measure this limitation with a richer planner comparator before adding a more elaborate RL architecture.

## 8. Hard validator and allocation arithmetic

For each proposed order of fuel f on route r from depot d to station s, enforce:

```text
q <= min(
    remaining desired top-up,
    route.max_shipment,
    depot available inventory after local reservations,
    remaining depot dispatch allowance across ALL fuels,
    station capacity - current inventory - all reserved inbound liters
)
```

All terms must be finite and nonnegative. Round down to a documented 0.001-liter grid and revalidate; reject zero. This is not a minimum truck size: do not strand fuel with an arbitrary 500-liter cutoff.

The inbound reservation includes pending shipments, in-transit shipments, earlier orders in the same plan, and approved/ambiguous outbox orders not yet reflected in the snapshot. Reconciliation must prevent both forgetting reservations and subtracting an already reflected depot deduction twice.

This first capacity rule conservatively gives no credit for future station consumption. It prevents overflow even if an unexpected outage stops consumption. A more permissive forecast-at-arrival rule is an optional later optimization and must have its own low-consumption/outage tests; expected headroom alone is not a safety guarantee.

Also enforce:

- Route endpoints and fuel enum match; depot is OPEN or CONSTRAINED; station is OPEN; route is AVAILABLE.
- A known inclusive disruption interval must not intersect the plausible departure window, from the current logical tick through the latest permitted execution tick. Expire and replan when that window changes.
- A route disruption after departure is not grounds for invalidating an in-transit shipment.
- Depot dispatch usage is per creation tick and shared across fuel types, not a cap on all historical in-transit liters.
- Do not fabricate lower capacity for CONSTRAINED when the official image only changes its status label.
- Revalidate against fresh state immediately before each POST. A multi-order plan is not an atomic simulator transaction. Preserve accepted orders and replan the remainder after a rejection or tick change.
- Freeze automatic execution on stale, mixed-tick, incomplete or incompatible state. Human approval cannot override physical invalidity.

Known-event checks cannot guarantee protection against an unannounced disruption between validation and departure. Report that remaining race explicitly. The policy must recover; neither masking nor an attractive probability removes it.

## 9. Reward and objective

Use per-tick realized outcomes, never the cumulative service-level ratio as a repeatedly awarded reward.

```text
r_t = - unmet_liters_t / 1000
      - lost_liters_t / 1000
      - 0.002 * shipped_liter_transit_ticks_t / 1000
      - 0.002 * new_shipment_count_t
```

`lost_liters` includes station overflow, clipped depot supply and fuel destroyed by failed departure. `shipped_liter_transit_ticks` is sum(quantity × transit_ticks) for newly accepted shipments, charged once. It is a movement proxy, not a monetary transport cost: the simulator does not supply real prices.

These starting coefficients make unmet demand dominant while gently discouraging wasteful movements. They do not mathematically guarantee lexicographic priority: rerun with both movement penalties zero and reject settings that sacrifice meaningful service for fewer requests. Waste may also cause later unmet demand; penalizing both is an intentional preference for conserving fuel, not two separate physical losses.

Do not reward accepted allocations or transferred liters: that encourages emptying depots. Do not reward predicted improvements as though they happened. Do not add a terminal depot-emptying bonus. Do not hide outage unmet demand from the official service metric; report it separately to explain what allocation could not prevent.

For every episode compute undiscounted evaluation metrics regardless of training discount. The starting gamma is 0.997 per world tick; compare 0.995 and 0.999 on validation if long-delay credit assignment is weak.

Fuel accounting must reconcile, per fuel:

```text
initial useful inventory + actual offered external arrivals
= current station inventory + current depot inventory
  + pending/in-transit fuel + cumulative served fuel + cumulative lost fuel
  +/- measured rounding residual
```

Pending fuel is included because depot deduction occurs at acceptance. Do not count FAILED/ARRIVED/CANCELLED allocations as additional inventory. In the official adapter, infer losses from consecutive reconciled balances or verified replay details; `/v1/metrics.allocation_liters` is not received liters and does not reveal overflow.

## 10. Training environment and official-image parity

Use two execution paths with the same observation/action contract:

1. **Official adapter:** pause an isolated published image, reset it, inject documented events, submit allocations through public endpoints, and advance with `/admin/step`. This is the integration authority.
2. **Fast offline environment:** array-based inventory/transit/event transitions for many training episodes. This is a training model, not a replacement submission simulator. Document generated data and never patch the official image to improve results.

Keep one shared Go candidate planner/validator implementation. Each Python environment worker owns a persistent Go process and exchanges newline-delimited JSON; subprocess workers must not share pipes or inherit a live bridge connection. The protocol also accepts batches for offline evaluation. Benchmark this boundary. A second handwritten Python planner is avoidable training-serving divergence. Implement a faster binding only if measurement shows process communication dominates runtime.

Before PPO training, require differential replay against the official adapter for:

- One order at T, departure timing, and arrival-before-demand timing.
- Disruption starting at T and ending at T, cancellation/refund, disruption after departure.
- Two inbound shipments that would overflow, and an unexpected destination outage.
- Depot supply clipping and headroom created before supply processing.
- Dispatch cap shared across fuels, including PENDING cancellation and tick rollover.
- CONSTRAINED depot eligibility; empty event filters; overlapping event behavior.
- Supply delay versus already DELAYED supply, and compounded shortfalls.
- Fractional quantities, three-decimal rounding, idempotent replay after ambiguous POST.

For exact differential checks, feed the offline model demand observations from the reference run as exogenous test inputs. Replay that demand tape only in the parity test, never in the deployed policy. Compare entity states, allocation statuses and conservation after each step. Match quantities to the official rounding convention and explicitly document residual tolerances; do not claim byte identity for JSON formatting or unverified RNG replication.

Keep ordinary training demand stochastic with the documented profile/hour/region factors and uniform noise. No exact future-jitter reconstruction is required. Maintain faithful transition quirks in the parity profile; separately label physical or timing variations as robustness tests.

The official reset API does not expose arbitrary seed/scenario selection. Different offline seeds are synthetic diversity, not evidence of many official-image seeds. Public event scripts provide official-compatible variation. Modified initial stocks, capacities or supply schedules belong only to documented synthetic tests unless supported by organizer tooling.

## 11. Scenario distribution and leakage control

Persist a complete manifest per episode: scenario generator version, RNG seeds, event disclosure times, event parameters, starting state, horizon, and hash. Split manifests before training. Split event templates/combinations as well as random seeds so validation is more than a new jitter sample of the same crisis.

Training mix, after an initial easy curriculum:

| Share | Family |
|---|---|
| 20% | Ordinary operations and no-op stretches |
| 20% | Demand spikes and recovery |
| 20% | Route loss, including captive-route loss |
| 15% | Shipment delay and supply shortfall |
| 15% | Combined scarcity with flexible/captive competition |
| 10% | Outages, skipped decisions, delayed observations, recovery |

Initial generated ranges: demand multipliers 1.2–3.0, durations 4–48 ticks, delays 2–32 ticks, shortfall factors 0.2–0.9; sample targets and onset independently subject to valid semantics. These are proposed training ranges, not organizer promises. Include announced and surprise events. Avoid making every hard scenario solvable: unavoidable loss must remain possible.

Synthetic starting inventory may vary from 10–90% capacity to expose scarcity earlier; obtain some low-stock starts by running a reference policy to a sampled checkpoint. Label synthetic starts distinctly. Keep official-state episodes throughout training so domain randomization does not displace the actual target.

Curriculum: mechanics and ordinary demand, then one disruption, then mixed disruptions/scarcity, finally a stable mixture. Freeze the final distribution for model comparison. Hold out stronger disturbances and unseen combinations for stress testing, reported separately from in-distribution tests.

Wall-clock HTTP faults are a separate system suite: official `error_rate` is not controlled by the simulator seed. Use deterministic unavailable/latency faults for reproducible acceptance; train delayed-observation and skipped-decision effects in tick units. Do not claim wall-clock fault parity from the offline environment.

## 12. Network, hyperparameters and one-day compute budget

Start with separate actor and critic MLPs, each two hidden layers of 128 tanh units. Actor outputs 13 logits; critic outputs one state value. No transformer, GNN or recurrent network is needed for this fixed small topology. The critic is training-only.

| Setting | Initial value |
|---|---|
| Algorithm | SB3-contrib MaskablePPO with fixed-vector observation |
| Parallel training worlds | Start 8; benchmark 8/16/32 offline environments |
| Rollout length | 256 world steps per environment |
| Minibatch | 256 |
| Epochs/update | 4 |
| Learning rate | 3e-4, linear decay |
| Discount / GAE lambda | 0.997 / 0.98 |
| PPO clip / gradient norm | 0.2 / 0.5 |
| Entropy coefficient | 0.01; validate 0.001 if excessive WAIT/plan switching persists |
| Value coefficient / target KL | 0.5 / 0.02 |
| Training segment length | Sample 192–768 ticks; external truncation |
| Initial pilot | 200,000 total world transitions |
| Main budget | Approximately 1–3 million transitions per training seed, throughput permitting |

Pin a mutually compatible Python/PyTorch/Gymnasium/SB3/SB3-contrib environment in a lockfile when implementing. Use the mask-aware evaluation callback and environment-provided masks in subprocess workers. [Implementation guidance](https://sb3-contrib.readthedocs.io/en/master/modules/ppo_mask.html)

The GPU is optional acceleration for a small MLP. Benchmark end-to-end throughput on CPU and GPU; host simulation and process transport can dominate. Batch policy inference/updates on the GPU if it wins. Do not spend a day chasing GPU utilization.

Suggested allocation of the 24-hour compute window:

| Window | Work and exit condition |
|---|---|
| Hours 0–2 | Frozen environment/parity suite, benchmark transitions/s, baseline evaluation. If parity fails, stop training and repair it. |
| Hours 2–5 | Short runs: base settings, alternative gamma, zero movement penalty, candidate-family sanity. Eliminate obvious failures. |
| Hours 5–16 | Best one or two configurations; aim for five independent training seeds, minimum three clearly disclosed. Parallelize only if throughput improves. |
| Hours 16–20 | Frozen held-out comparison and ablations; select release checkpoint using validation only. |
| Hours 20–23 | Official-image replay, actor-export parity, fallback and latency checks. |
| Hours 23–24 | Package checkpoint/evidence; no last-minute test-set tuning. |

Calculate affordability from measurements: for K seeds and N transitions each, sampling time is approximately K×N/(aggregate transitions/s), plus measured update/evaluation time. Reserve at least 25% of the budget for verification. If sampling is slow, reduce search breadth before reducing evaluation quality.

## 13. Evaluation: establish that RL earns deployment

Baselines all receive the same public information, forecast, validator, reservation accounting and execution cadence:

1. Do nothing, as a sanity floor.
2. Tuned event-aware safe greedy, not just the old naive probe.
3. Best fixed candidate configuration selected on validation.
4. A rule-based selector among the same 13 candidates.
5. Short-horizon lookahead or existing LP/MPC if implemented; give it the same operational information. A clairvoyant optimizer is an upper reference and must be labeled oracle.

This separates gains from better safety code, better candidates, and actual sequential learning. Include ablations for no event lookahead, fixed cover, no learned selection, and no movement penalties. Do not remove physical safety checks in the real simulator just to create an unsafe baseline.

For each frozen policy report:

- Total unmet liters and service level; station/fuel breakdown and lowest-station service.
- Failed allocations, preventable overflow, depot clipping, stranded inventory and conservation residual.
- Request count, liter-transit proxy, invalid proposals, rejection/replan rate.
- Worst-decile unmet demand, crisis recovery time, and maximum stockout duration.
- Review burden, fallback rate, and inference/whole-decision p50/p95/p99.

Run at least 200 held-out generated episode manifests per training seed, stratified by family. Use paired comparisons on identical demand/event realizations; randomness must be independent of policy actions. Report mean differences and 95% confidence intervals, resampling independent scenario units and training seeds rather than treating thousands of adjacent ticks as independent samples. Multiple seeds and interval estimates address the evaluation problems highlighted in [Deep RL at the Edge of the Statistical Precipice](https://arxiv.org/abs/2108.13264).

Official-image acceptance: 40 frozen event scripts across eight families (normal, spike, route disruption, delay, shortfall, station outage, combined, surprise/recovery), each run to 576 ticks with checkpoints at 96 and 384. Add a small 768-tick exhaustion suite. Compare the frozen release actor against the strongest practical baseline and the rule selector. All use the same original image and public event injection. Record actual image digest and event manifests. Reduce case count only if measured official throughput requires it, and disclose the reduced coverage.

Proposed promotion gates, frozen before opening the test set:

1. All contract/parity/export tests pass. No observed duplicate writes or preventable overflow/invalid automatic actions.
2. On the scarce/combined evaluation stratum, at least 5% lower mean unmet liters than the strongest baseline, with the paired 95% interval for improvement above zero. Use this relative gate only where the baseline has material unmet demand.
3. On ordinary scenarios, aggregate service does not regress by more than 0.1 percentage point; no significant unexplained worst-case failure is hidden by averaging.
4. If there is no service headroom, an alternative win is at least 20% fewer allocation requests at non-inferior service, without extra losses or worse crisis recovery. Predeclare whether this is the target.
5. Initial target: actor inference p95 below 10 ms, whole planner+actor decision p95 below 100 ms on the deployment CPU. Measure; these are acceptance targets, not present capabilities.
6. Official-image results agree with the claimed benefit. A synthetic-only improvement is not sufficient to replace greedy.

If the model fails these gates, retain it in shadow mode and ship the strongest baseline. That is an empirical outcome, not an excuse to weaken the baseline or change the test distribution.

## 14. Export and Go integration

Export only the actor: weights/biases, tanh activation, feature schema/scales/order, action/candidate schema, and manifest. A two-layer dense network needs only matrix-vector multiplication and tanh in Go; no serving cluster, Python HTTP service, ONNX runtime or GPU is needed at runtime.

Artifact manifest: policy ID, training commit, artifact SHA-256, reference image digest, scenario split hashes, feature/candidate/reward versions, seed/config, validation summary, and supported topology. Package it with the intelligence image and make activation an atomic validated swap.

Compare Python and Go on at least 1,000 observations covering normal, boundary and crisis states. Compare unmasked logits to a defined tolerance (starting target 1e-5 for consistently represented weights), mask application, and chosen action. A near tie is handled by the same deterministic tolerance/tie-break rule in both implementations; test that rule too. Any schema mismatch, nonfinite value or invalid selected candidate activates fallback and emits a reason.

Reuse the existing simulator client, snapshots, recommendation records, decisions, and outbox. Add a small persisted decision-batch record with unique `(epoch_id,tick)` to fence competing policy versions and include WAIT decisions. Link its recommendations, snapshot hash and actor version in the same transaction. A model change must not authorize a second independent batch for a tick merely because recommendation uniqueness includes `policy_version`.

The writer maintains a database-backed leadership lock. A per-process semaphore alone does not create a system-wide four-request cap when several replicas instantiate clients. All operational simulator calls must remain on the single controlled ingress/writer path, with the documented aggregate cap.

Before executing an approved batch, check epoch, state age, resources and departure window again. Expire pending approval when the world advances beyond the plan's validity. On reset invalidate old recommendations and retries. Tick regression/seed change detects many resets, but an external same-seed reset at the same tick needs an explicit reset signal or reconciliation; do not assume the seed is a unique world identifier.

No migrations or source changes are performed by this design document.

## 15. Safety, explanations and observability

The application may say: "Selected 24-tick captive-protection plan; preserves X liters at Gazipur for Tongi, supplies Mirpur from Patiya, and satisfies the following capacity checks." All numbers come from the planner and current state.

For a recommendation, compare chosen plan, baseline and WAIT over the same forecast trajectories and fixed follow-up policy, using common random numbers. Start with 64–128 demand samples. Include all candidate shipments and future recourse assumptions. These are conditional model estimates; unknown surprise-event risk is not covered by demand noise alone.

Display estimated unmet demand, stockout probability, an uncertainty interval, alternatives and binding constraints. Validate probability calibration/Brier score on held-out outcomes. Do not substitute PPO action probability, entropy or critic value for confidence. A 64-sample estimate should not be presented with spurious decimal precision.

Hard rules force review for high-impact plans, unsupported conditions or uncertain data. Thresholds are configured and frozen before evaluation. Jev may assist borderline review triage and an LLM may phrase explanations; neither may override hard rules or choose physical quantities. When a reviewer changes a plan, mark it as a human action rather than silently treating it as an on-policy PPO sample.

Monitor policy ID, decision mode, inference latency, candidate availability, WAIT frequency, shipment count, policy-versus-baseline disagreement, stale-state blocks, overrides, fallback reasons, model/feature mismatches, service outcomes and resource conservation. Use low-cardinality metrics; keep decision IDs and per-order detail in logs/audit records.

Model degradation is measured from delayed operational outcomes; one bad tick cannot establish a model regression. Immediate fallback triggers are invalid output, model/schema failure, hard-validator failure or expired inference. Distribution-shift indicators trigger baseline/review conservatively and must be calibrated; in-range inputs are not proof of safety.

## 16. Implementation order and concrete deliverables

| Stage | Deliverable | Required evidence before proceeding |
|---|---|---|
| 1 | Shared snapshot/reservation contract, event-aware greedy, candidate plans, hard validator | Boundary fixtures and accounting; no duplicate/overbooked plans |
| 2 | Official paused-step harness and baseline report | Reproducible manifests, actual outcomes, explicit horizon |
| 3 | Offline environment and shared Go planner bridge | Differential replay plus measured throughput |
| 4 | PPO training, versioned features/reward, fixed splits | Pilot beats sanity floors and does not exploit accounting bugs |
| 5 | Multi-seed experiments and comparison | Frozen held-out report with intervals and ablations |
| 6 | Actor export and integration into intel | Python/Go parity, latency, corruption/fallback tests |
| 7 | Shadow mode, review workflow, deployment | Official-image benefit, approval expiry, restart/rollback demonstration |

Suggested new locations, adjusted to the existing repository as it evolves:

```text
backend/internal/planner/       shared candidate generation and validation
backend/internal/policy/        exported actor inference and manifest checks
training/env.py                 offline world and Gymnasium interface
training/train.py               PPO configuration and checkpoints
training/evaluate.py            paired evaluations and report generation
training/export.py              actor weights and parity fixtures
training/scenarios/             immutable train/validation/test manifests
models/                        promoted actor plus manifest
evidence/rl/                    results, image digest, plots and failure cases
```

Reuse existing tests and packages when present; these are responsibility boundaries, not an instruction to create empty scaffolding. Keep a small runnable boundary suite and export-parity check. Add tests for actual failure modes, not trivial getters.

Demo sequence: show ordinary operation; replay a held-out announced crisis against baseline and RL; inspect actual decisions and outcomes; show a surprise event; disable the model and observe fallback; restore it; show the frozen evaluation report. Run the same event script for both policies. Never paste aspirational improvement percentages into the UI.

## 17. Source map

- [Official challenge brief](BRIEF.md), sections 8, 9, 11, 16, 19, 23–24: RL comparison, explanations, resilience, generated-data disclosure and simulation-only scope.
- [Integration guide text](research/guide.txt): public API, admin testing, topology and documented formulas.
- [Existing source review](research/codex_independent.md): actual tick order, transit, clipping, event quirks, demand and API behavior. Findings are inherited project evidence and require executable verification in stage 2/3.
- [Existing critique](research/codex_critique.md): reservations, captive stations, capacity limits and finite-fuel objective.
- [Plan review](research/codex_plan_review.md): evaluation and product-first scope.
- [PPO paper](https://arxiv.org/abs/1707.06347): underlying policy-gradient method.
- [Invalid action masking paper](https://arxiv.org/abs/2006.14171): masking in policy-gradient methods; masking only addresses the encoded invalidity conditions.
- [Maskable PPO docs](https://sb3-contrib.readthedocs.io/en/master/modules/ppo_mask.html): implementation and evaluation constraints.
- [Gymnasium time limits](https://gymnasium.farama.org/tutorials/gymnasium_basics/handling_time_limits/): termination versus truncation.
- [Reliable RL evaluation](https://arxiv.org/abs/2108.13264): uncertainty-aware comparisons across runs.

The model architecture, candidate family, hyperparameters, training distribution, compute schedule and promotion thresholds are engineering recommendations in this design, not claims established by those papers or existing benchmark results.
