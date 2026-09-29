-- +goose Up
-- One row per simulator "world". A new epoch starts when the tick goes backwards or the seed/scenario changes (reset).
CREATE TABLE sim_epochs (
    id               BIGSERIAL PRIMARY KEY,
    scenario_id      TEXT        NOT NULL CHECK (length(scenario_id) > 0),
    scenario_version TEXT        NOT NULL DEFAULT '',
    seed             BIGINT      NOT NULL,
    started_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tick-fenced snapshots of simulator state (REST is the source of truth).
CREATE TABLE snapshots (
    id          BIGSERIAL PRIMARY KEY,
    epoch_id    BIGINT      NOT NULL REFERENCES sim_epochs(id),
    tick        INT         NOT NULL CHECK (tick >= 0),
    sim_time    TIMESTAMPTZ NOT NULL,
    stale       BOOLEAN     NOT NULL DEFAULT false,
    payload     JSONB       NOT NULL,          -- sim.Snapshot: instance, regions, depots, stations, routes, events, allocations, supply, metrics
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX snapshots_epoch_tick ON snapshots (epoch_id, tick DESC);

-- Recommendations produced by intel (or the fallback policy).
CREATE TABLE recommendations (
    id             BIGSERIAL PRIMARY KEY,
    epoch_id       BIGINT      NOT NULL REFERENCES sim_epochs(id),
    tick           INT         NOT NULL CHECK (tick >= 0),
    station_id     TEXT        NOT NULL CHECK (length(station_id) > 0),
    fuel_type      TEXT        NOT NULL CHECK (fuel_type IN ('DIESEL','PETROL','OCTANE')),
    route_id       TEXT        NOT NULL CHECK (length(route_id) > 0),
    quantity       NUMERIC     NOT NULL CHECK (quantity > 0),
    policy_version TEXT        NOT NULL CHECK (length(policy_version) > 0),
    risk_before    DOUBLE PRECISION CHECK (risk_before  IS NULL OR (risk_before  BETWEEN 0 AND 1)),
    risk_after     DOUBLE PRECISION CHECK (risk_after   IS NULL OR (risk_after   BETWEEN 0 AND 1)),
    explanation    JSONB       NOT NULL DEFAULT '{}',  -- signals, binding constraints, alternatives
    rule_verdict   TEXT        CHECK (rule_verdict IS NULL OR rule_verdict IN ('auto','review')),
    jev_p_auto     DOUBLE PRECISION CHECK (jev_p_auto   IS NULL OR (jev_p_auto   BETWEEN 0 AND 1)), -- NULL when Jev unavailable
    status         TEXT        NOT NULL DEFAULT 'PROPOSED'
                   CHECK (status IN ('PROPOSED','APPROVED','REJECTED','SUBMITTED','EXPIRED')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- decision dedup across replicas / deployments (docs/PLAN.md §3)
    UNIQUE (epoch_id, tick, station_id, fuel_type, policy_version)
);

-- Outbox: the ONLY path to POST /v1/allocations. The exact body is stored so every retry is byte-identical.
CREATE TABLE outbox (
    id                BIGSERIAL PRIMARY KEY,
    recommendation_id BIGINT      REFERENCES recommendations(id),
    idempotency_key   TEXT        NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 150),
    body              BYTEA       NOT NULL CHECK (length(body) > 0),
    status            TEXT        NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','SENT','REJECTED','FAILED_PERMANENT')),
    attempts          INT         NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error        TEXT,
    sim_allocation_id INT         CHECK (sim_allocation_id IS NULL OR sim_allocation_id > 0),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON outbox (id) WHERE status = 'PENDING';

-- Operator decisions / audit trail.
CREATE TABLE decisions (
    id                BIGSERIAL PRIMARY KEY,
    recommendation_id BIGINT      NOT NULL REFERENCES recommendations(id),
    actor             TEXT        NOT NULL CHECK (length(actor) > 0),   -- operator username or 'auto'
    action            TEXT        NOT NULL CHECK (action IN ('APPROVE','REJECT','AUTO_EXECUTE')),
    reason            TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
    id          BIGSERIAL PRIMARY KEY,
    epoch_id    BIGINT      REFERENCES sim_epochs(id),
    tick        INT         CHECK (tick IS NULL OR tick >= 0),
    kind        TEXT        NOT NULL CHECK (length(kind) > 0),   -- stockout_risk | demand_anomaly | supply_delay | route_disruption | sim_fault ...
    severity    TEXT        NOT NULL CHECK (severity IN ('INFO','WARN','CRITICAL')),
    subject     TEXT,                   -- station/depot/route id
    detail      JSONB       NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

-- +goose Down
DROP TABLE alerts;
DROP TABLE decisions;
DROP TABLE outbox;
DROP TABLE recommendations;
DROP TABLE snapshots;
DROP TABLE sim_epochs;
