# Critical verdict

Three facts dominate the challenge:

1. The published source hard-wires `/app/scenarios/baseline.yaml`; `final_combined.yaml` cannot be selected by an environment variable or API. Judges running the published image unchanged are testing **baseline only**. `simsrc/app/config.py:4-25`, `simsrc/app/main.py:55-66`
2. A carefully buffered client can achieve `service_level = 1.0` through the crisis window and through at least 96 default ticks in both baseline and a hypothetical final-combined build. Dispatch and route capacities are not the limiting resources over that horizon.
3. The dangerous mechanics are undocumented shipment loss: a route failure destroys the depot-deducted fuel, and station overflow is silently discarded while the allocation is still marked `ARRIVED`. `simsrc/app/main.py:152-166`, `simsrc/app/engine.py:88-97`

## 1. Source truth versus guide

### Scenario and clock

| Topic | Actual source behavior and consequence |
|---|---|
| Active scenario | `SCENARIO_FILE` always resolves to `baseline.yaml`; all reset, startup, background, and manual-step paths use that constant. There is no scenario environment setting. To judge `final_combined`, organizers must rebuild the image or replace the file at the baseline path. `simsrc/app/config.py:4-25`, `simsrc/app/main.py:55-66`, `simsrc/app/main.py:206-211` |
| Supply schedules | The guide says all scenarios share 22 arrivals. Only baseline does. `demand_spike`, `supply_disruption`, and `final_combined` contain only four arrivals. `guide.txt:731-735`, `simsrc/scenarios/baseline.yaml:74-100`, `simsrc/scenarios/demand_spike.yaml:146-166`, `simsrc/scenarios/supply_disruption.yaml:146-166`, `simsrc/scenarios/final_combined.yaml:146-166` |
| No terminal tick | No scenario contains a duration and the runner continues indefinitely. Therefore there is no single scenario-wide service-level upper bound without a judging horizon. `simsrc/app/scenario.py:16-19`, `simsrc/app/main.py:44-58` |
| Tick rate | The loop sleeps first, then executes a synchronous tick. Actual period is `sleep + YAML load/validation + DB work`, so `SIMULATION_SPEED=8` is an upper target, not a guaranteed 8 Hz. Sleep is clamped to 50 ms–10 s, giving a hard maximum near 20 ticks/s. `simsrc/app/main.py:44-55`, `simsrc/app/config.py:31-40` |
| Tick minutes | Demand always uses `daily_liters / 96`, even if `TICK_MINUTES` is changed. Changing from 15 minutes changes the hour-of-day progression but not liters per tick, so daily consumption becomes wrong. `simsrc/app/engine.py:99-109` |
| Reset bug | Startup overwrites `tick_minutes` from the environment, but a later `/admin/reset` recreates it as 15 and does not reapply the environment setting. `simsrc/app/main.py:68-74`, `simsrc/app/scenario.py:59-63` |
| Start-mode persistence | `SIMULATOR_START_MODE=running` forces running, but `paused` does not force a persisted running database back to paused. `simsrc/app/main.py:66-74` |
| Time format | SQLite does not reliably preserve timezone metadata for `DateTime(timezone=True)`; serialized `sim_time` can lack the guide’s `+00:00`. Clients should parse both aware and naive ISO timestamps. `simsrc/app/models.py:12-15`, `simsrc/app/main.py:36-42` |

### Exact tick pipeline

For logical tick `T`, the engine performs:

1. Start all scheduled events with `start_tick <= T`.
2. Process depot supply arrivals.
3. Depart pending allocations.
4. Deliver in-transit allocations.
5. Generate and consume station demand.
6. Resolve events with `end_tick <= T`.
7. Write audit, increment tick to `T+1`, advance time, commit.
8. Publish only `simulation.tick`.

`simsrc/app/engine.py:117-142`, `simsrc/app/main.py:53-57`

Consequences:

