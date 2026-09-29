package sim

import (
	"bufio"
	"context"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	sseConnected = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "sim_sse_connected", Help: "1 while the simulator SSE stream is connected.",
	})
	sseReconnects = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "sim_sse_reconnects_total", Help: "SSE reconnects by reason.",
	}, []string{"reason"})
)

// Stream consumes GET /v1/stream and signals wake on every simulation.tick. SSE is only a hint:
// callers must re-read REST. It is one long-lived connection outside the request semaphore
// (verified: open streams do not hold simulator DB connections).
//
// Watchdog: the simulator silently drops a subscriber whose 200-event queue overflows, but keeps the
// HTTP stream open sending keepalives forever (a zombie). If the REST tick (reported via ObserveTick)
// advances while no tick event arrived for staleAfter, the stream is torn down and reopened.
type Stream struct {
	base       string
	http       *http.Client
	staleAfter time.Duration
	lastEvent  atomic.Int64 // unix nanos of last simulation.tick event
	restTick   atomic.Int64
	eventTick  atomic.Int64
}

func NewStream(base string, staleAfter time.Duration) *Stream {
	return &Stream{base: base, http: &http.Client{}, staleAfter: staleAfter}
}

// ObserveTick is called by the poller with the tick it read over REST.
func (s *Stream) ObserveTick(tick int) { s.restTick.Store(int64(tick)) }

// Connected reports whether a tick event arrived recently.
func (s *Stream) Connected() bool {
	return time.Since(time.Unix(0, s.lastEvent.Load())) < s.staleAfter
}

// Run blocks until ctx is done, reconnecting with capped exponential backoff.
func (s *Stream) Run(ctx context.Context, wake chan<- struct{}) {
	backoff := 250 * time.Millisecond
	for ctx.Err() == nil {
		reason := s.consume(ctx, wake)
		sseConnected.Set(0)
		if ctx.Err() != nil {
			return
		}
		sseReconnects.WithLabelValues(reason).Inc()
		slog.WarnContext(ctx, "sse disconnected", "reason", reason, "retry_in", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 5*time.Second)
	}
}

func (s *Stream) consume(ctx context.Context, wake chan<- struct{}) string {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, s.base+"/v1/stream", nil)
	resp, err := s.http.Do(req)
	if err != nil {
		return "connect_error"
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "status_" + resp.Status[:3] // 503 = stream_disconnect / unavailable fault
	}
	sseConnected.Set(1)
	s.lastEvent.Store(time.Now().UnixNano())
	s.eventTick.Store(s.restTick.Load())

	zombie := make(chan struct{})
	go func() { // watchdog
		t := time.NewTicker(s.staleAfter / 2)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				silent := time.Since(time.Unix(0, s.lastEvent.Load())) > s.staleAfter
				if silent && s.restTick.Load() > s.eventTick.Load() {
					close(zombie)
					cancel()
					return
				}
			}
		}
	}()

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		if name, ok := strings.CutPrefix(sc.Text(), "event: "); ok && name == "simulation.tick" {
			s.lastEvent.Store(time.Now().UnixNano())
			s.eventTick.Store(s.restTick.Load() + 1)
			select {
			case wake <- struct{}{}:
			default: // a wake-up is already pending; coalesce
			}
		}
	}
	select {
	case <-zombie:
		return "zombie_watchdog"
	default:
		return "eof"
	}
}
