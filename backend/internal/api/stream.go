package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// hub fans change notifications out to browser SSE clients. One poller per api replica watches cheap
// high-water marks in Postgres; clients get "what changed" and refetch the matching REST resource.
type hub struct {
	mu    sync.Mutex
	subs  map[chan sseEvent]struct{}
	pokes chan struct{}
	last  sseEvent // latest "tick" event, sent to new clients first
}

type sseEvent struct {
	Name string
	Data any
}

func newHub() *hub { return &hub{subs: map[chan sseEvent]struct{}{}, pokes: make(chan struct{}, 1)} }

// poke asks for an immediate re-check (after a write on this replica).
func (h *hub) poke() {
	select {
	case h.pokes <- struct{}{}:
	default:
	}
}

func (h *hub) subscribe() (chan sseEvent, sseEvent) {
	ch := make(chan sseEvent, 32)
	h.mu.Lock()
	defer h.mu.Unlock()
	h.subs[ch] = struct{}{}
	return ch, h.last
}

func (h *hub) unsubscribe(ch chan sseEvent) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
}

func (h *hub) broadcast(e sseEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if e.Name == "tick" {
		h.last = e
	}
	for ch := range h.subs {
		select {
		case ch <- e:
		default: // a slow client misses a notification; the next one (or its own refetch) catches it up
		}
	}
}

type marks struct {
	Snapshot, Alerts, OpenAlerts, Recs, Decisions, Commands int64
	Outbox                                                  time.Time
}

func (h *hub) run(ctx context.Context, db *pgxpool.Pool) {
	t := time.NewTicker(500 * time.Millisecond)
	defer t.Stop()
	var prev marks
	for {
		var m marks
		var tick int
		var status string
		var stale bool
		err := db.QueryRow(ctx, `SELECT
			(SELECT COALESCE(max(id), 0) FROM snapshots), (SELECT COALESCE(max(id), 0) FROM alerts),
			(SELECT count(*) FROM alerts WHERE resolved_at IS NULL), (SELECT COALESCE(max(id), 0) FROM recommendations),
			(SELECT COALESCE(max(id), 0) FROM decisions), (SELECT COALESCE(max(id), 0) FROM sim_commands WHERE status <> 'PENDING'),
			(SELECT COALESCE(max(updated_at), 'epoch') FROM outbox),
			COALESCE((SELECT tick FROM snapshots ORDER BY id DESC LIMIT 1), 0),
			COALESCE((SELECT payload->'instance'->>'status' FROM snapshots ORDER BY id DESC LIMIT 1), ''),
			COALESCE((SELECT stale FROM snapshots ORDER BY id DESC LIMIT 1), false)`).
			Scan(&m.Snapshot, &m.Alerts, &m.OpenAlerts, &m.Recs, &m.Decisions, &m.Commands, &m.Outbox, &tick, &status, &stale)
		if err != nil && ctx.Err() == nil {
			slog.Warn("stream poll", "err", err)
		}
		if err == nil {
			if m.Snapshot != prev.Snapshot {
				h.broadcast(sseEvent{"tick", map[string]any{"tick": tick, "sim_status": status, "stale": stale}})
			}
			if m.Alerts != prev.Alerts || m.OpenAlerts != prev.OpenAlerts {
				h.broadcast(sseEvent{"alerts", map[string]any{"open": m.OpenAlerts}})
			}
			if m.Recs != prev.Recs || m.Decisions != prev.Decisions {
				h.broadcast(sseEvent{"recommendations", map[string]any{"latest_id": m.Recs}})
			}
			if !m.Outbox.Equal(prev.Outbox) || m.Snapshot != prev.Snapshot {
				h.broadcast(sseEvent{"allocations", map[string]any{"tick": tick}})
			}
			if m.Commands != prev.Commands {
				h.broadcast(sseEvent{"commands", map[string]any{"latest_id": m.Commands}})
			}
			prev = m
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-h.pokes:
		}
	}
}

// stream is Server-Sent Events for the browser. Events: tick, alerts, recommendations, allocations, commands.
// Each says what changed; the client refetches that resource. A comment keepalive is sent every 15 s.
func (s *server) stream(w http.ResponseWriter, r *http.Request) {
	rc := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no") // disable proxy buffering (nginx, Next.js rewrites behind one)
	w.WriteHeader(http.StatusOK)
	ch, last := s.hub.subscribe()
	defer s.hub.unsubscribe(ch)
	send := func(e sseEvent) bool {
		b, _ := json.Marshal(e.Data)
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", e.Name, b); err != nil {
			return false
		}
		return rc.Flush() == nil
	}
	fmt.Fprint(w, "retry: 3000\n\n")
	if last.Name != "" && !send(last) {
		return
	}
	rc.Flush()
	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case e := <-ch:
			if !send(e) {
				return
			}
		case <-keepalive.C:
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil || rc.Flush() != nil {
				return
			}
		}
	}
}
