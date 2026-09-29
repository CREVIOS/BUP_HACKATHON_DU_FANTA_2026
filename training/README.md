# Offline fuel-controller experiments

Implemented: shared feasible Go planner, 600-feature/13-action Maskable PPO,
imitation warm-start, exact simulator manifests, bounded multi-seed training,
and paired held-out evaluation. No automatic live-policy promotion.

Read [the mathematics and decisions](../docs/RL_MATH_AND_DECISIONS.md).
Current engine-parity evidence: [four exact scenarios](../evidence/rl/exact-manifest-parity-v3.json).
The earlier design document includes proposed features not yet implemented.

From the repository root, with Go and a Python environment containing the
versions in `training/requirements.lock`:

```sh
mkdir -p training/bin
go -C backend build -o ../training/bin/rlbridge ./cmd/rlbridge
go -C backend test -count=1 ./...
python -m unittest discover -s training/tests -v
```

Build on the machine where the binary runs. For a Linux/amd64 GPU server when
cross-compiling from a Mac:

```sh
GOOS=linux GOARCH=amd64 go -C backend build -o ../training/bin/rlbridge-linux ./cmd/rlbridge
# Copy the repository and Linux binary to the server, then run these on Linux:
export FUELOPS_BRIDGE="$PWD/training/bin/rlbridge-linux"
python -m unittest discover -s training/tests -v
python -m training.launch --run-dir runs/experiment-unique-name --seeds 11 23 37 --steps 3000000 --envs 8 --max-hours 0.8
```

The launcher targets the Linux binary, securely prompts for a W&B key, and
starts a detached bounded sweep. Use a fresh run directory for each experiment.
The target is 3M transitions per seed; time limits can stop earlier. Status is
in `status.json`, metrics in each seed's `metrics.jsonl`, links in
`wandb_url.txt`, and frozen evaluation in `held-out.json`.

Do not commit credentials, binaries, model checkpoints, or W&B runtime folders.
Checkpoints are W&B artifacts; Git stores code and nonsecret evidence.
The supplied lock records the tested GPU environment, not a universal CUDA
installation recipe. Verify a compatible PyTorch/CUDA build on your machine.
