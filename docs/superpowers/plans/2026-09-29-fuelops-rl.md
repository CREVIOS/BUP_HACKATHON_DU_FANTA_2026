# FuelOps RL Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task. Use `superpowers:subagent-driven-development` only if parallel agent execution is explicitly selected. Steps use checkbox syntax for tracking.

**Goal:** Train and evaluate a centralized constrained RL allocation policy within one GPU-day of compute, then integrate the validated actor into the existing Go platform with safe fallback.

**Architecture:** A shared Go planner creates thirteen feasible shipment plans. Offline Python Maskable PPO learns which plan to choose from current public information. Go runs the exported actor; the existing ingestor remains the sole simulator writer.

**Tech stack:** Existing Go module, PostgreSQL/pgx/goose and Prometheus; offline Python, NumPy, Gymnasium, PyTorch and SB3-contrib. Plain exported dense actor weights for Go inference.

**Spec:** [RL_DESIGN.md](../../RL_DESIGN.md). Read the entire spec before implementation.

## Global constraints

- Budget: one GPU for approximately one day. The compute window starts after the environment and shared planner pass their tests.
- One policy controls the whole network. Thirteen discrete actions; one action produces at most one shipment per station/fuel, at most twelve shipments.
- Coverage candidates are 8, 24 and 48 ticks crossed with urgency, captive protection, supply headroom and balanced scarcity; action 0 is WAIT.
- The official simulator image remains unchanged. Training worlds and generated data are labeled separately.
- No scenario seeds, hidden event schedules or future demand enter actor/critic features.
- Physical safety, human review, persistence and idempotency are enforced outside RL.
- The runtime remains Go and uses the existing outbox. No separate model-serving service or deployment GPU.
- Preserve concurrent work. Re-read existing interfaces and `git diff` before editing; do not restore, reset, move or commit unrelated files.
- No cloud deployment, external messaging, simulator reset or training job is performed as part of writing this plan.
- The current `backend/go.mod` has moved to Go 1.26.0 during parallel project work; use its current pinned version rather than the older infra document's version.

## Review focus

1. An ambiguous POST followed by a crash must not duplicate fuel or forget its capacity reservation: tasks 1 and 8.
2. Arrival, event activation and public tick advancement differ by a boundary step: task 3.
3. Every non-WAIT candidate may be masked, or logits may tie/be nonfinite: tasks 2 and 7.
4. Same-seed reset, policy replacement or partial batch acceptance must not reuse old-world work: tasks 1 and 8.
5. A test episode may accidentally reveal future events or exploit a fixed cutoff: tasks 4 and 6.

## Current repository and dependency map

At planning time, `backend/internal/intel/intel.go` is a health-only skeleton, the ingestor snapshots only `/v1/instance`, and `sim/types.go` contains the instance type. The existing schema already has snapshots, recommendations, decisions and an immutable-body outbox. Full ingestion and outbox execution are unfinished project dependencies, not existing proven capabilities.

Tasks 1–3 create a usable safe allocation/evaluation foundation even if RL fails. Tasks 4–6 create the training and evidence package. Tasks 7–9 integrate and demonstrate only a model that earns promotion.

```text
1 typed snapshots/reservations -> 2 candidates/features -> 3 official reference
                                         |                       |
                                         +---- 4 fast env/parity -+
                                                      |
                                                5 PPO training
                                                      |
                                                6 evaluation
                                                      |
                                                7 Go export
                                                      |
                                                8 execution
                                                      |
                                                9 demo/evidence
```

Existing core work may supply parts of tasks 1 or 8. Reuse verified implementations and run their checks; do not build a second ingestor, forecaster, safety validator or outbox.

## Task 1: Trusted snapshot and resource reservations

**Files:** Extend `backend/internal/sim/types.go`; create `backend/internal/planner/state.go` and `state_test.go`; integrate with `backend/internal/ingestor/ingestor.go` if its core snapshot work is not already complete.

**Interfaces:**

