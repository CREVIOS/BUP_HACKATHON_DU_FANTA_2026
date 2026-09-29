# Simulator reverse audit — 2026-09-29

> Historical audit snapshot, before commits `41a9c8a` and `a81e90c`. Exact manifest import, region-to-station conversion, and four-scenario differential parity were subsequently implemented. The statements about missing training features below describe the audit-time code, not the current branch. See [current implementation mathematics and limits](RL_MATH_AND_DECISIONS.md) and `evidence/rl/` for subsequent verification. Live deployment gates remain open.

## Verdict

The source in `/Users/asif/Desktop/fuel-simulator-reverse` is a faithful copy of the locally available official image's Python source and scenarios. It is useful as an executable reference, but it is not a complete standalone distribution, and the guide contains material inaccuracies. The current RL environment has demonstrated parity for one baseline-plus-injected-crisis trajectory, not for all bundled scenarios or API failure modes.

This was an audit, not a fix: no reverse-source, official-image, deployed application, training-code, or Supabase changes were made. Only disposable local instances, diagnostic scripts, and this report were created. Do not change the judging simulator to compensate for its behavior; handle it in the participant client and training contract.

## Evidence and coverage

- Compared all 10 Python source files and all 4 scenario YAML files against the previously extracted official image: **14/14 byte-identical**. This establishes identity with the local image, not with an independently verified future registry version.
- Local image ID: `sha256:7067050693f49d377d91ca91f2faa6e63f673f69a69429d4693e78e9c0598e92`.
- Executed the reverse source mounted read-only into the official runtime, with loopback-only ports and disposable SQLite storage.
- **62 contract probes confirmed their expected observations**, including normal behavior and reproductions of defects. This is not a claim that 62 requirements passed.
- Covered REST discovery, input validation, idempotency, cancellation, depot dispatch, allocation lifecycle, station overflow, all six event types, all five fault types, SSE, deterministic replay, run/pause/toggle/reset, and non-default tick reset behavior.
- All four supplied YAML scenarios completed **576 ticks each**, no allocations, with **6,912 demand rows per scenario**, bounded inventories, and all preloaded events resolved.
- The RL shared Go planner plus Python world completed a separate **576-tick HTTP differential replay** using baseline supplies and five injected crises. Every station/depot inventory matched exactly each tick; aggregate served/unmet/failure metrics matched.
- Five existing Python world unit tests passed again.
- Browser inspection showed the admin dashboard rendering and reporting API connected, paused, tick 0, and the expected resource counts. Controls were exercised through HTTP, not individually clicked in the browser.
- Read the complete 16-page integration guide; visually checked the page containing event/filter semantics.

Artifacts: [contract results](evidence/simulator-reverse/contract-results.json), [contract probes](evidence/simulator-reverse/contract_probe.py), [scenario probes](evidence/simulator-reverse/scenario_probe.py), [replay result](evidence/simulator-reverse/replay-576.json).

## Highest-priority findings

### 1. Crisis scenarios have fewer supplies than the guide and current training assume

| Scenario | Seed | Supply arrivals | Last planned arrival before event changes |
|---|---:|---:|---:|
| baseline | 12345 | 22 | 212 |
| demand_spike | 12345 | 4 | 20 |
| supply_disruption | 12345 | 4 | 20 |
| final_combined | 9001 | 4 | 20 |

The guide says all scenarios share 22 arrivals and differ only in seed/events. The actual YAML files do not. Current `training/world.py:18` constructs 22 supplies and `scenario()` always begins with that baseline. Consequently a successful injected-crisis replay is **not** a replay of `final_combined.yaml`.

The standard HTTP app is hardwired to `baseline.yaml`; the other files are not selectable at runtime. That makes 22 arrivals correct for the published default runtime, but does not establish generalization to the supplied alternate scenarios. There is no evidence here that judges will switch files.

Required RL follow-up: import exact scenario manifests, identify which configuration is being scored, evaluate both supply regimes, and label results by configuration. Do not claim alternate-scenario parity from the current training run.

### 2. Allocation acceptance does not reserve station headroom for inbound shipments

`src/app/main.py:161` checks current station inventory plus only the new request. It ignores existing pending/in-transit shipments. Two 6,000 L diesel orders to Mirpur were accepted on the same tick; only **6,118.493 L of the 12,000 L** was ultimately received. The rest was clipped at arrival (`engine.py:94`).

