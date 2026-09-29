package sim

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// ErrTickMoved means a tick committed while the snapshot was being read on every attempt.
var ErrTickMoved = errors.New("sim: tick advanced during snapshot")

// FetchWorld reads every resource sequentially and fences the read with /v1/instance before and after:
// REST has no atomic snapshot, so a tick can commit between GETs (docs/PLAN.md §2 #17).
func (c *Client) FetchWorld(ctx context.Context) (World, error) {
	for attempt := 0; attempt < 3; attempt++ {
		w, err := c.fetchOnce(ctx)
		if !errors.Is(err, ErrTickMoved) {
			return w, err
		}
	}
	return World{}, ErrTickMoved
}

func (c *Client) fetchOnce(ctx context.Context) (World, error) {
	var w World
	// Fence first: the tick every other read must still match.
	meta, err := c.GetJSON(ctx, "/v1/instance", &w.Instance)
	if err != nil {
		return World{}, fmt.Errorf("GET /v1/instance: %w", err)
	}
	w.Stale = meta.Stale
	reads := []struct {
		path string
		out  any
	}{
		{"/v1/regions", &w.Regions},
		{"/v1/depots", &w.Depots},
		{"/v1/stations", &w.Stations},
		{"/v1/routes", &w.Routes},
		{"/v1/events", &w.Events},
		{"/v1/allocations", &w.Allocations},
		{"/v1/supply-arrivals", &w.Supply},
	}
	// In parallel: the client's semaphore still caps simulator requests at SIM_MAX_INFLIGHT, so a slow simulator
	// (latency fault) costs one round trip per 4 reads instead of one per read.
	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		first error
	)
	for _, r := range reads {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m, err := c.GetJSON(ctx, r.path, r.out)
			mu.Lock()
			defer mu.Unlock()
			if err != nil && first == nil {
				first = fmt.Errorf("GET %s: %w", r.path, err)
			}
			w.Stale = w.Stale || m.Stale
		}()
	}
	wg.Wait()
	if first != nil {
		return World{}, first
	}
	var after Instance
	if _, err := c.GetJSON(ctx, "/v1/instance", &after); err != nil {
		return World{}, fmt.Errorf("GET /v1/instance (fence): %w", err)
	}
	if after.Tick != w.Instance.Tick {
		return World{}, ErrTickMoved
	}
	return w, nil
}

// FetchDemand returns the newest demand observations (newest first). The simulator clamps limit to [1,2000]
// and writes 12 rows per tick, so callers size limit from the ticks elapsed since their last read.
func (c *Client) FetchDemand(ctx context.Context, limit int) ([]DemandObservation, error) {
	limit = min(max(limit, 1), 2000)
	var rows []DemandObservation
	_, err := c.GetJSON(ctx, fmt.Sprintf("/v1/demand-history?limit=%d", limit), &rows)
	return rows, err
}

// FetchMetrics reads /v1/metrics. It full-scans a growing table server-side: call it at most every few seconds.
func (c *Client) FetchMetrics(ctx context.Context) (Metrics, error) {
	var m Metrics
	_, err := c.GetJSON(ctx, "/v1/metrics", &m)
	return m, err
}
