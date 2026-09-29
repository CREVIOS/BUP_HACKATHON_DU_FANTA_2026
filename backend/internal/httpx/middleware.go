package httpx

import (
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// No service/app label: Prometheus adds `app` from the pod label (deploy/ owns that).
var (
	httpRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "http_requests_total", Help: "HTTP requests served, by mux route pattern.",
	}, []string{"route", "method", "code"})
	httpDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name: "http_request_duration_seconds", Help: "HTTP request latency, by mux route pattern.", Buckets: prometheus.DefBuckets,
	}, []string{"route", "method"})
)

// Instrument records RED metrics labelled by the ServeMux pattern (low cardinality) and,
// when chaos500Pct > 0, fails that share of non-operational requests with 500 (rollback demo).
func Instrument(mux *http.ServeMux, chaos500Pct int) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		if chaos500Pct > 0 && !operational(r.URL.Path) && rand.IntN(100) < chaos500Pct {
			_, r.Pattern = mux.Handler(r)
			http.Error(rec, `{"error":"chaos: injected 500"}`, http.StatusInternalServerError)
		} else {
			mux.ServeHTTP(rec, r) // ServeMux sets r.Pattern on this request
		}
		route := r.Pattern
		if route == "" {
			route = "unmatched"
		}
		httpRequests.WithLabelValues(route, r.Method, strconv.Itoa(rec.status)).Inc()
		httpDuration.WithLabelValues(route, r.Method).Observe(time.Since(start).Seconds())
	})
}

// operational endpoints are never chaos-failed, so probes and scrapes stay truthful.
func operational(path string) bool {
	return path == "/healthz" || path == "/metrics" || path == "/version"
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Unwrap lets http.ResponseController reach Flush (needed for SSE to the browser).
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// ChaosEnabled is a helper for log lines at startup.
func ChaosEnabled(pct int, failHealth bool) string {
	var parts []string
	if pct > 0 {
		parts = append(parts, "CHAOS_500_PCT="+strconv.Itoa(pct))
	}
	if failHealth {
		parts = append(parts, "FAIL_HEALTH=true")
	}
	return strings.Join(parts, " ")
}