- `planner.Snapshot`: epoch ID, logical tick, capture time, stale flag, schema version, and typed instances/regions/stations/depots/routes/events/supplies/allocations.
- `planner.DemandRow`: station ID, fuel, logical tick, demanded/served/unmet liters.
- `planner.Reservation`: immutable shipment key, source/destination/route/fuel/quantity, decision epoch, observed allocation ID if reconciled, and acceptance uncertainty.
- `planner.Prepare(s Snapshot, history []DemandRow, pending []Reservation) (Input, error)`.
- `planner.Input` contains the validated snapshot, reconciled resource ledger, ordered demand forecasts, recent-history summaries and public event timeline. It is serializable for the training bridge.

- [ ] Write `TestPrepareReservations` with a 1,000 L already-deducted accepted order and a 500 L unaccepted outbox order: inbound reservation must be 1,500 L, but only the unreflected 500 L reduces the snapshot depot balance again.
- [ ] Add assertions that duplicate keys count once; conflicting payloads under one key fail; negative/NaN inventory, missing station/fuel and mixed epochs return errors; a tick fence change prevents use.
- [ ] Run `go -C backend test ./internal/planner -run TestPrepare -count=1` and observe the new tests fail before implementation.
- [ ] Implement typed ingestion and the reconciliation function. Construct forecasts from demand rather than sales; use documented hour/profile factors with an EWMA correction and no active-multiplier double counting.
- [ ] Require a before/after `/v1/instance` fence on coherent snapshots and combine stale metadata from every component read. External reset signals invalidate the ledger; ambiguous same-tick reset state forces resynchronization/review.
- [ ] Repeat the command until it passes. Persist snapshot schema version and stable content hash for downstream decisions. Commit only this task's files when implementation is authorized.

## Task 2: Feasible plans, masks and versioned features

**Files:** Create `backend/internal/planner/candidates.go`, `features.go`, `candidates_test.go`; add `backend/cmd/rlbridge/main.go`. Reuse an existing planner package if concurrent work has created it.

**Interfaces:**

- `Shipment{SourceDepotID, DestinationStationID, RouteID, Fuel string; Quantity float64}`.
- `Plan{ActionID int; Shipments []Shipment; Summary PlanSummary}`; `PlanSummary` includes liters, requests, liter-transit, station cover and depot headroom.
- `planner.Candidates(in Input) ([13]Plan, [13]bool, error)`.
- `planner.Features(in Input, plans [13]Plan, mask [13]bool) ([]float64, error)` with named schema/version/order and fixed scale constants.
- `planner.Validate(in Input, p Plan) error`, using the same ledger arithmetic as candidate construction.
- Bridge request: `{"schema_version":1,"inputs":[Input,...]}`; response: `{"schema_version":1,"results":[{"features":[],"plans":[],"mask":[]},...]}` in the same order. Errors identify the failed item. Stdout is protocol only; logs go to stderr.

- [ ] Write `TestCandidateSafety`: station capacity 10,000, inventory 6,000 and inbound 3,000 implies every new shipment quantity is at most 1,000; depot dispatch 1,500 implies the sum across all fuels is at most 1,500.
- [ ] Add `TestWaitAndDuplicateMask`: `mask[0] == true`, no duplicate non-WAIT executable plans remain valid, zero-demand/zero-inventory input still returns WAIT, and a newly starting departure disruption excludes that route.
- [ ] Assert each candidate has at most twelve orders, no repeated station/fuel pair, quantity rounded down to 0.001 L, and no arbitrary 500 L lower bound. For two equivalent paths tie-break by stable route ID.
- [ ] Run `go -C backend test ./internal/planner -run 'TestCandidate|TestWait' -count=1` and confirm new tests fail.
- [ ] Implement the thirteen strategies in one deterministic planner. Every plan starts from an independent ledger; every order reserves inventory and cross-fuel dispatch immediately. Validate all candidates.
- [ ] Implement features and the persistent bridge with batch support, preserving fixed entity/fuel order and explicit missing/clipped flags. Each environment worker creates and owns its bridge process after worker startup; workers never share pipes. Include forecast uncertainty and candidate summaries without running Monte Carlo for all thirteen plans.
- [ ] Add a feature fixture: changing only the scenario seed or hidden injected-event manifest must not change features; a visible scheduled event must change its relevant timeline features.
- [ ] Run the planner tests and a two-input bridge round trip; both results must match direct calls and input order. Build `go -C backend build -o ../training/bin/rlbridge ./cmd/rlbridge` after creating the destination directory. Commit the bounded task.

