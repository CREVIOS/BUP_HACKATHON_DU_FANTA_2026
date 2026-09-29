// rlbridge provides the same planner to Python training and Go serving.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"github.com/CREVIOS/BUP_HACKATHON_DU_FANTA_2026/internal/planner"
	"os"
)

type request struct {
	SchemaVersion int                     `json:"schema_version"`
	Snapshots     []planner.Snapshot      `json:"snapshots"`
	History       [][]planner.DemandRow   `json:"history"`
	Reservations  [][]planner.Reservation `json:"reservations"`
}
type result struct {
	Features []float64        `json:"features"`
	Plans    [13]planner.Plan `json:"plans"`
	Mask     [13]bool         `json:"mask"`
	Error    string           `json:"error,omitempty"`
	Baseline int              `json:"baseline_action"`
}

func main() {
	scan := bufio.NewScanner(os.Stdin)
	scan.Buffer(make([]byte, 65536), 16<<20)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	for scan.Scan() {
		var req request
		var results []result
		err := json.Unmarshal(scan.Bytes(), &req)
		if err == nil && req.SchemaVersion != planner.SchemaVersion {
			err = fmt.Errorf("unsupported schema")
		}
		if err != nil {
			json.NewEncoder(out).Encode(map[string]any{"error": err.Error()})
			out.Flush()
			continue
		}
		for i, s := range req.Snapshots {
			var h []planner.DemandRow
			var pending []planner.Reservation
			if i < len(req.History) {
				h = req.History[i]
			}
			if i < len(req.Reservations) {
				pending = req.Reservations[i]
			}
			r := result{}
			in, e := planner.Prepare(s, h, pending)
			if e == nil {
				r.Plans, r.Mask, e = planner.Candidates(in)
			}
			if e == nil {
				r.Features, e = planner.Features(in, r.Plans, r.Mask)
				r.Baseline = planner.Baseline(in, r.Plans, r.Mask, 8)
			}
			if e != nil {
				r.Error = e.Error()
			}
			results = append(results, r)
		}
		json.NewEncoder(out).Encode(map[string]any{"schema_version": planner.SchemaVersion, "results": results})
		out.Flush()
	}
	if err := scan.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