- Supply and shipment arrivals are usable before demand on their arrival tick.
- A demand spike, outage, disruption, or constraint takes effect before all other work at its start tick.
- Resolution happens after demand and departures. An event with `end_tick = start_tick + duration_ticks` affects both endpoints: **`duration_ticks + 1` engine passes**.
- The final spike in `final_combined` therefore affects demand on ticks 8–24 inclusive, not 8–23. The Gazipur–Mirpur route is disrupted for departures on ticks 14–24 inclusive and becomes usable from tick 25. `simsrc/scenarios/final_combined.yaml:167-190`, `simsrc/app/engine.py:25-28`, `simsrc/app/engine.py:60-80`
- Every preloaded event is visible as `SCHEDULED` from tick 0 through `/v1/events`, providing legitimate lookahead. `simsrc/app/scenario.py:76-77`

### Allocation acceptance, departure and delivery

- Depot fuel is deducted immediately when `POST /v1/allocations` commits, not on departure. `simsrc/app/main.py:152-166`
- A normal allocation created while the instance reports tick `T` departs on the next engine pass while the engine is still processing logical tick `T`; thus `departure_tick` is normally equal to `created_tick`, not `created_tick + 1`. `simsrc/app/engine.py:88-92`
- Expected arrival is `departure_tick + route.transit_ticks`; delivery happens before demand on that logical tick. `simsrc/app/engine.py:92-97`
- Departure checks only the route. Depot constraint or station outage beginning after acceptance does not stop departure. Fuel can arrive at an `OUTAGE` station, although its demand remains completely unmet while the outage lasts. `simsrc/app/engine.py:88-97`, `simsrc/app/engine.py:110-114`
- The only normal cause of `FAILED` is a pending allocation encountering a non-available route at departure. `simsrc/app/engine.py:89-92`
- A failed allocation is **not refunded**, produces no `allocation.failed` audit record, and emits no SSE status event. The fuel disappears from the useful system. `simsrc/app/main.py:163-166`, `simsrc/app/engine.py:88-92`
- Only pending cancellation refunds depot inventory. `simsrc/app/main.py:169-174`

A particularly dangerous boundary is an allocation posted after tick 13 completes but before tick 14 starts. The route may still report `AVAILABLE`, so the POST succeeds; tick 14 then activates the disruption before departures and marks it failed.

### Capacity checks

- Route `max_shipment` is per allocation, not a per-route-per-tick aggregate. Multiple allocations may use the same route. `simsrc/app/main.py:150-151`
- Depot dispatch usage counts only allocations:

  ```text
  source depot matches
  AND created_tick == current instance tick
  AND status is PENDING or IN_TRANSIT
  ```

  Older in-transit allocations do not consume today’s dispatch capacity. This is a per-creation-tick acceptance cap, not a real in-flight capacity. `simsrc/app/main.py:154-160`

- Cancelled or failed allocations no longer count, potentially freeing capacity within the same logical tick.
- `CONSTRAINED` depots retain their complete dispatch capacity. The status is cosmetic: POST explicitly accepts both `OPEN` and `CONSTRAINED`, and no capacity multiplier exists. This contradicts the dashboard claim that capacity becomes stricter. `simsrc/app/main.py:148-160`, `simsrc/app/engine.py:46-49`, `simsrc/app/main.py:697-703`
- Destination capacity validation considers only current on-hand station inventory:

  ```text
  station.inventory[fuel] + new quantity <= capacity
  ```

  It ignores all pending and in-transit shipments. `simsrc/app/main.py:161-162`

- At arrival, excess over then-current station room is silently discarded. The allocation is nevertheless marked `ARRIVED` for its full requested quantity. `simsrc/app/engine.py:94-97`
- `/v1/metrics.allocation_liters` sums full allocation quantities, including the portion discarded at arrival. It is not a received-liters metric. `simsrc/app/main.py:122-129`
- A supply arrival is similarly clipped to depot capacity, marked `ARRIVED`, and any excess is lost. Make depot headroom before known supply ticks. `simsrc/app/engine.py:82-86`

