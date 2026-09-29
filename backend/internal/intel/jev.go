package intel

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

var (
	jevRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "jev_requests_total", Help: "Jev (TypeSafe System One) calls by result.",
	}, []string{"result"})
	jevLatency = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "jev_request_duration_seconds", Help: "Jev round-trip latency.", Buckets: []float64{.1, .25, .5, .75, 1, 1.5, 2, 3},
	})
)

// Jev asks TypeSafe's System One model one Noul (calibrated yes/no probability) per shipment, in a single call.
// Code computes every number; Jev only sees qualitative features and judges whether a shipment is routine
// enough to execute without a human (docs/PLAN.md §5). https://docs.typesafe.ai/api
type Jev struct {
	url, key, model string
	http            *http.Client
}

func NewJev(key string) *Jev {
	if key == "" {
		return nil
	}
	return &Jev{
		url: "https://api.typesafe.ai/v1/systemone", key: key, model: "jev-latest",
		http: &http.Client{Timeout: 2 * time.Second, Transport: otelhttp.NewTransport(http.DefaultTransport)},
	}
}

const autoQuestion = "May shipment `shipments.%s` execute automatically, without a human operator reviewing it first?"

var autoCriteria = map[string]string{
	"true":  "Routine replenishment: normal demand, no crisis affecting it, direct route, ordinary size, depot stock stays healthy.",
	"false": "Unusual or high-stakes: crisis conditions, abnormal or unexplained demand, cross-region rerouting, unusually large size, or depot stock left low. A human should check it.",
}

// AskAuto returns P(yes) per shipment id, and the versioned model that answered.
func (j *Jev) AskAuto(ctx context.Context, shipments map[string]map[string]string) (map[string]float64, string, error) {
	questions := map[string]any{}
	for id := range shipments {
		questions[id] = map[string]any{"type": "noul", "instructions": fmt.Sprintf(autoQuestion, id), "criteria": autoCriteria}
	}
	body, err := json.Marshal(map[string]any{
		"model": j.model,
		"state": map[string]any{
			"context":   "Operations center of a SIMULATED fuel supply network (training simulation, no real fuel). Each shipment was already checked against every hard constraint by code.",
			"shipments": shipments,
		},
		"questions": questions,
	})
	if err != nil {
		return nil, "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, j.url, bytes.NewReader(body))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+j.key)
	req.Header.Set("Content-Type", "application/json")

	start := time.Now()
	resp, err := j.http.Do(req)
	jevLatency.Observe(time.Since(start).Seconds())
	if err != nil {
		jevRequests.WithLabelValues("transport_error").Inc()
		return nil, "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		jevRequests.WithLabelValues(fmt.Sprint(resp.StatusCode)).Inc()
		return nil, "", fmt.Errorf("jev http %d: %.200s", resp.StatusCode, raw)
	}
	var out struct {
		Model   string `json:"model"`
		Answers map[string]struct {
			Noul *float64 `json:"noul"`
		} `json:"answers"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		jevRequests.WithLabelValues("invalid_body").Inc()
		return nil, "", fmt.Errorf("jev: invalid body: %w", err)
	}
	p := map[string]float64{}
	for id := range shipments {
		a, ok := out.Answers[id]
		if !ok || a.Noul == nil || *a.Noul < 0 || *a.Noul > 1 { // validate the external answer before trusting it
			jevRequests.WithLabelValues("invalid_answer").Inc()
			return nil, "", fmt.Errorf("jev: missing or out-of-range answer for %s", id)
		}
		p[id] = *a.Noul
	}
	jevRequests.WithLabelValues("ok").Inc()
	return p, out.Model, nil
}
