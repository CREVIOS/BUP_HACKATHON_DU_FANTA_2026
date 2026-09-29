-- +goose Up
-- Which policy produces the recommendations: the trained RL policy (default) or the greedy heuristic.
-- The other one keeps running beside it for comparison (rl_shadow, /api/rl).
ALTER TABLE settings ADD COLUMN decision_policy TEXT NOT NULL DEFAULT 'rl' CHECK (decision_policy IN ('rl','greedy'));

-- +goose Down
ALTER TABLE settings DROP COLUMN decision_policy;