### Supply delays and shortfalls

- Events start before supply processing, so a delay or shortfall scheduled for a supply’s original arrival tick can modify it before arrival. `simsrc/app/engine.py:133-135`
- `shipment_delay` adds ticks only to supplies whose status is exactly `SCHEDULED`, then changes them to `DELAYED`. A second shipment-delay event will not delay an already-delayed supply. `simsrc/app/engine.py:50-54`
- `process_supply` accepts both `SCHEDULED` and `DELAYED`, using the mutated `planned_tick`. `simsrc/app/engine.py:82-86`
- `supply_shortfall` applies to both scheduled and delayed supplies and permanently multiplies quantity. Repeated shortfalls compound. `simsrc/app/engine.py:55-58`
- Neither delay nor shortfall is undone when its event resolves.
- Event parameters are an unvalidated arbitrary dictionary. Negative delays, factors, multipliers, or out-of-range fault rates are not rejected at schema level. Judges should use valid parameters. `simsrc/app/schemas.py:14-22`

### Event scope bugs

The guide states that empty entity lists mean “all.” That is only partially true. `guide.txt:552-553`

- `demand_spike`: empty station and region filters correctly mean all.
- `shipment_delay` and `supply_shortfall`: empty depot/fuel filters correctly mean all.
- `route_disruption`, `station_outage`, and `depot_constraint`: empty or absent ID lists iterate over nothing and affect no entities. `simsrc/app/engine.py:32-58`

Overlapping state-setting events are also unsafe. When the first overlapping route disruption/outage/constraint resolves, it unconditionally restores `AVAILABLE`/`OPEN`, even if another event affecting the same entity remains active. `simsrc/app/engine.py:68-80`

### Demand, jitter and rounding

For every station and fuel at tick `T`:

```text
daily_liters / 96
× hour_factor(current pre-increment sim_time.hour)
× region.demand_factor
× station.demand_multiplier
× (1 + uniform(-noise, noise))
```

`simsrc/app/engine.py:99-114`

The jitter generator is recreated independently for every `(seed, tick, station, fuel)` using:

```text
SHA256(f"{seed}:{tick}:{station}:demand:{fuel}")[:8]
→ big-endian integer
→ random.Random(integer).uniform(...)
```

`simsrc/app/engine.py:14-17`, `simsrc/app/engine.py:106-109`

Other details:

- Tick 0 consumes demand at the scenario start time before the clock advances.
- Station outage does not eliminate demand; it forces served to zero, making all demand unmet. `simsrc/app/engine.py:110-114`
- Actions and inventory do not affect future demand generation.
- Demand, served, unmet, depot inventory and station inventory are independently rounded to three decimals. Allocation quantity itself is stored unrounded. `simsrc/app/engine.py:85-86`, `simsrc/app/engine.py:113-115`, `simsrc/app/main.py:163-164`
- Python’s normal floating-point/rounding behavior applies. Tiny sub-milliliter allocations can be distorted by inventory rounding.
- Metrics sum rounded `served_liters` and `unmet_liters`, then round service level to six decimals. `simsrc/app/main.py:122-129`

### Idempotency

The actual behavior is:

- New request: HTTP 201.
- Same key and exactly equal body, including `float(existing.quantity) == float(request.quantity)`: HTTP **201 again**, because the route decorator fixes status 201.
- Same key with a changed field: 409.
- Cancellation does not release the unique key.
- Concurrent identical first submissions can race between the application precheck and the database unique constraint; the resulting integrity error is not handled as an idempotent replay. `simsrc/app/main.py:131-165`, `simsrc/app/models.py:74-89`

The guide contradicts itself: §5.4 says replay is 201, while the status table and checklist mention 200. Source truth is 201. `guide.txt:391-395`, `guide.txt:745-751`, `guide.txt:824-825`

