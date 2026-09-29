// Package rl runs the trained Maskable PPO policy (crevious/fuelops-maskable-ppo-20260929, seed 11) in-process,
// in shadow mode: it reads the live world, asks the shared planner for the 13 candidate plans and the 600-feature
// observation, picks a plan with the actor, and reports it. It never submits anything.
package rl

import (
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
)

// actor.bin is the actor MLP exported from the hash-verified package by rl/export_actor.py:
// float32 little-endian, in the order listed in actor.json. The critic is not needed to choose an action.
//
//go:embed actor.bin
var actorBin []byte

//go:embed actor.json
var actorJSON []byte

const (
	obsDim  = 600
	hidden  = 128
	actions = 13
	// tieEps reproduces training.train.choose: the lowest valid action whose masked logit is within 1e-4 of the max.
	tieEps = 1e-4
)

// Meta is the provenance recorded at export time.
type Meta struct {
	Repo         string `json:"repo"`
	Revision     string `json:"revision"`
	Checkpoint   string `json:"checkpoint"`
	Seed         int    `json:"seed"`
	Promotion    bool   `json:"promotion"`
	SourceSHA256 string `json:"source_sha256"`
	ActorSHA256  string `json:"actor_sha256"`
	Activation   string `json:"activation"`
	TieBreak     string `json:"tie_break"`
}

// Actor is policy_net (Linear 600→128, tanh, Linear 128→128, tanh) followed by action_net (Linear 128→13).
type Actor struct {
	w1, b1, w2, b2, w3, b3 []float32
	Meta                   Meta
}

// LoadActor parses the embedded weights; it fails loudly on any size or provenance mismatch.
func LoadActor() (*Actor, error) {
	var a Actor
	if err := json.Unmarshal(actorJSON, &a.Meta); err != nil {
		return nil, fmt.Errorf("actor.json: %w", err)
	}
	sizes := []int{hidden * obsDim, hidden, hidden * hidden, hidden, actions * hidden, actions}
	total := 0
	for _, n := range sizes {
		total += n
	}
	if len(actorBin) != 4*total {
		return nil, fmt.Errorf("actor.bin has %d bytes, want %d", len(actorBin), 4*total)
	}
	vals := make([]float32, total)
	for i := range vals {
		vals[i] = math.Float32frombits(binary.LittleEndian.Uint32(actorBin[4*i:]))
	}
	parts := make([][]float32, len(sizes))
	for i, n := range sizes {
		parts[i], vals = vals[:n], vals[n:]
	}
	a.w1, a.b1, a.w2, a.b2, a.w3, a.b3 = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]
	return &a, nil
}

// Logits returns the unmasked action_net output for one observation, computed in float32 like the policy.
func (a *Actor) Logits(obs []float64) ([actions]float32, error) {
	var out [actions]float32
	if len(obs) != obsDim {
		return out, fmt.Errorf("observation has %d features, want %d", len(obs), obsDim)
	}
	x := make([]float32, obsDim)
	for i, v := range obs {
		x[i] = float32(v)
	}
	h1 := layer(a.w1, a.b1, x, hidden, true)
	h2 := layer(a.w2, a.b2, h1, hidden, true)
	copy(out[:], layer(a.w3, a.b3, h2, actions, false))
	return out, nil
}

// Choose picks the action exactly as the evaluated policy did: masked argmax with a deterministic near-tie rule.
// Action 0 (WAIT) is always valid.
func (a *Actor) Choose(obs []float64, mask [actions]bool) (int, [actions]float32, error) {
	logits, err := a.Logits(obs)
	if err != nil {
		return 0, logits, err
	}
	if !mask[0] {
		return 0, logits, fmt.Errorf("invalid mask: WAIT must always be valid")
	}
	best := float32(math.Inf(-1))
	for i, ok := range mask {
		if ok && logits[i] > best {
			best = logits[i]
		}
	}
	for i, ok := range mask {
		if ok && logits[i] >= best-tieEps {
			return i, logits, nil
		}
	}
	return 0, logits, nil
}

func layer(w, b, x []float32, n int, tanh bool) []float32 {
	out := make([]float32, n)
	m := len(x)
	for i := range n {
		s := b[i]
		row := w[i*m : (i+1)*m]
		for j, v := range x {
			s += row[j] * v
		}
		if tanh {
			s = float32(math.Tanh(float64(s)))
		}
		out[i] = s
	}
	return out
}
