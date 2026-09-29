// Package obs wires OpenTelemetry into every fuelops process: OTLP traces and
// OTel metrics exported to a collector (Jaeger locally, Grafana Tempo in k8s).
//
// It is deliberately optional. When OTEL_EXPORTER_OTLP_ENDPOINT is unset the whole
// SDK is a no-op, so `go test`, `go run` and any environment without a collector stay
// silent and fast. This mirrors the brief's §11 stance: observability must never be
// the thing that takes the system down.
//
// Metrics here are ADDITIVE. The load-bearing RED metrics (http_requests_total,
// http_request_duration_seconds, sim_*) stay on the Prometheus client and keep
// driving the HPA, canary rollback analysis and alerts (deploy/). OTel adds
// distributed traces plus a few fuelops_* instruments for the intelligence pipeline.
package obs

import (
	"context"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// Enabled reports whether an OTLP collector endpoint is configured. When false,
// Setup installs nothing and callers get the API's no-op providers.
func Enabled() bool { return os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" }

// Setup installs global tracer and meter providers exporting via OTLP/gRPC to the
// collector named by OTEL_EXPORTER_OTLP_ENDPOINT (e.g. http://otel-collector:4317).
// The returned shutdown flushes and closes the exporters; call it on process exit.
// When no endpoint is configured it returns a no-op shutdown and nil error.
func Setup(ctx context.Context, service, version string) (func(context.Context) error, error) {
	if !Enabled() {
		return func(context.Context) error { return nil }, nil
	}

	// Schemaless attributes so merging with resource.Default() (which carries its own, newer
	// schema URL) never fails on a schema-URL conflict. service.name/version keys are stable.
	res, err := resource.Merge(resource.Default(), resource.NewSchemaless(
		semconv.ServiceName(service),
		semconv.ServiceVersion(version),
	))
	if err != nil {
		return nil, err
	}

	// WithInsecure: our collector speaks plaintext OTLP (local Jaeger, in-cluster Tempo).
	traceExp, err := otlptracegrpc.New(ctx, otlptracegrpc.WithInsecure())
	if err != nil {
		return nil, err
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExp),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)

	metricExp, err := otlpmetricgrpc.New(ctx, otlpmetricgrpc.WithInsecure())
	if err != nil {
		_ = tp.Shutdown(ctx)
		return nil, err
	}
	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExp)),
		sdkmetric.WithResource(res),
	)
	otel.SetMeterProvider(mp)

	// Standard W3C trace context + baggage so spans stitch across api -> intel and ingestor -> sim.
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{},
	))

	return func(ctx context.Context) error {
		mErr := mp.Shutdown(ctx)
		if tErr := tp.Shutdown(ctx); tErr != nil {
			return tErr
		}
		return mErr
	}, nil
}
