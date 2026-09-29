package httpx

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestInstrumentLabelsByPatternAndChaosSparesProbes(t *testing.T) {
	mux := NewMux("t", nil, false)
	mux.HandleFunc("GET /api/items/{id}", func(w http.ResponseWriter, r *http.Request) {})
	h := Instrument(mux, 100)

	for _, tc := range []struct {
		path string
		want int
	}{{"/api/items/1", 500}, {"/api/items/2", 500}, {"/healthz", 200}, {"/metrics", 200}} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", tc.path, nil))
		if rec.Code != tc.want {
			t.Errorf("%s: got %d want %d", tc.path, rec.Code, tc.want)
		}
	}
	if n := testutil.ToFloat64(httpRequests.WithLabelValues("GET /api/items/{id}", "GET", "500")); n != 2 {
		t.Fatalf("pattern-labelled 500 count = %v, want 2", n)
	}
}

func TestFailHealth(t *testing.T) {
	rec := httptest.NewRecorder()
	Instrument(NewMux("t", func(context.Context) error { return nil }, true), 0).
		ServeHTTP(rec, httptest.NewRequest("GET", "/healthz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d", rec.Code)
	}
}