## Task 3: Official reference harness and baseline

**Files:** Create `training/reference.py`, `training/tests/test_reference.py`, `training/scenarios/reference.json`; use the published simulator service from the project's actual compose file when available.

**Interfaces:** `OfficialEnv(base_url: str, allow_reset: bool)`, `reset(event_manifest: dict) -> dict`, `step(shipments: list[dict]) -> dict`. Returned data includes pre/post tick, snapshot, actual demand rows, accepted allocation identities, metrics and conservation inputs. Use stdlib HTTP with bounded timeouts. Never default to a live/demo instance for destructive setup.

- [ ] Write a fake-HTTP unit check that reset is refused without `allow_reset`, admin calls never produce policy features, and identical ambiguous allocation retries preserve key and body.
- [ ] Implement a CLI requiring explicit `--url`, `--allow-reset`, `--manifest`, `--policy`, `--horizon` and `--output`. Refuse to reset a non-isolated target unless explicitly designated by the operator; no automatic production discovery.
- [ ] On a disposable paused image, test an allocation at public T with transit two: departure at engine T, arrival at engine T+2, visible in the post-pass public T+3 state. Verify this against the actual image before freezing the convention.
- [ ] Exercise all differential cases in RL_DESIGN section 10 and save per-step reference traces, image digest, request/status records and manifests. Do not rerun the known simulator high-concurrency crash probe.
- [ ] Run no-op and tuned safe greedy at horizons 96, 384 and 576; record service, unmet liters, losses and request count. Never treat a missing/failed run as zero unmet demand.
- [ ] Verify with `python3 -m unittest training.tests.test_reference` and the explicit disposable-image command `python3 -m training.reference --url http://127.0.0.1:18000 --allow-reset --manifest training/scenarios/reference.json --policy greedy --horizon 576 --output evidence/rl/reference`.
- [ ] Gate: event, transit, clipping and reservation semantics match observed behavior; baseline outcomes are reproducible. Commit code/manifests and compact evidence metadata, excluding secrets and large transient traces.

## Task 4: Fast training world and scenario splits

**Files:** Create `training/env.py`, `planner_bridge.py`, `scenarios.py`, `tests/test_env.py`, and `training/requirements.lock` with a compatible pinned training stack. Add package markers only if needed by the selected Python layout.

**Interfaces:**

- `FuelEnv(manifest: dict, bridge: PlannerBridge)` implements `reset(seed=None, options=None)` and `step(action: int) -> (obs, reward, terminated, truncated, info)`.
- `FuelEnv.action_masks() -> numpy.ndarray[bool]` returns thirteen entries.
- `PlannerBridge.evaluate(inputs: list[dict]) -> list[dict]` wraps task 2 and validates response schema/cardinality/finiteness.
- `generate_manifest(split: str, seed: int, family: str) -> dict` and a CLI producing immutable split files and hashes.
- Observation features and selected shipments come from the Go planner; the Python world owns only transition dynamics and metrics.

- [ ] Write `test_clock_and_conservation`: replay the reference demand tape and actions; assert every entity's inventory/status and public tick match the official trace at every step within the explicitly recorded rounding tolerance.
- [ ] Write `test_truncation_and_no_leakage`: horizon cutoff yields truncation, stockout does not terminate, hidden future events do not appear in observation, and changing chosen actions does not change exogenous demand for a given manifest/tick.
- [ ] Write `test_mask_and_invalid_action`: WAIT is always valid; a masked action causes a controlled rejected action without inventory mutation; zero valid shipment actions do not crash.
- [ ] Implement array-based transit queues and event processing using task 3's verified ordering. Store offered supply and actual loss separately; enforce the fuel-accounting identity.
- [ ] Implement the reward exactly as RL_DESIGN section 9, with all coefficients named in run configuration. Keep raw reward components in `info` for auditing.
- [ ] Generate train/validation/test manifests with disjoint seeds and held-out event templates. Persist event disclosure times separately from event activation times. Implement the final mixture 20/20/20/15/15/10 percent as specified in the design.
- [ ] Run `python3 -m unittest training.tests.test_env`. Require all recorded reference traces to pass differential replay before any main training job.
- [ ] Benchmark 8/16/32 vector worlds, CPU and GPU policy inference, and bridge cost. Write transitions/s, update time, memory and hardware to `evidence/rl/throughput.json`. Use the measured fastest stable combination.

