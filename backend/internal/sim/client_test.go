package sim

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestRetriesTransient503WithIdenticalBody(t *testing.T) {
	var calls atomic.Int32
	var bodies []string
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, string(b))
		mu.Unlock()
		if calls.Add(1) < 3 {
			w.WriteHeader(503)
			io.WriteString(w, `{"error":{"code":"FAULT_INJECTED","message":"x"}}`)
			return
		}
		w.WriteHeader(201)
		io.WriteString(w, `{"id":7}`)
	}))
	defer srv.Close()

	c := New(srv.URL, 4, time.Second)
	c.backoff = time.Millisecond
	var out struct{ ID int }
	body := []byte(`{"idempotency_key":"k1","quantity":3000}`)
	if _, err := c.PostJSON(context.Background(), "/v1/allocations", body, &out); err != nil {
		t.Fatal(err)
	}
	if out.ID != 7 || calls.Load() != 3 {
		t.Fatalf("id=%d calls=%d", out.ID, calls.Load())
	}
	for _, b := range bodies {
		if b != string(body) {
			t.Fatalf("retry changed body: %q", b)
		}
	}
}

func TestDoesNotRetry409(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(409)
		io.WriteString(w, `{"detail":{"code":"INSUFFICIENT_INVENTORY","message":"no"}}`)
	}))
	defer srv.Close()

	_, err := New(srv.URL, 4, time.Second).GetJSON(context.Background(), "/x", nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "INSUFFICIENT_INVENTORY" || calls.Load() != 1 {
		t.Fatalf("err=%v calls=%d", err, calls.Load())
	}
}

func TestNeverExceedsMaxInflight(t *testing.T) {
	var cur, peak atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := cur.Add(1)
		for p := peak.Load(); n > p && !peak.CompareAndSwap(p, n); p = peak.Load() {
		}
		time.Sleep(20 * time.Millisecond)
		cur.Add(-1)
		io.WriteString(w, `{}`)
	}))
	defer srv.Close()

	c := New(srv.URL, 4, time.Second)
	var wg sync.WaitGroup
	for range 40 {
		wg.Add(1)
		go func() { defer wg.Done(); c.GetJSON(context.Background(), "/v1/stations", nil) }()
	}
	wg.Wait()
	if peak.Load() > 4 {
		t.Fatalf("peak in-flight %d > 4", peak.Load())
	}
}

func TestParseErrorShapes(t *testing.T) {
	cases := map[string]string{
		`{"detail":{"code":"ROUTE_DISRUPTED","message":"m"}}`: "ROUTE_DISRUPTED",
		`{"error":{"code":"FAULT_INJECTED","message":"m"}}`:   "FAULT_INJECTED",
		`{"detail":{"code":"FAULT_INJECTED"}}`:                "FAULT_INJECTED",
		`{"detail":[{"loc":["body","quantity"]}]}`:            "VALIDATION",
		`not json`: "HTTP_500",
	}
	for body, want := range cases {
		if got := parseError(500, []byte(body)).Code; got != want {
			t.Errorf("%s: got %s want %s", body, got, want)
		}
	}
}

func TestParseSimTimeWithAndWithoutOffset(t *testing.T) {
	for _, s := range []string{"2026-01-01T03:00:00", "2026-01-01T03:00:00+00:00"} {
		ts, err := ParseSimTime(s)
		if err != nil || ts.Hour() != 3 || ts.Location() != time.UTC {
			t.Fatalf("%s -> %v %v", s, ts, err)
		}
	}
}
