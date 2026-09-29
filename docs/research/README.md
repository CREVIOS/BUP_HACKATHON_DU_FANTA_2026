Research artifacts behind ../PLAN.md
- guide.txt                 text of the official PDF guide
- claude_findings.md        findings list given to Codex for critique
- codex_independent.md      Codex independent review of guide + simulator source
- codex_critique.md         Codex adversarial review of claude_findings.md
- bounds.py                 demand vs total-fuel ceiling per scenario
- thresh.py                 concurrency probe: python3 thresh.py <concurrency> /v1/stations  (WARNING: >=15 hangs the sim)
- traps.py                  live reproduction of fuel-loss traps (resets the sim)
- greedy.py                 naive policy baseline: python3 greedy.py 576  (resets the sim)
Extract simulator source:  docker create --name s asifmahmoud414/bup-fuel-supply-simulator:1.0.0 && docker cp s:/app ./simsrc && docker rm s
