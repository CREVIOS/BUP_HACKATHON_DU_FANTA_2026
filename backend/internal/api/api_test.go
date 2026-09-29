package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/sim"
)

func TestAuthRoles(t *testing.T) {
	a := auth{operator: "op", admin: "ad"}
	for tok, want := range map[string]int{"": roleViewer, "Bearer nope": roleViewer, "Bearer op": roleOperator, "Bearer ad": roleAdmin, "op": roleViewer} {
		r := httptest.NewRequest("GET", "/", nil)
		if tok != "" {
			r.Header.Set("Authorization", tok)
		}
		if got := a.role(r); got != want {
			t.Errorf("%q: role %d want %d", tok, got, want)
		}
	}
	rec := httptest.NewRecorder()
	a.require(roleAdmin, func(w2 http.ResponseWriter, _ *http.Request) { t.Fatal("operator reached an admin handler") })(
		rec, withAuth(httptest.NewRequest("POST", "/", nil), "Bearer op"))
	if rec.Code != 401 {
		t.Fatalf("status %d want 401", rec.Code)
	}
	if (auth{}).role(httptest.NewRequest("GET", "/", nil)) != roleAdmin {
		t.Fatal("no tokens configured must mean auth off (dev mode)")
	}
}

func withAuth(r *http.Request, v string) *http.Request { r.Header.Set("Authorization", v); return r }

func TestValidateEventBlocksSimulatorFootguns(t *testing.T) {
	w := sim.World{
		Routes:   []sim.Route{{ID: "route-a"}},
		Stations: []sim.Station{{ID: "st-a"}},
		Depots:   []sim.Depot{{ID: "dp-a"}},
		Regions:  []sim.Region{{ID: "rg-a"}},
	}
	cases := map[string]struct {
		b       eventBody
		wantErr string
	}{
		"ok spike":         {eventBody{Type: "demand_spike", DurationTicks: 4, Parameters: map[string]any{"multiplier": 1.8, "region_ids": []any{"rg-a"}}}, ""},
		"ok disruption":    {eventBody{Type: "route_disruption", DurationTicks: 4, Parameters: map[string]any{"route_ids": []any{"route-a"}}}, ""},
		"multiplier 0":     {eventBody{Type: "demand_spike", DurationTicks: 4, Parameters: map[string]any{"multiplier": 0.0}}, "multiplier"},
		"empty route_ids":  {eventBody{Type: "route_disruption", DurationTicks: 4, Parameters: map[string]any{"route_ids": []any{}}}, "at least one id"},
		"unknown id":       {eventBody{Type: "station_outage", DurationTicks: 4, Parameters: map[string]any{"station_ids": []any{"st-x"}}}, "unknown id"},
		"wrong parameter":  {eventBody{Type: "route_disruption", DurationTicks: 4, Parameters: map[string]any{"route_ids": []any{"route-a"}, "multiplier": 2.0}}, "not used"},
		"unknown type":     {eventBody{Type: "meteor", DurationTicks: 4}, "unknown type"},
		"zero duration":    {eventBody{Type: "demand_spike", DurationTicks: 0}, "duration_ticks"},
		"shortfall factor": {eventBody{Type: "supply_shortfall", DurationTicks: 1, Parameters: map[string]any{"factor": 1.5}}, "factor"},
	}
	for name, c := range cases {
		errs := strings.Join(validateEvent(w, c.b), "; ")
		if c.wantErr == "" && errs != "" {
			t.Errorf("%s: unexpected errors %s", name, errs)
		}
		if c.wantErr != "" && !strings.Contains(errs, c.wantErr) {
			t.Errorf("%s: want error containing %q, got %q", name, c.wantErr, errs)
		}
	}
}