### SSE is much weaker than documented

The guide promises allocation events for creation, departure, arrival, failure and cancellation, plus depot inventory changes. `guide.txt:425-435`

Source actually publishes:

- `simulation.tick` after a successful committed tick.
- `allocation.status_changed` only on allocation creation and cancellation.
- `inventory.updated` only for depot deduction/refund on creation/cancellation.
- `simulator.notice` on reset or runner exception.

Departures, arrivals, failures, supply arrivals and station inventory changes publish nothing. `simsrc/app/main.py:53-57`, `simsrc/app/main.py:165-174`, `simsrc/app/main.py:206-211`

Queue behavior is also awkward:

- Each subscriber has a 200-item queue.
- On overflow, its queue is removed from `bus.clients`.
- The generator is not closed or sent a sentinel. It drains what remains and then continues returning 15-second keepalives forever, receiving no new events.
- There is an unused 100-event history, but no replay or event IDs. `simsrc/app/bus.py:4-21`, `simsrc/app/main.py:176-188`

At 8 ticks/s, 200 tick events are only 25 seconds of backlog. A client must detect “keepalives continue but `/v1/instance.tick` advances and no `simulation.tick` arrives,” then reconnect and fully resync.

An active `stream_disconnect` fault only rejects a new `/v1/stream` connection. It does not terminate already-connected streams. `simsrc/app/main.py:176-188`

### Fault semantics and order

For every non-admin, non-health request:

1. Query all active faults with no explicit ordering.
2. For each returned row:
   - latency sleeps;
   - unavailable returns 503 immediately;
   - error-rate may return 503 using global, unseeded randomness.
3. Run the endpoint if not rejected.
4. On every `/v1/*` GET, query faults again and add the stale header if active.

`simsrc/app/main.py:21-34`, `simsrc/app/faults.py:8-27`

Consequences:

- Multiple latency faults add together until an earlier 503 fault short-circuits.
- Relative behavior of multiple fault rows relies on unspecified database row order.
- `error_rate` outcomes are not deterministic from the scenario seed.
- `stale_data` does not actually return an old snapshot; it only labels the otherwise-current response.
- Contrary to the guide’s claim that the SSE stream “does not” carry the stale signal, the middleware condition includes `/v1/stream`, so its opening response can receive `X-Simulator-Stale: true`. `guide.txt:446-450`, `simsrc/app/main.py:29-32`
- `unavailable` and `error_rate` use `{"error": ...}`. A pure `stream_disconnect` reaches the stream handler and uses `{"detail": ...}`. If faults overlap, the middleware can win first. `simsrc/app/faults.py:22-26`, `simsrc/app/main.py:176-180`
- Fault expiry is wall-clock based and is applied lazily when `active_faults()` is called. `simsrc/app/faults.py:8-17`
- `/v1/health` can remain healthy while every useful endpoint returns 503. `simsrc/app/main.py:21-24`, `simsrc/app/main.py:85-88`

### REST/database surprises

- `/v1/demand-history` is newest-first. With no station filter, `limit=200` covers only about 16⅔ ticks because there are 12 rows/tick; with a station filter it covers about 66⅔ ticks because there are three fuels/tick. `simsrc/app/main.py:116-120`
- `/v1/allocations` is unbounded and newest-first. `simsrc/app/main.py:114-115`
- Demand history grows without limit and has no station/tick index. Metrics repeatedly scan the full table. `simsrc/app/models.py:63-72`, `simsrc/app/main.py:122-129`
- `/admin/audit` clamps only the maximum, despite the guide claiming `[1,1000]`. `simsrc/app/main.py:221-222`, `guide.txt:614-616`
- Every application process starts its own background runner. Launching Uvicorn with multiple workers would create multiple tick loops against one database. `simsrc/app/main.py:44-76`

## 2. Is future demand exactly predictable?

