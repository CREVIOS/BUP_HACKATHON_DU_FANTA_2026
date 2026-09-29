package obs

import (
	"context"
	"log/slog"

	"go.opentelemetry.io/otel/trace"
)

// TraceHandler stamps "trace_id" and "span_id" (hex) on every record whose context carries a valid span,
// so Loki's derived field (`"trace_id":"<hex>"`) links each log line to its Tempo trace and back.
// Log with the ctx variants (slog.InfoContext, ...) for this to apply.
type TraceHandler struct{ slog.Handler }

func (h TraceHandler) Handle(ctx context.Context, r slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		r.AddAttrs(slog.String("trace_id", sc.TraceID().String()), slog.String("span_id", sc.SpanID().String()))
	}
	return h.Handler.Handle(ctx, r)
}

func (h TraceHandler) WithAttrs(as []slog.Attr) slog.Handler {
	return TraceHandler{h.Handler.WithAttrs(as)}
}
func (h TraceHandler) WithGroup(name string) slog.Handler {
	return TraceHandler{h.Handler.WithGroup(name)}
}
