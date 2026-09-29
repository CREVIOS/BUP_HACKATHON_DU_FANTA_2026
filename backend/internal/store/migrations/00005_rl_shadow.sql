-- +goose Up
-- One row per decided tick: what the RL policy (shadow, never executed) would ship, next to the planner's
-- rule-based baseline and what our greedy policy actually recommended.
CREATE TABLE rl_shadow (
    epoch_id           BIGINT      NOT NULL REFERENCES sim_epochs(id),
    tick               INT         NOT NULL,
    action             INT,
    strategy           TEXT,
    baseline_action    INT,
    baseline_strategy  TEXT,
    shipments          JSONB       NOT NULL DEFAULT '[]',
    baseline_shipments JSONB       NOT NULL DEFAULT '[]',
    greedy             JSONB       NOT NULL DEFAULT '[]',  -- greedy recommendations of the same tick
    mask               JSONB,
    logits             JSONB,
    error              TEXT,                               -- why the policy could not run (stale snapshot, ...)
    latency_us         BIGINT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (epoch_id, tick)
);

-- +goose Down
DROP TABLE rl_shadow;