Yes—conditional on knowing:

- the scenario seed;
- the demand profiles;
- `TICK_MINUTES`;
- the current tick/time;
- scheduled and future injected demand-spike events.

The seed is public in `/v1/instance`, most formula inputs are public in REST/the guide, and preloaded events are public from tick 0. The source’s SHA-256 seeding makes each future jitter value independently reproducible. Inventory and allocation choices do not change generated demand.

Unknown future organizer-injected events remain unpredictable until exposed, and exact reproduction depends on matching Python’s `random.Random` behavior.

### Recommendation

Use a source-independent forecast from `/v1/demand-history` as the production decision input, with published hour, profile, region and current multiplier features. Treat the exact seed/RNG model as:

- a test oracle;
- a confidence/reference forecast;
- an optional competition mode only if organizers confirm source-based exact prediction is allowed.

Exact demand reproduction is technically defensible because the guide explicitly promises determinism “including per-tick demand jitter.” `guide.txt:112-120` But relying on the unpublished hash/RNG construction is brittle and can look like image reverse-engineering rather than forecasting. Do not hard-code seed 12345, seed 9001, a future demand table, or scenario-specific shipment decisions.

## 3. Optimal allocation strategy and upper bounds

### Horizon problem

Because supply is finite and demand runs forever, `1.0` cannot be maintained indefinitely. Eventually service level tends toward zero. The score needs a specified number of processed ticks.

Using the exact source demand formula, default 15-minute ticks, rounded observations, and careful operation with no fuel loss:

| Scenario | Fuel available system-wide, D/P/O | Exact demand through 96 ticks | Resource upper bound at 96 ticks |
|---|---:|---:|---:|
| baseline | 251,000 / 187,000 / 115,900 L | 40,886.4 / 34,233.7 / 17,933.9 L | 1.0 |
| final_combined | 185,000 / 133,000 / 76,900 L | 42,557.2 / 35,522.0 / 18,404.3 L | 1.0 |

Resources derive from station inventory, depot inventory and all scenario supplies. `simsrc/scenarios/baseline.yaml:12-100`, `simsrc/scenarios/final_combined.yaml:16-166`

The exact total demand through 96 ticks is approximately:

- Baseline: 93,054.0 L.
- Final combined: 96,483.5 L.

Peak aggregate demand in the first 96 ticks is about 1,441 L/tick, versus 23,000 L/tick combined depot dispatch capacity. Thus steady-state dispatch capacity is over 16× peak demand.

For a horizon of `H` processed ticks, a fuel-conservation upper bound is:

```text
sum_fuel min(cumulative_demand[fuel, H], total_available[fuel])
----------------------------------------------------------------
                 total cumulative demand[H]
```

Under that bound:

- Baseline first becomes resource-limited by petrol while processing zero-based tick 527, i.e. the 528th demand tick. At 528 processed ticks the bound is about `0.999412`.
- Final combined first becomes petrol-limited while processing tick 367. At 368 processed ticks the bound is about `0.999134`.
- At 384 processed ticks, baseline remains resource-feasible at `1.0`; final combined is capped around `0.986441`.
- At 624 processed ticks, the fuel-total bounds are approximately `0.918855` baseline and `0.651170` final combined.

These are conservation upper bounds; overflow, failed allocations, stranded inventory or supply clipping lower them.

### Is 1.0 achievable?

Yes, for both the complete crisis window and a normal 96-tick evaluation, provided no station-outage event is injected.

The final-combined spike and disruption resolve after processing tick 24. Exact total demand through ticks 0–24 is only about 19,961.7 L, versus very large initial station inventories and depot reserves. The delayed Gazipur supplies are not required to prevent an early stockout.

A station outage makes `1.0` mathematically impossible because demand continues while served is forced to zero. `simsrc/app/engine.py:110-114`

### Best practical policy

Use a single-writer, event-aware inventory-position policy:

