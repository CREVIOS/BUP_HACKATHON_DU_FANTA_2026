package obs

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"testing"

	"go.opentelemetry.io/otel/trace"
)

func TestTraceHandlerAddsIDs(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(TraceHandler{slog.NewJSONHandler(&buf, nil)}).With("service", "t")
	tid, _ := trace.TraceIDFromHex("4bf92f3577b34da6a3ce929d0e0e4736")
	sid, _ := trace.SpanIDFromHex("00f067aa0ba902b7")
	ctx := trace.ContextWithSpanContext(context.Background(),
		trace.NewSpanContext(trace.SpanContextConfig{TraceID: tid, SpanID: sid, TraceFlags: trace.FlagsSampled}))

	log.InfoContext(ctx, "with span")
	log.InfoContext(context.Background(), "without span")

	lines := bytes.Split(bytes.TrimSpace(buf.Bytes()), []byte("\n"))
	var with, without map[string]any
	json.Unmarshal(lines[0], &with)
	json.Unmarshal(lines[1], &without)
	if with["trace_id"] != tid.String() || with["span_id"] != sid.String() || with["service"] != "t" {
		t.Fatalf("missing ids: %v", with)
	}
	if _, ok := without["trace_id"]; ok {
		t.Fatalf("unexpected trace_id without span: %v", without)
	}
}