## Task 5: Reproducible Maskable PPO training

**Files:** Create `training/train.py`, `training/config.json`, `training/tests/test_training.py`; use `runs/rl/` for uncommitted checkpoints/logs and store only selected artifacts later.

**Interface:** `python3 -m training.train --config training/config.json --seed 11 --steps 200000 --run-dir runs/rl/pilot-11`. `--steps` is total world transitions across vector worlds, not per worker. Save resolved configuration, versions, hardware, scenario hashes and RNG state with every resumable checkpoint.

- [ ] Write `test_training_smoke`: construct two tiny environments, train one rollout/update, save/reload and assert all deterministic selected actions are valid. Confirm mask-aware evaluation is invoked, with training normalization frozen for evaluation.
- [ ] Configure actor/critic `[128,128]` tanh networks; rollout 256/environment, batch 256, epochs 4, learning rate 3e-4 with linear decay, gamma .997, GAE .98, clip .2, gradient norm .5, entropy .01, value coefficient .5, target KL .02.
- [ ] Implement training, evaluation checkpointing and interruption/resume using SB3-contrib. Use `MaskableEvalCallback`; implement masks inside subprocess environments. WAIT/duplicate handling must match task 2. For all deterministic validation/test evaluations, choose the lowest valid action ID within 1e-4 of the maximum logit, matching the later Go actor; retain stochastic masked sampling during training.
- [ ] Run `python3 -m unittest training.tests.test_training` followed by the 200k-transition pilot. Inspect mask frequency, WAIT rate, reward components, KL, entropy and conservation; fail the run on NaNs or accounting violations.
- [ ] Compare the base configuration, gamma alternatives and zero movement penalties on validation within the first three experimental hours. Freeze at most two finalists. No test-set evaluation during tuning.
- [ ] Train finalists with seeds 11, 23, 37, 53 and 71, targeting 1–3 million transitions each if throughput permits. At least three independent seeds are needed for the reduced-budget report; disclose if fewer complete.
- [ ] Enforce a wall-clock stop that preserves the last checkpoint and the verification time reserve. Record every attempted configuration, not only the winning run.

## Task 6: Held-out evaluation and promotion report

**Files:** Create `training/evaluate.py`, `training/tests/test_evaluation.py`, `evidence/rl/report.md` and machine-readable paired results.

**Interface:** `python3 -m training.evaluate --checkpoints runs/rl/finalists.json --split training/scenarios/test.json --output evidence/rl`. A separate `--reference-url` mode invokes task 3 for official-image testing; it must still require explicit reset authorization.

- [ ] Write `test_paired_evaluation`: identical policies produce zero paired difference; reversed policy order leaves the exogenous realization unchanged; missing runs raise an error; bootstrap units are complete scenarios and training seeds, never ticks.
- [ ] Implement no-op, tuned safe greedy, best fixed candidate and rule selector with identical information and hard validation. Add an existing MPC/LP comparator if it exists; do not create a large optimizer merely to tick a box.
- [ ] Evaluate at least 200 held-out manifests per training seed; report mean and interval, worst decile, per-station/fuel service, loss categories, stranded inventory and requests. Run ablations for event visibility, fixed coverage, learned selection and movement penalties.
- [ ] Freeze the release checkpoint using validation selection only. Run its 40-script official suite against greedy and the rule selector to tick 576 with 96/384 checkpoints, plus the separate 768-tick exhaustion cases.
- [ ] Apply the preregistered promotion gates: material scarce-case baseline, >=5% less mean unmet with paired 95% improvement interval above zero; <=0.1 percentage-point ordinary service regression; no observed preventable overflow/duplicates/invalid automatic orders. The alternative efficiency gate is >=20% fewer requests at non-inferior service and crisis recovery.
- [ ] Write `report.md` with completed-run counts, all failed seeds, exact manifests/digests, synthetic versus official tables, confidence intervals and failure examples. Mark a failed gate as failed; do not redefine it after seeing results.
- [ ] Run `python3 -m unittest training.tests.test_evaluation` and the frozen evaluation CLI. Promotion remains false until official results support the claimed advantage.

