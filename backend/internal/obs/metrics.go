package obs

import (
	"context"
	"log/slog"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

func componentAttr(component string) attribute.KeyValue {
	return attribute.String("component", component)
}

// The global MeterProvider delegates: instruments created here at package-init time
// start as no-ops and upgrade automatically once Setup installs the real provider,
// so packages can reference these vars directly without ordering constraints.
var meter = otel.Meter("github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/fuelops")

var (
	// snapshotsWritten counts world snapshots the ingestor persisted (pipeline throughput).
	snapshotsWritten = mustInt64Counter("fuelops_snapshots_total",
		metric.WithDescription("World snapshots persisted by the ingestor."))
	// pollErrors counts failed simulator poll cycles (integration health).
	pollErrors = mustInt64Counter("fuelops_poll_errors_total",
		metric.WithDescription("Failed simulator poll cycles."))
	// fallbackActivations counts times a component fell back to a degraded/rule-based path (brief §11, §14).
	fallbackActivations = mustInt64Counter("fuelops_fallback_activations_total",
		metric.WithDescription("Times a component activated a fallback path."))
	// serviceLevel mirrors the simulator's reported service_level as an OTel gauge.
	serviceLevel = mustFloat64Gauge("fuelops_sim_service_level",
		metric.WithDescription("Simulator service_level (0-1) as last observed by the ingestor."))
	// simTick mirrors the latest simulator tick the ingestor has seen.
	simTick = mustInt64Gauge("fuelops_sim_tick",
		metric.WithDescription("Latest simulator tick seen by the ingestor."))
)

// RecordSnapshot marks one persisted world snapshot.
func RecordSnapshot(ctx context.Context) { snapshotsWritten.Add(ctx, 1) }

// RecordPollError marks one failed poll cycle.
func RecordPollError(ctx context.Context) { pollErrors.Add(ctx, 1) }

// RecordFallback marks one fallback activation, labelled by component (e.g. "intel", "policy").
func RecordFallback(ctx context.Context, component string) {
	fallbackActivations.Add(ctx, 1, metric.WithAttributes(componentAttr(component)))
}

// SetServiceLevel records the latest simulator service_level.
func SetServiceLevel(ctx context.Context, v float64) { serviceLevel.Record(ctx, v) }

// SetSimTick records the latest simulator tick.
func SetSimTick(ctx context.Context, tick int) { simTick.Record(ctx, int64(tick)) }

func mustInt64Counter(name string, opts ...metric.Int64CounterOption) metric.Int64Counter {
	c, err := meter.Int64Counter(name, opts...)
	if err != nil {
		slog.Error("otel instrument", "name", name, "err", err)
	}
	return c
}

func mustInt64Gauge(name string, opts ...metric.Int64GaugeOption) metric.Int64Gauge {
	g, err := meter.Int64Gauge(name, opts...)
	if err != nil {
		slog.Error("otel instrument", "name", name, "err", err)
	}
	return g
}

func mustFloat64Gauge(name string, opts ...metric.Float64GaugeOption) metric.Float64Gauge {
	g, err := meter.Float64Gauge(name, opts...)
	if err != nil {
		slog.Error("otel instrument", "name", name, "err", err)
	}
	return g
}