Depot inventory is deducted at creation. A route disruption activated before departure changes the order to FAILED without refund (`engine.py:88`). Both behaviors were reproduced.

Client/RL consequence: maintain a shared reservation ledger across all planned shipments, account for arrivals, mask departure-time route failures, and track fuel loss separately. API acceptance alone does not prove a safe action. The current candidate planner already reserves inbound headroom; that protection must survive deployment integration.

### 3. Region-scoped events need explicit conversion in the RL boundary

The simulator applies demand spikes to the union of matching station IDs and region IDs (`engine.py:32`). HTTP probing confirmed a Dhaka-only spike changes multipliers to `[2,2,1,1]`. Both bundled demand-spike scenarios use region filters.

The current RL event representation has `Stations` but no `Regions`; the world applies a spike to all stations when `Stations` is empty. There is no exact YAML-to-RL scenario adapter in the current training code. A region-only event cannot be passed through without converting region membership to station indices. Current station-index-based randomized training avoids this input but does not test the missing conversion.

### 4. Overlapping disruptions can clear a route too early

`engine.py:60` restores AVAILABLE whenever an individual disruption resolves, without considering another active event on the same route. Reproduced with two tick-0 disruptions of duration 1 and 5: after two steps, the route was AVAILABLE while the longer event remained ACTIVE. Station/depot restoration uses the same pattern; those overlapping variants were source-reviewed, not separately reproduced.

The participant must model actual authoritative statuses and test overlaps; do not assume idealized event composition.

### 5. Untyped event parameters can crash the tick loop

`schemas.py:18` accepts an arbitrary parameter dictionary. A demand spike with `multiplier=0` is accepted (201), then resolution divides by zero (`engine.py:67`) and `/admin/step` returns 500. Reproduced on the disposable instance and reset afterward.

Negative delay/shortfall values and invalid entity IDs likewise lack semantic validation at this boundary (source finding, not an exhaustive fuzz result). Validate any self-test/organizer inputs your application generates. Do not let a liveness response alone imply simulation progress: `/v1/health` can still report OK while background ticks repeatedly fail.

## Other verified semantics and guide discrepancies

| Area | Actual behavior | Integration consequence |
|---|---|---|
| Tick pipeline | Start events → supply → departures → arrivals → demand → resolve → increment clock | Public tick T processes logical T; an order created at 0 with lead 2 arrives during processing tick 2, visible at public tick 3. |
| Event duration | `end=start+duration`; resolution after demand at end tick | Duration 1 affects two ticks when started on time. Use inclusive endpoints. |
| Empty filters | Empty route/station/depot lists affect no entities for disruption/outage/constraint | Guide's blanket empty-means-all statement is false. Demand-spike and supply filters do use empty-as-all. |
| Depot constraint | Changes label to CONSTRAINED; dispatch remains 12,000/11,000 and orders remain eligible | UI hint about stricter capacity is inaccurate. Do not invent a capacity reduction. |
| Shipment delay | Only SCHEDULED supplies are delayed | A second delay does not further delay an already DELAYED supply. |
| Supply shortfall | Scales both SCHEDULED and DELAYED supplies | Persistent change, not restored at event resolution. |
| Outage | Demand continues, all unmet; arrival processing does not check outage | Service loss can be unavoidable; new allocations are rejected while outage is visible. |
| Idempotent replay | Same key/body returns **201** with existing allocation | Guide's status cheat sheet says 200; section 5 correctly says 201. Cancelled keys remain occupied. |
| Metrics | Allocation liters count nominal IN_TRANSIT + ARRIVED quantities | Not actual delivered fuel; clipping is not exposed as a top-level metric. |
| SSE transitions | Creation/cancellation publish allocation changes; engine departures/arrivals/failures do not | Contrary to guide's event table, periodic REST reconciliation is required. Probe observed one creation notification plus three tick notifications, no arrival notification. |
| SSE disconnect fault | Rejects new stream connections with 503; existing streams keep receiving | UI hint that existing clients are dropped is inaccurate. |
| Stale fault | Adds header but does not return an older snapshot; header also applies to SSE | Guide's SSE exception is false. Test genuinely stale snapshots separately if needed. |
| Fault bypass | `/admin/*` and `/v1/health` bypass faults | Health is not participant-data availability. |
| Non-default clock reset | Startup respected TICK_MINUTES=30; `/admin/reset` reverted it to 15 | Reset recreates the instance with hardcoded 15 and skips startup's override. |
| Demand scaling | Source always divides daily demand by 96 even for other tick sizes | Non-15-minute settings change physical demand-per-day semantics. Current Go planner explicitly rejects non-15-minute snapshots. |
| Default supply horizon | Last baseline arrival is tick 212 | “Recurring” supplies are a finite list, not an indefinitely recurring generator. Long-horizon policies must handle depletion. |

