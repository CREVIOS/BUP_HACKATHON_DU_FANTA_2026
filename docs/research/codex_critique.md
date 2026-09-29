# Verdict

**11 CORRECT, 3 INCOMPLETE, 1 WRONG.** The analysis is strong on mechanics but misses several scoring-critical edge cases and over-polls the API.

| # | Verdict | Source review |
|---|---|---|
| 1 | **CORRECT** | Pipeline order is exactly stated; departure sets arrival to `tick + transit_ticks`, and arrival precedes that tick’s demand. `simsrc/app/engine.py:88-114,117-142` |
| 2 | **CORRECT** | Events activate before departure; disrupted routes mark allocations `FAILED`. Depot fuel was already deducted at creation and failure never refunds it. Only cancelling while `PENDING` refunds. `simsrc/app/engine.py:25-29,88-92`; `simsrc/app/main.py:161-174` |
| 3 | **CORRECT** | POST validation checks only current station inventory plus this request. Arrival independently clips to remaining room and still marks the full allocation `ARRIVED`. The quoted 0/120/2400 experiment is not derivable from source, but the mechanism is. `simsrc/app/main.py:161-166`; `simsrc/app/engine.py:94-97` |
| 4 | **CORRECT** | Empty lists are wildcards only where explicit `not ids` checks exist. Route, station and depot events iterate empty lists and affect nothing, contradicting `guide.txt:552-553`. `simsrc/app/engine.py:32-58` |
| 5 | **CORRECT** | `depot_constraint` only changes status; `CONSTRAINED` is accepted exactly like `OPEN` and capacity is unchanged. `stale_data` merely adds a header after serving live data. `simsrc/app/engine.py:46-49`; `simsrc/app/main.py:29-32,148-160` |
| 6 | **CORRECT** | Engine transitions publish no SSE events. Allocation and depot updates are published only by create/cancel; tick and notice are the other publishers. Polling allocations is necessary. `simsrc/app/main.py:55-57,165-174,206-211` |
| 7 | **INCOMPLETE** | Replay does return 201 because the route decorator fixes that status. The guide is internally inconsistent: §5.4 correctly says 201, while its cheat sheet says 200. Float equality is real, but “send integers” unnecessarily sacrifices precision; persist and replay the identical canonical body instead. `simsrc/app/main.py:131-141`; `guide.txt:391-395,745-751` |
| 8 | **CORRECT** | Depot supply is silently clipped to capacity, with no deferred remainder. Because supply runs before departure, create/debit allocations before the arrival tick to make headroom. `simsrc/app/engine.py:82-92` |
| 9 | **CORRECT** | The stated SHA-256 seed construction, Python `Random`, factors and fixed `/96` divisor match source. `TICK_MINUTES` changes the clock but not per-tick base demand. `simsrc/app/engine.py:14-23,99-115` |
| 10 | **WRONG** | The cap resets by `created_tick`, and 23k versus roughly 970 L/tick shows it is not a long-run throughput bottleneck. It can still bind whenever a fill policy submits more than 12k/11k from one depot in a tick—exactly what the proposed order-up-to controller may do. The cap is across all fuels. `simsrc/app/main.py:154-160`; `simsrc/scenarios/baseline.yaml:12-24` |
| 11 | **CORRECT** | Recomputing deterministic cumulative demand gives baseline PETROL exhaustion at tick 527. The stated final figures—369/417/434—are correct **without** the spike. Including the actual spike moves them to approximately **PETROL 367, OCTANE 415, DIESEL 430**. `simsrc/app/engine.py:99-115`; `simsrc/scenarios/final_combined.yaml:121-174` |
| 12 | **INCOMPLETE** | Middleware and handler do create overlapping sessions, supporting pool starvation. But pool size 5+10, the exact concurrency threshold, “permanent” wedging and SSE connection lifetime depend on library/runtime behavior not pinned in this source. `simsrc/app/main.py:21-34,176-188`; `simsrc/app/db.py:8-17` |
| 13 | **INCOMPLETE** | `active_faults()` commits, and synchronous `tick_once()` blocks the async runner. Health and admin bypass the middleware, however, and `journal_mode=delete` plus 6.5 ticks/s are runtime observations rather than source guarantees. `simsrc/app/faults.py:8-17`; `simsrc/app/main.py:21-24,44-58` |
| 14 | **CORRECT** | Metrics repeatedly aggregate the entire growing demand table. SQLite loses timezone information, after which generic `isoformat()` emits no offset. `simsrc/app/main.py:36-42,122-129`; `simsrc/app/db.py:8-10` |
| 15 | **CORRECT** | The YAML contents and affected supplies/routes match. Effects include tick 24 because resolution occurs after departures and demand. `simsrc/scenarios/final_combined.yaml:146-190`; `simsrc/app/engine.py:117-142` |

