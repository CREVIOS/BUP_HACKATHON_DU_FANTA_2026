// The trained RL policy's action space, as the backend defines it (backend/internal/rl/rl.go):
// 0 waits; 1-12 = coverage target (2h/6h/12h) x planning mode.
const TARGETS = ["2h", "6h", "12h"];
const MODES = ["urgency", "captive-priority", "depot-headroom", "scarcity-aware"];

export function strategy(action: number): string {
  if (action <= 0 || action >= 13) return "wait";
  return `${TARGETS[Math.floor((action - 1) / 4)]} cover, ${MODES[(action - 1) % 4]}`;
}

export interface Option {
  action: number;
  strategy: string;
  probability: number;
}

// The policy's own distribution: softmax over the valid (masked) actions. Invalid actions get 0.
export function probabilities(logits: readonly number[] | null | undefined, mask: readonly boolean[] | null | undefined): Option[] {
  if (!logits || !mask || logits.length !== mask.length) return [];
  const valid = logits.map((l, i) => (mask[i] ? l : Number.NEGATIVE_INFINITY));
  const best = Math.max(...valid);
  if (!Number.isFinite(best)) return [];
  const exp = valid.map((l) => (Number.isFinite(l) ? Math.exp(l - best) : 0));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp
    .map((e, action) => ({ action, strategy: strategy(action), probability: e / sum }))
    .filter((o) => mask[o.action])
    .sort((a, b) => b.probability - a.probability);
}