## Task 7: Exported actor in Go

**Files:** Create `training/export.py`, `backend/internal/policy/actor.go`, `actor_test.go`, `models/manifest.json`, and the selected actor artifact. Store fixtures under `backend/internal/policy/testdata/`.

**Interfaces:** `policy.Load(path string) (*Actor, error)`; `(*Actor).Choose(features []float64, mask [13]bool) (int, error)`; `(*Actor).Logits(features []float64) ([13]float64, error)` for parity verification.

- [ ] Export the actor-only weights, biases, feature scales/schema, action definitions, supported topology and hashes. Exclude critic, optimizer and training-only RNG/state from runtime artifacts.
- [ ] Write `TestActorParity` with at least 1,000 exported reference observations/logits/actions. Assert logits within starting tolerance 1e-5 and identical masked decisions under the common tie rule.
- [ ] Write `TestActorRejectsCorruption`: bad checksum, wrong dimensions, wrong feature version, NaN/Inf input or weights, and invalid topology all return errors. All shipment actions masked selects WAIT; a false WAIT mask is a contract error.
- [ ] Match task 5's inference tie tolerance of 1e-4: among valid logits within tolerance of the maximum, choose the lowest action ID. Test differences from training-time sampling; do not introduce a new selection rule after held-out evaluation.
- [ ] Implement dense matrix-vector products and tanh with Go standard library; load/validate once, not per request. No ONNX runtime dependency is needed for these layers.
- [ ] Run `go -C backend test ./internal/policy -count=1` and benchmark actor latency on the deployment CPU. Require p95 below the proposed 10 ms target, or report/revisit the target before promotion.
- [ ] Atomically publish the artifact and manifest after successful parity. Preserve previous model version for rollback.

## Task 8: Intelligence integration, decisions and safe execution

**Files:** Extend `backend/internal/intel/intel.go`, existing API and ingestor packages; add `backend/internal/store/migrations/00002_decision_batches.sql` only if that number is still free, otherwise use the next migration number. Add focused package integration tests.

**Interfaces:** `intel.Recommend(ctx context.Context, in planner.Input) (DecisionBatch, error)` returns snapshot hash, epoch/tick, policy ID, chosen action, plan, baseline comparison, review status and expiry. `DecisionBatch` is persisted once per `(epoch,tick)` including WAIT.

- [ ] Write a database integration check: two simultaneous planners/policy versions for the same epoch/tick create one batch and one set of outbox entries; retries preserve the exact body/key.
- [ ] Write execution checks for a tick change before POST, half-accepted batch, crash after accepted-but-unacknowledged POST, pending approval past expiry, and world reset. Expected behavior is reconcile accepted work, expire stale work and replan only the remaining valid demand.
- [ ] Implement additive schema changes linking recommendations to decision batches. Preserve the original recommendation schema's one shipment per station/fuel constraint. Never replay old-epoch outbox bodies into a reset world.
- [ ] Integrate actor selection behind `POLICY_MODE=greedy|shadow|rl`, default greedy. Shadow mode computes RL recommendations without enqueuing them. A failed actor loads/computes safe greedy through the same validator and approval path.
- [ ] Complete or reuse database-backed writer leadership and aggregate simulator request limiting. Snapshot queries and writer retries share the controlled client path. API/intel replicas do not instantiate their own simulator writers.
- [ ] Reject unsafe/stale/mixed snapshots; preserve human review for consequential decisions. Carry human-edited actions as human decisions rather than PPO rollout data.
- [ ] Add 64–128 common-random-number outcome projections for the chosen plan, baseline and WAIT. Identify the shared forecast horizon/follow-up policy in the response. Probability estimates must be labeled conditional and separately calibrated.
- [ ] Run relevant Go tests with race detection and disposable DB/simulator integration. Kill intel, corrupt the model and restart the writer during an ambiguous POST; assert fallback plus no duplicates. Automatic RL activation requires task 6 promotion success.

