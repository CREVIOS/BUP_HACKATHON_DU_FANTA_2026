"""Export the selected Maskable PPO actor for in-process Go inference, plus parity fixtures.

Run from the downloaded, hash-verified HF package root (crevious/fuelops-maskable-ppo-20260929):
  FUELOPS_BRIDGE=$PWD/training/bin/rlbridge python /path/to/rl/export_actor.py <repo>/backend/internal/rl

Writes actor.bin (float32 little-endian, layers in actor.json order), actor.json (shapes, provenance) and
testdata/parity.json (observations, masks and SB3 choose() actions). The critic is not exported: it is only
needed for PPO training, not for choosing an action.
"""
import hashlib, json, sys
from pathlib import Path
import numpy as np, torch
from sb3_contrib import MaskablePPO
from training.env import FuelEnv
from training.train import choose
from training.world import load_manifest

out = Path(sys.argv[1]); (out / "testdata").mkdir(parents=True, exist_ok=True)
torch.set_num_threads(1)
model = MaskablePPO.load("model.zip", device="cpu")
state = torch.load("weights/seed-11-policy.pth", map_location="cpu", weights_only=True)
order = ["mlp_extractor.policy_net.0.weight", "mlp_extractor.policy_net.0.bias",
         "mlp_extractor.policy_net.2.weight", "mlp_extractor.policy_net.2.bias",
         "action_net.weight", "action_net.bias"]
blob = b"".join(state[k].detach().cpu().numpy().astype("<f4").tobytes() for k in order)
(out / "actor.bin").write_bytes(blob)
meta = dict(repo="crevious/fuelops-maskable-ppo-20260929", revision="7be470b48653017e2d79195c848c2e89fdfe035b",
            checkpoint="model.zip", seed=11, promotion=False,
            source_sha256=hashlib.sha256(Path("weights/seed-11-policy.pth").read_bytes()).hexdigest(),
            actor_sha256=hashlib.sha256(blob).hexdigest(),
            layers=[dict(name=k, shape=list(state[k].shape)) for k in order],
            activation="tanh", tie_break="lowest valid action whose masked logit is within 1e-4 of the maximum")
(out / "actor.json").write_text(json.dumps(meta, indent=1) + "\n")

# Parity: every decision of one full episode per exact scenario manifest (4 x 576 observations).
rows = []
env = FuelEnv(horizon=576)
try:
    for name in ["baseline", "demand_spike", "supply_disruption", "final_combined"]:
        cfg = load_manifest(name)
        obs, _ = env.reset(seed=cfg["seed"], options={"fixed": True, "config": cfg, "reference_noise": True})
        for _ in range(576):
            mask = env.action_masks()
            with torch.no_grad():
                t, _ = model.policy.obs_to_tensor(obs)
                logits = model.policy.get_distribution(t, action_masks=mask).distribution.logits.cpu().numpy()[0]
            a = choose(model, obs, mask)
            valid = np.flatnonzero(mask); top = np.sort(logits[valid])[::-1]
            gap = float(top[0] - top[1]) if len(top) > 1 else 99.0
            rows.append(dict(scenario=name, obs=obs.tolist(), mask=mask.tolist(), action=int(a), gap=gap))
            obs, _, _, trunc, _ = env.step(a)
            if trunc: break
finally:
    env.close()
json.dump(rows, open("parity-full.json", "w"))  # full set stays with the package (5 MB)
# Committed fixture: the 24 closest decisions (hardest for float drift) + 24 spread across scenarios.
rows_sorted = sorted(rows, key=lambda r: r["gap"])
pick = rows_sorted[:24] + rows[:: max(1, len(rows) // 24)][:24]
for r in pick:
    r["obs"] = [float(np.float32(v)) for v in r["obs"]]
json.dump(pick, open(out / "testdata" / "parity.json", "w"))
from collections import Counter
print(json.dumps(dict(decisions=len(rows), actions=Counter(r["action"] for r in rows), min_gap=rows_sorted[0]["gap"],
                      actor_sha256=meta["actor_sha256"]), default=str))