## Runtime/package and operational concerns

- `src/requirements.freeze.txt` is **0 bytes**. No Dockerfile, compose file, test suite, or startup README is included in this extracted folder. It works with the official image's dependencies, not as a self-contained reproducible Python install.
- Initial audit-container startup failed because the temporary data mount was not writable by the image's non-root user. Setting the disposable tmpfs mode to 1777 resolved this; it was test setup, not a reverse-source defect.
- No authentication protects admin controls. This is documented as a local single-tenant simulator. Existing application containers were observed bound on all interfaces, including simulator port 8000. Whether a host firewall makes it externally reachable was not tested. Prefer loopback/private container networking; do not expose these admin controls publicly.
- Source audit: unbounded demand/audit/allocation growth; several full-list endpoints; SSE has no replay ID; a full subscriber queue is removed from publication without closing the generator, so keepalives can continue without updates. Stress/backpressure behavior was not dynamically tested.
- Source audit: `/admin/audit` clamps only the upper limit, unlike its documented lower bound. This is a lower-priority diagnostic endpoint issue.
- Concurrency, process crashes during transactions, restart persistence, simultaneous allocation races, and multi-worker behavior were not tested. Do not treat this audit as load/security certification.

## Results: what they do and do not prove

Differential replay: 576 ticks, 5,285 greedy shipment requests, served **515,014.153 L**, unmet **47,521.616 L**, service **91.5522%**, zero allocation failures, zero observed lost fuel, maximum inventory difference **0.0 L**. This is a parity test, **not** trained-policy performance or evidence of an optimal baseline.

Independent exact-YAML no-allocation smoke tests:

| Scenario | Served L | Unmet L | Service |
|---|---:|---:|---:|
| baseline | 85,900 | 472,677.012 | 15.3784% |
| demand_spike | 85,900 | 475,557.796 | 15.2995% |
| final_combined | 85,900 | 476,306.533 | 15.2791% |
| supply_disruption | 85,900 | 472,677.012 | 15.3784% |

These smoke runs prove successful engine execution and checked invariants for these trajectories, not policy performance or exact RL parity for each YAML.

Fresh server status during audit: the warm-start run finished and W&B reported sync of 5 run files and 3 artifact files at https://wandb.ai/eenlp/BUP/runs/4uz4ztdd. Its logged final validation service level was **79.86%** on its own synthetic validation configuration. This number is not comparable to the 91.55% reference replay above and does not establish SOTA or a baseline win.

## Recommended next implementation order

1. Exact manifest import and region-to-station event conversion in the RL adapter, keeping simulator source unchanged.
2. Differential fixtures covering every named scenario and edge case, with identical seed/actions, intermediate statuses, per-tick demand, and inventories. Keep faults/partial HTTP submissions in a separate client-integration suite.
3. Held-out paired evaluations of the learned policy versus tuned feasible baselines, across both supply regimes, identical horizons, multiple training seeds, and confidence intervals.
4. Deployment tests for idempotent retries, partial batches, fresh REST snapshots, reset epochs, outbox reconciliation, fallback policy, and stale/disconnected streams.

Do not spend the remaining GPU budget or promote a model on the assumption that all-scenario fidelity is already solved.

## Reproduction notes

The contract probe is intentionally hardcoded to `127.0.0.1:18013` and expects a **fresh disposable instance initially configured with TICK_MINUTES=30**. It resets that instance repeatedly. Never point it at a shared simulator.

The scenario probe runs with `DATABASE_URL=sqlite://` in its own process, imports the supplied source, and does not mutate the HTTP instance database. The differential replay used the isolated RL checkout at `/private/tmp/fuelops-rl.4AMWyp/repo` and `python3 -m training.reference --url http://127.0.0.1:18012 --allow-reset --horizon 576 --policy greedy` plus an output path.

Cleanup verified: all three audit-created containers are stopped. Their disposable tmpfs databases were discarded; saved test results remain in this report and its evidence directory. Existing simulator/application containers were not stopped or reset.
