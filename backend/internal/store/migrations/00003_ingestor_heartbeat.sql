-- +goose Up
-- Last successful simulator poll. Snapshots are written only when the tick changes, so a PAUSED simulator
-- would look stale by snapshot age; health is judged by this heartbeat instead.
CREATE TABLE ingestor_heartbeat (
    id         INT         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_ok_at TIMESTAMPTZ NOT NULL,
    tick       INT         NOT NULL,
    status     TEXT        NOT NULL
);

-- +goose Down
DROP TABLE ingestor_heartbeat;
