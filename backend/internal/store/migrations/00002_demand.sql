-- +goose Up
-- Demand history mirrored from /v1/demand-history (12 rows/tick). Training data for the forecaster.
CREATE TABLE demand_observations (
    epoch_id      BIGINT           NOT NULL REFERENCES sim_epochs(id),
    sim_id        BIGINT           NOT NULL,   -- id from the simulator
    station_id    TEXT             NOT NULL,
    fuel_type     TEXT             NOT NULL,
    tick          INT              NOT NULL,
    sim_time      TIMESTAMPTZ      NOT NULL,
    demand_liters DOUBLE PRECISION NOT NULL,
    served_liters DOUBLE PRECISION NOT NULL,
    unmet_liters  DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (epoch_id, sim_id)
);
CREATE INDEX demand_obs_series ON demand_observations (epoch_id, station_id, fuel_type, tick DESC);

-- +goose Down
DROP TABLE demand_observations;
