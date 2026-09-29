package api

import (
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// window keeps the last requests this replica served, for the §15 status panel (p95 latency, error rate).
// Prometheus has the fleet-wide numbers; this answers "is the API healthy right now" without depending on it.
type window struct {
	mu   sync.Mutex
	buf  [2048]sample
	next int
}

type sample struct {
	at  time.Time
	dur time.Duration
	err bool
}

func (wd *window) wrap(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/stream" || r.URL.Path == "/healthz" || r.URL.Path == "/metrics" || strings.HasPrefix(r.URL.Path, "/api/admin/sim/") {
			h.ServeHTTP(w, r) // long-lived, deliberately waiting on the simulator, or probes: not user latency
			return
		}
		start := time.Now()
		rec := &codeRecorder{ResponseWriter: w, code: http.StatusOK}
		h.ServeHTTP(rec, r)
		wd.mu.Lock()
		wd.buf[wd.next] = sample{at: start, dur: time.Since(start), err: rec.code >= 500}
		wd.next = (wd.next + 1) % len(wd.buf)
		wd.mu.Unlock()
	})
}

// stats over the last 5 minutes: p95 latency (ms), error rate (0-1), request count.
func (wd *window) stats() (p95ms, errRate float64, n int) {
	cutoff := time.Now().Add(-5 * time.Minute)
	var durs []time.Duration
	errs := 0
	wd.mu.Lock()
	for _, s := range wd.buf {
		if s.at.After(cutoff) {
			durs = append(durs, s.dur)
			if s.err {
				errs++
			}
		}
	}
	wd.mu.Unlock()
	if len(durs) == 0 {
		return 0, 0, 0
	}
	sort.Slice(durs, func(i, j int) bool { return durs[i] < durs[j] })
	p95 := durs[(len(durs)*95+99)/100-1]
	return float64(p95.Microseconds()) / 1000, float64(errs) / float64(len(durs)), len(durs)
}

type codeRecorder struct {
	http.ResponseWriter
	code int
}

func (c *codeRecorder) WriteHeader(code int) {
	c.code = code
	c.ResponseWriter.WriteHeader(code)
}

func (c *codeRecorder) Unwrap() http.ResponseWriter { return c.ResponseWriter }