## Task 9: Operator evidence, latency and rollback

**Files:** Extend the actual recommendation/history/status components once the frontend is present, existing metrics/dashboard definitions, `evidence/rl/report.md`, and README. Resolve frontend filenames during execution; no frontend implementation exists at this plan's snapshot, so no speculative framework layout is introduced here.

- [ ] Show policy version/mode, data age, selected strategy, shipments, binding constraints, baseline alternative, conditional impact estimate and review/expiry status. Do not label softmax output as confidence.
- [ ] Add low-cardinality policy latency, fallback reason, model mismatch, invalid proposal, WAIT and override metrics. Keep per-decision identifiers in logs, not metric labels.
- [ ] Measure whole planner+actor p50/p95/p99 on representative snapshots, targeting p95 below 100 ms. Separately report explanation/Monte Carlo latency; never describe the whole decision as 10 ms merely because its matrix multiplication is fast.
- [ ] Demonstrate inference failure -> greedy, stale state -> blocked automatic execution, rejected incompatible model -> previous model retained, and deliberate model rollback -> new decisions use the prior artifact without replaying accepted work.
- [ ] Run the existing application load test with RL enabled and verify simulator aggregate concurrency remains capped. Include CPU/memory, throughput, error rate and a named bottleneck in the report.
- [ ] Rehearse a paused held-out crisis with baseline and RL using the same event script; report actual service/loss/request outcomes. Include an unexpected event and subsequent fallback demonstration. Record a backup.
- [ ] Finish with fresh-clone compose verification, versioned artifacts, setup/training/evaluation commands, evidence links and a simulation-only banner. Report gates still unmet; never invent improvement numbers to complete the demo.

## Twenty-four-hour compute runbook

Run this only after tasks 1–4 are verified. Implementation and simulator-model debugging can take additional time.

| Time | Action | Stop/continue decision |
|---|---|---|
| 0–2 h | Recheck parity, baseline and throughput on actual training machine | Stop long jobs if parity/accounting fails |
| 2–5 h | 200k pilots and small validation sweep | Freeze at most two configurations |
| 5–16 h | 3–5 independent training seeds | Preserve at least 25% overall verification budget; reduce sweep breadth if slow |
| 16–20 h | Frozen evaluation and ablations | Select using validation, open test once; mark unsuccessful models shadow-only |
| 20–23 h | Official image, export parity and operational failure checks | Reject promotion on any unsafe or unsupported outcome |
| 23–24 h | Package report/checkpoint and rehearse | No test-driven hyperparameter changes |

## Completion checklist

- [ ] Design and executable task interfaces are agreed and current relative to concurrent backend work.
- [ ] Official and offline transitions agree on boundary fixtures.
- [ ] Candidate constraints and observation leakage checks pass.
- [ ] Training hardware, seeds, versions, splits and failed runs are recorded.
- [ ] Strong baselines use the same information and safety layer.
- [ ] Frozen held-out and official-image comparisons support the precise stated benefit.
- [ ] Python/Go actor decisions match; fallback, expiry, duplicate prevention and reset recovery pass.
- [ ] Operator impact estimates are identified as estimates and not policy confidence.
- [ ] One-day compute results, operational latency and limits are documented.
- [ ] RL remains shadow-only if promotion evidence is insufficient.

Planning self-review: all seventeen design sections map to the nine tasks; the five review-focus cases have explicit owning checks; no experiment, training run or simulator verification is represented as already completed.
