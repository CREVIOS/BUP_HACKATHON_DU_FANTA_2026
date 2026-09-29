-- +goose Up
-- 00001 gained scenario_version after it had already run on the first databases; add it where it is missing.
ALTER TABLE sim_epochs ADD COLUMN IF NOT EXISTS scenario_version TEXT NOT NULL DEFAULT '';

-- +goose Down
SELECT 1;