```text
inventory position
= on-hand
+ usable pending/in-transit arrivals
- forecast demand until each arrival
```

For each station/fuel:

- Reorder before projected inventory reaches the demand required over:
  - route transit;
  - API fault/recovery time;
  - one additional decision-cycle margin.
- Send relatively large, infrequent shipments. There is no value in 12 per-fuel per-station POSTs every tick.
- Never count a shipment whose route will be disrupted at its departure tick.
- Include every pending/in-transit allocation in projected station inventory even though the server does not.
- Limit quantity to projected room at arrival, not merely the more permissive server check.
- Leave depot headroom ahead of known supply ticks.
- Use shortest direct routes normally:
  - Gazipur → Mirpur/Tongi;
  - Patiya → Karnaphuli/Cox’s Bazar.
- During Gazipur–Mirpur disruption, pre-position Mirpur before tick 14 or use Patiya → Mirpur. Gazipur → Karnaphuli provides the balancing route in the opposite direction.
- Reserve cross-region routes for disruption handling and depot/fuel balancing; their four-tick transit is the real penalty.

### Binding constraints

- **Long horizon:** finite petrol first, followed by diesel/octane.
- **Fault windows:** station capacity determines how much safety stock can be held.
- **Route disruption:** lead time and fuel-loss risk, not nominal route throughput.
- **Station outage:** unavoidable unmet demand.
- **Transit time:** requires proactive decisions.
- **Dispatch capacity:** only a startup/recovery burst constraint; not a normal steady-state bottleneck.
- **Route max shipment:** rarely binding because it is per allocation and shipments can be split.
- **Station capacity:** operationally important, but mainly to prevent overflow; initial inventories are already ample for the early event window.

## 4. Concurrency, latency and load risks

### SQLite and server execution

SQLite is configured with `check_same_thread=False`, but no WAL mode, busy timeout, explicit write lock, or retry policy is configured. `simsrc/app/db.py:8-10`

Each participant request can involve:

- a middleware database session for fault evaluation;
- a separate endpoint dependency session;
- another middleware fault query after GET handling.

`simsrc/app/main.py:21-34`, `simsrc/app/db.py:12-17`

The tick transaction writes station inventories, 12 demand rows, status changes and audit data in one commit. `simsrc/app/engine.py:131-142`

In a normal one-worker process, the background tick and async allocation handler execute synchronous SQL on the same event loop and therefore largely serialize. Risks remain from:

- synchronous GET handlers running in the thread pool;
- admin fault operations;
- multiple application workers;
- concurrent external POSTs racing at the application precheck;
- long readers delaying a SQLite commit;
- growing metrics/history scans.

An unhandled `database is locked` or unique-constraint failure becomes a 500. The background runner rolls back, emits an SSE notice and retries later without advancing the tick. `simsrc/app/main.py:51-58`

### Read/tick race

REST has no atomic snapshot or version precondition:

1. Read instance tick `T`.
2. Read stations.
3. A tick commits.
4. Read depots/allocations at `T+1`.
5. Submit a decision against a mixed snapshot.

Depot/station objects contain no snapshot tick. A robust client should read `/v1/instance` before and after its critical reads and treat a tick change as a stale snapshot, or use conservative inventory margins and accept/replan from 409 responses.

An SSE tick is a useful commit fence, but by the time the client refetches, the simulator may already be several ticks ahead.

### `SIMULATION_SPEED=8`

At 125 ms nominally:

- A sequential cycle of instance + stations + depots + routes + events + allocations + multiple POSTs cannot reliably complete every tick.
- A one-second latency fault represents roughly eight nominal ticks.
- Polling `/v1/metrics` frequently becomes increasingly expensive because it scans the full demand table.
- At eight ticks/s the simulator inserts 96 demand rows/s.

The client does not need tick-for-tick control. Station buffers and shipment sizes support decisions every few ticks if inventory-position forecasts are correct.

### amd64 image on arm64 emulation