## Important misses

- **The published application can only load `baseline.yaml`.** `final_combined.yaml` is unreachable unless the image contents/code are replaced; there is no scenario-selection environment variable. Always trust `/v1/instance.scenario_id`. `simsrc/app/config.py:4-25`
- **Event durations are off by one:** an event starting at `S` with duration `D` affects ticks `S…S+D` inclusive because resolution happens last. `simsrc/app/scenario.py:76-77`; `simsrc/app/engine.py:60-80,117-142`
- **Overlapping disruptions/outages are broken:** resolving either event unconditionally restores `AVAILABLE`/`OPEN`, even if another matching event remains active. `simsrc/app/engine.py:68-79`
- **Route is the only departure-time recheck.** Depot/station status is not rechecked, and in-transit fuel arrives even into an `OUTAGE` station. `simsrc/app/engine.py:88-97`
- **Station outage causes unavoidable unmet demand while preserving inventory.** No allocation policy can maintain 1.0 during it. `simsrc/app/engine.py:99-115`
- **Repeated shipment delays do not stack:** the first changes status to `DELAYED`; later delay events select only `SCHEDULED`. `simsrc/app/engine.py:50-58`
- **Overflow is hidden:** an allocation remains `ARRIVED` with its original quantity, and `allocation_liters` counts that full quantity—not what the station received. `simsrc/app/engine.py:94-97`; `simsrc/app/main.py:122-129`
- **SSE overflow is worse than documented:** the queue is removed from the bus, but the generator remains connected sending keepalives forever. Existing connections are also not terminated when `stream_disconnect` is injected. `simsrc/app/bus.py:4-18`; `simsrc/app/main.py:176-188`
- Exact prediction must reproduce the engine’s **three-decimal inventory rounding**, not merely its unrounded demand formula. `simsrc/app/engine.py:85-86,96-97,109-115`
- Routing is not interchangeable: Tongi is Gazipur-only and Cox’s Bazar is Patiya-only. A greedy shortest-route policy can consume fuel needed by these captive stations. `simsrc/scenarios/baseline.yaml:52-58`

## Strategy critique and replacement

The proposed controller would still lose fuel or requests through:

- independent station/fuel decisions that ignore the per-depot, all-fuel dispatch cap;
- treating all in-transit fuel alike rather than reserving capacity by arrival tick;
- filling flexible stations before reserving Gazipur fuel for Tongi and Patiya fuel for Cox’s Bazar;
- full REST resynchronization every tick, which magnifies the two-session load bug and cannot reliably finish inside 125 ms;
- ephemeral `{...}-{n}` keys that may be reused with a changed quantity after restart;
- integer-only quantities, which can strand fractional fuel.

A better minimal controller:

1. Use one serialized POST writer. Keep reads bounded and coalesce multiple SSE ticks into one control cycle.
2. Cache topology and demand parameters. Reconcile dynamic REST state periodically and after reconnect, timeout, stale response or unexpected status—not every tick.
3. Maintain time-indexed reservations per station/fuel/arrival tick. Cap each order by route maximum, depot inventory, remaining per-depot dispatch allowance, API-visible current room, and projected arrival room.
4. Check disruption only at the actual departure tick: `start_tick <= departure_tick <= end_tick`. Disruption while already in transit is irrelevant.
5. Reserve each depot’s fuel for its captive station first; use Mirpur/Karnaphuli and cross-routes to absorb the remaining balance.
6. Persist every idempotency key together with its exact three-decimal request body. A changed decision gets a new key.

## Fuel-ceiling end-game

For the exposed aggregate `service_level`, every served liter has equal value. Rationing cannot improve the final cumulative score: preserve 1.0 as long as possible, lose no fuel, and ensure all remaining fuel is consumed before the judging horizon.

Near exhaustion:

- move all depot fuel to stations early enough to clear transit;
- place surplus at high-demand, short-lead stations so it cannot remain stranded at cutoff;
- reserve enough at captive stations first;
- if fairness or minimum per-station service is separately judged, distribute the scarce remainder proportionally—source and guide define no such score.

The evaluation horizon is absent from these files, so no single final percentage can be proven. `guide.txt:16-18`

## Seeded jitter

**Exploit it.** Determinism and the seed are deliberately exposed, and the published source makes future demand exactly computable. Mirror SHA-256 seeding, Python `random.Random`, event multipliers, inclusive event endings and three-decimal inventory rounding; then reconcile against REST. Historical forecasting is only the fallback if judges change the implementation or forbid source-derived prediction.
