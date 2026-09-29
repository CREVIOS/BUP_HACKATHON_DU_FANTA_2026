package planner

import (
	"math"
	"testing"
)

func fixture() Snapshot {
	s := Snapshot{Epoch: 1, Tick: 0, Minute: 0, TickMinutes: 15}
	for i := range 4 {
		s.StationOpen[i] = true
		s.Multiplier[i] = 1
		for f := range 3 {
			s.Capacity[i][f] = 10000
			s.Stock[i][f] = 1000
		}
	}
	for d := range 2 {
		s.DepotOpen[d] = true
		s.Dispatch[d] = 1500
		for f := range 3 {
			s.Depot[d][f] = 20000
			s.DepotCapacity[d][f] = 90000
		}
	}
	for r := range 6 {
		s.RouteOpen[r] = true
	}
	return s
}

func TestPrepareReservations(t *testing.T) {
	s := fixture()
	s.Allocations = []Allocation{{Key: "a", Depot: 0, Station: 0, Route: 0, Fuel: 0, Quantity: 1000, Created: 0, ETA: 2, Status: "IN_TRANSIT"}}
	pending := []Reservation{{Key: "a", Epoch: 1, Depot: 0, Station: 0, Route: 0, Fuel: 0, Quantity: 1000}, {Key: "b", Epoch: 1, Depot: 0, Station: 0, Route: 0, Fuel: 0, Quantity: 500}}
	in, err := Prepare(s, nil, pending)
	if err != nil {
		t.Fatal(err)
	}
	if in.Inbound[0][0] != 1500 || in.Available[0][0] != 19500 || in.DispatchLeft[0] != 0 {
		t.Fatalf("double deduction or forgotten reservation: %+v", in)
	}
	s.Stock[0][0] = math.NaN()
	if _, err = Prepare(s, nil, nil); err == nil {
		t.Fatal("NaN accepted")
	}
}

func TestCandidateSafety(t *testing.T) {
	s := fixture()
	s.Stock[0][0] = 6000
	s.Allocations = []Allocation{{Key: "a", Depot: 0, Station: 0, Route: 0, Fuel: 0, Quantity: 3000, Created: -1, ETA: 2, Status: "IN_TRANSIT"}}
	in, err := Prepare(s, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	plans, mask, err := Candidates(in)
	if err != nil {
		t.Fatal(err)
	}
	if !mask[0] {
		t.Fatal("WAIT masked")
	}
	for i, p := range plans {
		if !mask[i] {
			continue
		}
		var sent [2]float64
		seen := map[[2]int]bool{}
		for _, a := range p.Shipments {
			k := [2]int{a.Station, a.Fuel}
			if seen[k] {
				t.Fatal("duplicate station fuel")
			}
			seen[k] = true
			sent[a.Depot] += a.Quantity
			if a.Station == 0 && a.Fuel == 0 && a.Quantity > 1000 {
				t.Fatal("inbound capacity ignored")
			}
		}
		for _, q := range sent {
			if q > 1500.00001 {
				t.Fatal("cross fuel dispatch exceeded")
			}
		}
		if err := Validate(in, p); err != nil {
			t.Fatal(err)
		}
	}
}

func TestWaitAndFeatures(t *testing.T) {
	s := fixture()
	for i := range 4 {
		s.Stock[i] = s.Capacity[i]
	}
	in, _ := Prepare(s, nil, nil)
	p, m, err := Candidates(in)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, b := range m {
		if b {
			n++
		}
	}
	if n != 1 || !m[0] {
		t.Fatalf("duplicates not masked: %v", m)
	}
	x, err := Features(in, p, m)
	if err != nil || len(x) == 0 {
		t.Fatal("missing features", err)
	}
	s.Events = []Event{{Kind: "route_disruption", Start: 0, End: 4, Status: "SCHEDULED", Routes: []int{0}}}
	in, _ = Prepare(s, nil, nil)
	if !in.Blocked[0] {
		t.Fatal("departure boundary not blocked")
	}
}

func TestBaselineBatchesAndPrepositions(t *testing.T) {
	s := fixture()
	for i := range 4 {
		s.Stock[i] = s.Capacity[i]
	}
	in, _ := Prepare(s, nil, nil)
	p, m, _ := Candidates(in)
	if Baseline(in, p, m, 8) != 0 {
		t.Fatal("baseline should wait when stocked")
	}
	s.Stock[0][0] = 100
	in, _ = Prepare(s, nil, nil)
	p, m, _ = Candidates(in)
	if Baseline(in, p, m, 8) == 0 {
		t.Fatal("baseline ignored imminent shortage")
	}
}