Emulation increases YAML parsing, Python and SQLite cost. Because the runner sleeps before doing work, this normally makes simulated time run **slower than** the configured rate, not faster. Do not infer tick from wall-clock time; always use `/v1/instance.tick`.

Keep client concurrency low—roughly 2–4 outstanding requests—and use one allocation writer. Higher fan-out increases connection-pool, SQLite and event-loop pressure without improving decisions.

## 5. Client failure-handling checklist

- [ ] Maintain one authoritative allocation writer.
- [ ] Generate one deterministic key per immutable logical shipment, e.g. `scenario:seed:decision_tick:route:fuel:sequence`, under 150 characters.
- [ ] Retry timeouts, connection resets, 500s and injected 503s with the **same key and identical body**.
- [ ] Accept both 200 and 201 for forward compatibility, but expect 201 from this image.
- [ ] After an ambiguous timeout, retry the same request or find the key in `/v1/allocations`; never assume it failed.
- [ ] Never change quantity/route/fuel under an existing key.
- [ ] A `FAILED` allocation is final and unrecoverable; replan with a new key.
- [ ] Treat 404 and 422 as permanent configuration/request errors.
- [ ] On state-related 409s, refetch and replan. Do not blindly retry:
  - route/station/depot errors → wait or choose an alternative;
  - inventory/capacity errors → recompute quantity;
  - idempotency mismatch → investigate the local ledger.
- [ ] Use bounded exponential backoff with jitter for 503/timeouts; keep retry duration within station safety-stock cover.
- [ ] Circuit-break on repeated `/v1/*` failures, but use `/v1/health` only to distinguish “process alive” from “participant API usable.”
- [ ] Half-open the circuit with `/v1/instance`, not health alone.
- [ ] On `X-Simulator-Stale: true`, do not make aggressive replenishment decisions from that response. Retain the last trusted snapshot and use conservative safety stock.
- [ ] Treat SSE solely as a wake-up hint.
- [ ] Reconnect on EOF/503 with backoff, then fully refetch state.
- [ ] Add an SSE progress watchdog: reconnect if tick events stop while REST shows the simulation advancing, even if keepalives continue.
- [ ] Poll allocation state because SSE will not report departure, arrival or failure.
- [ ] Track in-transit fuel locally to prevent destination overflow.
- [ ] Inspect scheduled events, not only currently active statuses.
- [ ] Before posting, exclude routes disrupted at the allocation’s likely departure tick.
- [ ] Read tick before and after a decision snapshot; discard or conservatively adjust mixed-tick snapshots.
- [ ] Avoid frequent metrics calls and unbounded allocation-ledger growth in the hot loop.

## 6. Top 10 point-losing traps

1. **Assuming judges can select `final_combined` in the published image.** The image source selects baseline only.
2. **Trusting the guide’s 22-arrival statement for every scenario.** Final combined has only four supplies.
3. **Waiting for SSE departure/arrival/failure events.** They are never published.
4. **Ignoring inbound shipments in station capacity planning.** The server accepts overlapping shipments, then destroys overflow.
5. **Posting onto a route scheduled to disrupt on the current tick.** Acceptance can succeed, departure fails, and depot fuel is never refunded.
6. **Treating `CONSTRAINED` as reduced dispatch capacity.** It changes only the status label.
7. **Treating event end ticks as exclusive.** Events affect the end tick’s departure/demand before resolving.
8. **Retrying with a new key after a timeout—or changing the body under the old key.** The former duplicates fuel; the latter returns an idempotency mismatch.
9. **Trying to react every 125 ms with high-concurrency polling and many tiny POSTs.** It increases SQLite/load failure risk and is unnecessary given station buffers.
10. **Using a mixed-tick snapshot or assuming `created_tick + 1` departure.** Decisions can be validated at a later tick after latency, while normal departure occurs on the first engine pass for the allocation’s current logical tick.
