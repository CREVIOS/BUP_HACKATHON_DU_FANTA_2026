// Package sim is the only way any fuelops process talks to the BUP Fuel Supply Simulator.
//
// Hard rules (verified against the real simulator, see docs/PLAN.md §2):
//   - at most maxInflight concurrent requests: ~15 concurrent requests permanently wedge the simulator;
//   - retries resend the exact same bytes, so an idempotent POST /v1/allocations replay stays identical;
//   - three different error body shapes exist and all are parsed into *APIError.
package sim

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

var (
	requests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "sim_requests_total", Help: "Simulator requests by path and result code.",
	}, []string{"path", "code"})
	inflight = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "sim_inflight", Help: "Simulator requests currently in flight (must never exceed SIM_MAX_INFLIGHT).",
	})
	duration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name: "sim_request_duration_seconds", Help: "Simulator request latency.", Buckets: prometheus.DefBuckets,
	}, []string{"path"})
	staleResponses = promauto.NewCounter(prometheus.CounterOpts{
		Name: "sim_stale_responses_total", Help: "Responses carrying X-Simulator-Stale: true.",
	})
)

// APIError is a non-2xx simulator response. Code is the simulator's UPPER_SNAKE code,
// "VALIDATION" for FastAPI 422 bodies, or "HTTP_<status>" when the body is unparseable.
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("sim %d %s: %s", e.Status, e.Code, e.Message) }

// Retryable reports whether the same request may be sent again unchanged.
func (e *APIError) Retryable() bool { return e.Status >= 500 }

type Client struct {
	base        string
	http        *http.Client
	sem         chan struct{}
	maxAttempts int
	backoff     time.Duration
}

func New(baseURL string, maxInflight int, timeout time.Duration) *Client {
	return &Client{
		base: baseURL,
		// otelhttp.NewTransport injects W3C traceparent so the simulator call joins the
		// ingestor's trace, and emits a client span. No-op until obs.Setup runs.
		http:        &http.Client{Timeout: timeout, Transport: otelhttp.NewTransport(http.DefaultTransport)},
		sem:         make(chan struct{}, maxInflight),
		maxAttempts: 3,
		backoff:     100 * time.Millisecond,
	}
}

// Response metadata callers care about.
type Meta struct {
	Status int
	Stale  bool // X-Simulator-Stale: true (stale_data fault active)
}

// GetJSON GETs path and decodes the JSON body into out.
func (c *Client) GetJSON(ctx context.Context, path string, out any) (Meta, error) {
	return c.do(ctx, http.MethodGet, path, nil, out)
}

// PostJSON POSTs body verbatim. Callers pass pre-serialized bytes and persist them,
// so a retry after a crash sends a byte-identical request under the same idempotency key.
func (c *Client) PostJSON(ctx context.Context, path string, body []byte, out any) (Meta, error) {
	return c.do(ctx, http.MethodPost, path, body, out)
}

// PostOnce POSTs without retrying: for non-idempotent calls (/admin/step, /admin/events, /admin/faults),
// where a retry after a timeout could step twice or inject twice.
func (c *Client) PostOnce(ctx context.Context, path string, body []byte, out any) (Meta, error) {
	return c.once(ctx, http.MethodPost, path, body, out)
}

func (c *Client) do(ctx context.Context, method, path string, body []byte, out any) (Meta, error) {
	var lastErr error
	for attempt := 0; attempt < c.maxAttempts; attempt++ {
		if attempt > 0 {
			wait := c.backoff<<(attempt-1) + time.Duration(rand.Int64N(int64(c.backoff)))
			select {
			case <-ctx.Done():
				return Meta{}, errors.Join(ctx.Err(), lastErr)
			case <-time.After(wait):
			}
		}
		meta, err := c.once(ctx, method, path, body, out)
		if err == nil {
			return meta, nil
		}
		lastErr = err
		var apiErr *APIError
		if errors.As(err, &apiErr) && !apiErr.Retryable() {
			return meta, err // 4xx: retrying the same request cannot succeed
		}
	}
	return Meta{}, lastErr
}

func (c *Client) once(ctx context.Context, method, path string, body []byte, out any) (Meta, error) {
	select {
	case c.sem <- struct{}{}:
	case <-ctx.Done():
		return Meta{}, ctx.Err()
	}
	defer func() { <-c.sem }()
	inflight.Inc()
	defer inflight.Dec()

	req, err := http.NewRequestWithContext(ctx, method, c.base+path, bytes.NewReader(body))
	if err != nil {
		return Meta{}, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	label := metricPath(req)
	start := time.Now()
	resp, err := c.http.Do(req)
	duration.WithLabelValues(label).Observe(time.Since(start).Seconds())
	if err != nil {
		requests.WithLabelValues(label, "transport_error").Inc()
		return Meta{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return Meta{}, err
	}
	requests.WithLabelValues(label, strconv.Itoa(resp.StatusCode)).Inc()

	meta := Meta{Status: resp.StatusCode, Stale: resp.Header.Get("X-Simulator-Stale") == "true"}
	if meta.Stale {
		staleResponses.Inc()
	}
	if resp.StatusCode >= 300 {
		return meta, parseError(resp.StatusCode, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return meta, fmt.Errorf("sim %s: invalid response body: %w", path, err)
		}
	}
	return meta, nil
}

// parseError handles the three shapes the simulator emits:
//
//	{"detail":{"code":"...","message":"..."}}  domain errors, stream_disconnect
//	{"error":{"code":"FAULT_INJECTED",...}}     injected unavailable/error_rate faults
//	{"detail":[...]}                            FastAPI/Pydantic 422
func parseError(status int, raw []byte) *APIError {
	var body struct {
		Detail json.RawMessage                 `json:"detail"`
		Error  *struct{ Code, Message string } `json:"error"`
	}
	e := &APIError{Status: status, Code: "HTTP_" + strconv.Itoa(status), Message: string(raw)}
	if json.Unmarshal(raw, &body) != nil {
		return e
	}
	var detail struct{ Code, Message string }
	switch {
	case body.Error != nil:
		e.Code, e.Message = body.Error.Code, body.Error.Message
	case json.Unmarshal(body.Detail, &detail) == nil && detail.Code != "":
		e.Code, e.Message = detail.Code, detail.Message
	case len(body.Detail) > 0 && body.Detail[0] == '[':
		e.Code, e.Message = "VALIDATION", string(body.Detail)
	}
	return e
}

func metricPath(r *http.Request) string { return r.URL.Path }
