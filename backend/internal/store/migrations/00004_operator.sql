-- +goose Up
-- Operator workflow: richer recommendations, a FAILED outcome, alert dedup/ack, operator settings,
-- forecast tracking (prediction error) and the sim command queue (api -> ingestor; only the ingestor calls the sim).
-- Expand-only: the previous image keeps working against this schema.

ALTER TABLE recommendations
    ADD COLUMN depot_id  TEXT,
    ADD COLUMN source    TEXT NOT NULL DEFAULT 'intel' CHECK (source IN ('intel','fallback','manual')),
    ADD COLUMN verdict   TEXT CHECK (verdict IS NULL OR verdict IN ('auto','review')),
    ADD COLUMN jev_model TEXT;
ALTER TABLE recommendations DROP CONSTRAINT recommendations_status_check;
ALTER TABLE recommendations ADD CONSTRAINT recommendations_status_check
    CHECK (status IN ('PROPOSED','APPROVED','REJECTED','SUBMITTED','EXPIRED','FAILED'));
CREATE INDEX recommendations_open ON recommendations (epoch_id, status, tick DESC);

ALTER TABLE alerts
    ADD COLUMN acked_at TIMESTAMPTZ,
    ADD COLUMN acked_by TEXT;
-- At most one open alert per condition.
CREATE UNIQUE INDEX alerts_open_condition ON alerts (epoch_id, kind, subject) WHERE resolved_at IS NULL;

CREATE TABLE settings (
    id            INT              PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    auto_execute  BOOLEAN          NOT NULL DEFAULT true,   -- execute 'auto' verdicts without a human
    jev_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.8 CHECK (jev_threshold BETWEEN 0 AND 1),
    updated_by    TEXT             NOT NULL DEFAULT 'system',
    updated_at    TIMESTAMPTZ      NOT NULL DEFAULT now()
);
INSERT INTO settings (id) VALUES (1);

-- Expected demand recorded BEFORE the tick is simulated; joined with demand_observations = prediction error.
CREATE TABLE forecasts (
    epoch_id   BIGINT           NOT NULL REFERENCES sim_epochs(id),
    tick       INT              NOT NULL,
    station_id TEXT             NOT NULL,
    fuel_type  TEXT             NOT NULL,
    expected   DOUBLE PRECISION NOT NULL,
    naive      DOUBLE PRECISION,           -- last observed value: the baseline the forecast must beat
    PRIMARY KEY (epoch_id, tick, station_id, fuel_type)
);

-- Commands the api queues for the ingestor (the sole simulator client) to execute.
CREATE TABLE sim_commands (
    id           BIGSERIAL   PRIMARY KEY,
    kind         TEXT        NOT NULL CHECK (kind IN ('step','run','pause','reset','event','fault','faults_clear','cancel_allocation')),
    payload      JSONB       NOT NULL DEFAULT '{}',
    status       TEXT        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DONE','FAILED')),
    result       JSONB,
    error        TEXT,
    requested_by TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    done_at      TIMESTAMPTZ
);
CREATE INDEX sim_commands_pending ON sim_commands (id) WHERE status = 'PENDING';

-- +goose Down
DROP TABLE sim_commands;
DROP TABLE forecasts;
DROP TABLE settings;
DROP INDEX alerts_open_condition;
ALTER TABLE alerts DROP COLUMN acked_by, DROP COLUMN acked_at;
DROP INDEX recommendations_open;
ALTER TABLE recommendations DROP CONSTRAINT recommendations_status_check;
ALTER TABLE recommendations ADD CONSTRAINT recommendations_status_check
    CHECK (status IN ('PROPOSED','APPROVED','REJECTED','SUBMITTED','EXPIRED'));
ALTER TABLE recommendations DROP COLUMN jev_model, DROP COLUMN verdict, DROP COLUMN source, DROP COLUMN depot_id;
