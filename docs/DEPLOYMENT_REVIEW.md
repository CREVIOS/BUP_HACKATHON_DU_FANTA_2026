# Infrastructure review and deployment plan

Reviewed 2026-09-29 against commit `533d814`, `infra/`, `deploy/`, `.github/workflows/`, Compose, and the backend runtime contract. This is a repository review, not confirmation of a running AWS environment. No AWS resources or GitHub settings were changed.

Follow-up: dependency pins, namespace ordering, application bootstrap gating, and the Prometheus Service URL are addressed by the first increment on `infra/deployment-readiness`. See [the implementation checklist](INFRA_WORK_PLAN.md) and [bootstrap guide](../infra/README.md). Findings below preserve the original review snapshot; remaining deployment blockers are still open.

Access follow-up: increment 2 removes public operator ingresses, restores Argo CD TLS, configures root-path localhost access, makes the Rollouts dashboard read-only for workloads, and restricts GitHub trust to an exact `main` subject. These are configuration changes with local validation; they have not been applied to a live environment. OIDC provider ownership, rollout reliability, and the remaining checklist items are still open.

**Verdict: keep the EKS direction, but fix the deployment and rollback gaps before the first public deployment.** `INFRA_DECISIONS.md` is currently a historical design with a partial EKS update; it is not an executable runbook.

## 1. What is sound

- EKS Auto Mode in Singapore, Argo CD, Argo Rollouts, and Prometheus are a coherent implementation of the team's Kubernetes choice. The Auto Mode ALB `IngressClass` / `IngressClassParams` API and shared ALB grouping match [AWS's documented configuration](https://docs.aws.amazon.com/eks/latest/userguide/auto-configure-alb.html).
- Private, encrypted RDS PostgreSQL 17; two AZs; one NAT; and Single-AZ RDS are reasonable explicit compromises for a short demo. They do not promise survival of every AZ failure.
- The simulator has one replica, `Recreate`, amd64 scheduling, and paused startup. Keeping simulator access behind the ingestor's concurrency limit is the right boundary.
- Image tags are commit SHAs, ECR is immutable, GitHub uses OIDC, and its release role only has ECR permissions. The migration hook and separate readiness/liveness probes are useful foundations.
- Keep local Compose as the judging baseline. Prove the application flow locally before using a cloud deployment as evidence of product readiness.

## 2. Findings that affect deployment

P1 means fix before public deployment or before claiming that the affected feature works. P2 means finish before the final rehearsal.

### P1 — first-apply namespace race

`infra/platform.tf:32` installs the platform chart after EKS alone. `deploy/platform/templates/ops-ingress.yaml:1` creates ingresses in `argocd`, `monitoring`, and `argo-rollouts`, while separate releases create those namespaces concurrently. On an empty cluster, installation can fail with a missing namespace.

Create namespaces explicitly before their dependants, or separate the base IngressClass/StorageClass from ops ingresses and install the latter after the controllers. This also needs a clean teardown dependency order. Helm lint cannot detect the race.

### P1 — ops consoles are published over HTTP

`deploy/platform/templates/alb.yaml:7` selects an internet-facing ALB. `ops-ingress.yaml` publishes Argo CD, Grafana, and Rollouts without a TLS listener/certificate or access restriction. `infra/platform.tf:102` disables Argo CD's server TLS. TLS termination at an ALB would be fine, but it is not configured here.

For the first deployment, keep these services private and use authenticated Kubernetes port-forwarding. If public ops access is required later, configure TLS and access control first. The Rollouts chart also defaults `dashboard.readonly` to false; enabling its dashboard is not an authentication boundary. [Upstream chart defaults](https://github.com/argoproj/argo-helm/blob/main/charts/argo-rollouts/values.yaml).

### P1 — readiness failures do not automatically abort

`deploy/charts/fuelops/templates/rollouts.yaml:12` omits `progressDeadlineAbort`. Its default is false: a canary that never becomes ready can become degraded without executing the claimed automatic abort. Configure an explicit progress deadline and abort behavior, and put a deadline on analysis Jobs. [Argo Rollouts specification](https://argoproj.github.io/argo-rollouts/features/specification/).

The first deployment has no previous stable revision. Establish a healthy baseline before attempting either rollback demonstration.

### P1 — canary checks can approve an untested candidate

`rollouts.yaml:2` smoke-tests intel at `/healthz`. `backend/internal/httpx/middleware.go:45` deliberately exempts health, version, and metrics endpoints from injected 500s. Intel currently exposes only those operational endpoints, so `CHAOS_500_PCT` cannot demonstrate an intel business-path rollback.

In `analysis.yaml:44`, absent error/traffic series become zero; the latency query also substitutes zero for an empty result. Missing telemetry can therefore look successful. Both queries include probe/scrape requests, diluting business error rates. The only generated workload is the short smoke Job; there is no sustained business traffic through the later pauses. A 60-request random 5% failure test allowing one error is also not deterministic.

Add a real intel request fixture when its endpoint exists. Assert response content as well as HTTP status: API `/api/state` currently returns 200 with `tick: null` when no snapshot exists. Exclude operational routes from business RED checks, require enough successful scrapes and business requests before promotion, and keep traffic running through the analysis window. Treat unavailable telemetry as inconclusive/failing after a bounded warm-up, not as healthy. Use a deterministic failing release to prove smoke abort, then separately prove a metric-triggered abort.

### P1 — HPA and GitOps both own API replicas

`observability.yaml:1` configures HPA for the API Rollout, but `rollouts.yaml:13` continuously declares four replicas. Argo CD enables self-healing and only ignores Service selectors (`infra/platform.tf:160`). It can restore four replicas after the HPA scales out.

Ignore `/spec/replicas` specifically for `argoproj.io/Rollout` named `api`, retaining `RespectIgnoreDifferences=true`, or omit that field once HPA owns it. Narrow the Service-selector ignores to the services Rollouts actually manages. [Argo CD diff customization](https://argo-cd.readthedocs.io/en/stable/user-guide/diffing/).

### P1 — the release job does not establish deployment success

`.github/workflows/deploy.yml:61` ends after committing and pushing image tags. A failed migration, rejected manifest, or aborted rollout can leave the workflow green. Argo CD also tracks `main` directly (`infra/platform.tf:155`): a chart/template edit can sync as soon as it reaches `main`, before the release workflow completes its checks.

Promote a tested chart revision and image pair to a controlled deployment revision/branch. Wait for that exact revision to sync, its migration to succeed, and both Rollouts to become healthy; report timeout/abort as failure and retain diagnostic artifacts. Use an authenticated status channel, with narrowly scoped read access if CI needs it. Keep Terraform application under a separate operator/infra role—the current ECR role intentionally cannot apply infrastructure.

Also make partially completed releases rerunnable against immutable ECR tags, verify the bot can update the chosen deployment branch under branch protection, and pin/install the expected `yq` implementation.

### P2 — this is basic canary traffic, not isolated pre-traffic validation

`rollouts.yaml:34` sets weight before smoke analysis; `web.yaml:43` routes to the generic `api` Service, whose selector matches stable and canary pods. There is no `trafficRouting` block. This is valid basic canary behavior, but ready candidate pods can receive user traffic before smoke passes. Weights approximate replica proportions; 25% is not precise with only two intel replicas. [Argo basic canary behavior](https://argoproj.github.io/argo-rollouts/features/canary/).

For this event, retain basic canary and describe its exposure honestly. If zero user traffic before validation is required, use active/preview blue-green Services with pre-promotion analysis, or verify a supported traffic-router integration. Do not assume Argo's AWS Load Balancer Controller integration automatically works with the separate Auto Mode controller.

### P2 — monitoring is installed, but evidence is incomplete

`observability.yaml:59` expects `dashboards/*.json`; none exist and the rendered ConfigMap has no data. `RolloutAborted` depends on `rollout_info`, but `infra/platform.tf:80` does not enable Rollouts controller metrics or its ServiceMonitor, which are disabled by default in the upstream chart. There is no configured app-log collector, notification receiver, or local Prometheus/Grafana stack matching the decisions document.

Deliver one populated dashboard, verify the controller metric and labels actually exist, wire a notification destination if claimed, and choose an explicit log/evidence export path. Prometheus retention `2d` is not persistence: no storage claim is configured. For an eight-hour demo, ephemeral monitoring is acceptable only with planned exports and an understood restart loss.

### P2 — several application resilience promises are still future work

`backend/internal/ingestor/ingestor.go:33` says the outbox/advisory-lock worker is TODO, while `ingestor.yaml:2` claims the lock exists. `backend/internal/intel/intel.go:13` is still a placeholder for recommendations. The API currently has state/status endpoints, no advertised auth/approval/fallback allocator, and requires DB connectivity (`api.go:29`, `api.go:48`). A DB outage does not currently serve a cached read-only snapshot as documented.

Treat cloud boot and the full product demonstration as separate acceptance gates. Finish and test these features before marking their resilience claims implemented. `Recreate` helps normal updates but does not replace writer fencing for duplicate-process or partition cases.

## 3. Reconcile the decisions document

Rewrite the active decision table and architecture instead of adding another overriding paragraph. Archive the ECS rationale and review log as historical. `docs/PLAN.md` also still says to cut Kubernetes and build ECS; update its DevOps track at the same time.

| Topic | Current repository truth / correction |
|---|---|
| Compute / region | EKS Auto Mode, `ap-southeast-1`; Kubernetes `1.36` is listed in [AWS's supported-version table](https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html). Confirm availability in the target region during preflight. |
| Backend / frontend | Go 1.26; four entrypoints including `migrate`; two images. Frontend is currently a Vite/JavaScript scaffold in nginx, not an embedded React/TS SPA. |
| Discovery / deploy | Kubernetes Services; Argo CD and Rollouts; migration PreSync Job. No ECS, Service Connect, smoke Lambda, or ECS task revisions. |
| Telemetry | Native Prometheus Go client and kube-prometheus-stack; app OTLP/CloudWatch export is not implemented. |
| Secrets | Terraform-generated RDS/JWT secrets and Kubernetes Secret; values and Argo deploy private key reside in Terraform state. No Secrets Manager resource or RDS-managed master password. Document this event-only choice and tightly restrict state access, or implement the promised secret system. |
| Account / state | Account-specific image repositories and an existing TalentForge S3 state bucket in `eu-west-3`, with a separate `fuelops-sg/terraform.tfstate` key. Account isolation is a decision still to confirm. The different backend region is not itself a defect. |
| LLM | Jev configuration is present; the old Bedrock architecture is not provisioned. |
| Cost / timing | The old `$2 / 8h` Fargate estimate and 15–20 minute cold-start claim do not describe this stack. Re-estimate EC2 nodes, Auto Mode charges, EKS, ALB, NAT, RDS, storage, IPv4, and data transfer; measure a cold rehearsal. [AWS EKS pricing](https://aws.amazon.com/eks/pricing/) bills Auto Mode in addition to EC2 and the cluster fee. |

## 4. Ordered deployment plan

### Phase A — prepare a deployable revision

1. Resolve the P1 findings above. Pin Helm chart versions and tested Terraform module versions; the provider lockfile does not lock remote module or Helm chart versions.
2. Define bootstrap ownership separately from the disposable demo. Check for an existing GitHub OIDC provider; reuse it through a data source/shared bootstrap rather than creating a duplicate or putting a shared provider under demo teardown ownership. Restrict the release-role subject to the deployment branch/environment instead of `repo:...:*`. [GitHub OIDC guidance](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).
3. Separate AWS foundation and in-cluster installation into explicit stages, preferably separate Terraform roots/states. The Helm/Kubernetes providers need a reachable cluster. Add a switch/stage to leave the Argo application disabled until valid images exist.
4. Add CI rendering/schema validation for both charts, scan both images and repository secrets, and add a fresh-Compose integration test. Retain Go vet/race tests. Run a deterministic simulator regression once the application flow exists; do not claim that gate from the current CI.
5. Choose app access (TLS/domain or private preview), bound Auto Mode capacity for the rehearsal, and add topology spreading/PDBs for replicated stateless services if AZ/drain resilience is claimed. Add pod network policy if “only the ingestor can access the simulator” must be enforced beyond application code.

**Gate:** green CI for one reproducible revision; rendered manifests reviewed; docs describe actual behavior; no public ops endpoints by default.

### Phase B — account preflight and AWS foundation

Confirm the deployment account and operator profile, access to the existing state bucket/lock object, GitHub admin token permissions for repo variables/deploy keys, EKS/EC2 quotas, and target-region RDS availability. Do not print credentials into evidence.

Useful read-only preflight commands:

```bash
aws sts get-caller-identity
aws eks describe-cluster-versions --region ap-southeast-1
aws rds describe-orderable-db-instance-options \
  --region ap-southeast-1 --engine postgres --db-instance-class db.t4g.small \
  --query 'OrderableDBInstanceOptions[].EngineVersion' --output text
aws iam list-open-id-connect-providers
```

Initialize the chosen backend, review a saved Terraform plan for the foundation, then apply that reviewed plan as the deployment action. Confirm that existing TalentForge infrastructure is outside its ownership. Verify EKS access, amd64 node provisioning, private RDS reachability from a pod, ECR repositories, and GitHub OIDC assumptions before proceeding.

**Gate:** healthy cluster and DB, predictable state ownership, images can be pushed using the release role.

### Phase C — images, platform, then first application sync

1. Build, scan, and push backend/web images from the same tested commit. Record their digests. Replace both `bootstrap` tags with real tags before enabling app sync; current CI only publishes SHA tags.
2. Install namespaces and base cluster resources, then pinned Argo Rollouts, monitoring, metrics-server, and Argo CD. Verify CRDs, controller readiness, repository access, and HPA metrics. Keep ops access via port-forward initially.
3. Populate scoped app secrets; enable the Argo application against the promoted revision. Watch the migration Job to completion, followed by simulator, ingestor, API/intel, and web readiness. Add sync waves if service ordering is required; the current chart does not enforce intel → API → ingestor.
4. Check direct pod/Service health, ALB target health, the UI and `/api/state`, ingestor snapshots, and internal `/version` values. `/version` is not currently an externally routed API path, so verify it internally or add a documented public version route.

**Gate:** the exact intended SHA serves traffic; valid snapshots arrive; Prometheus sees app and rollout metrics; no pending/crash-looping pods; the first stable revision exists.

### Phase D — prove rollback and operational behavior

1. Deploy a new candidate with `FAIL_HEALTH=true`. Verify bounded abort, continued stable traffic, a failed deployment status, and captured events/AnalysisRuns.
2. From a restored healthy baseline, test deterministic business-request failure and a separate metrics-triggered failure under sustained traffic. Confirm telemetry loss cannot cause promotion. Then remove the failure through the controlled GitOps path. An abort preserves live stable pods; it does not revert the bad Git commit.
3. Verify API autoscaling without Argo resetting replicas, healthy upgrade/migration compatibility with the previous image, and full UI/API compatibility when only API/intel roll back. The web Deployment has no equivalent analysis rollback today.
4. Exercise simulator fault handling and intel failure once the corresponding product features exist. Run load against API paths, preserving the simulator concurrency cap. Save dashboard panels, load summaries, rollout status, logs, and build identifiers.

**Gate:** one successful upgrade plus both failure mechanisms have reproducible evidence, CI accurately reports failure, and the application demo works from a fresh local clone.

### Phase E — rehearsal, event, and teardown

Perform a complete cold provision → deploy → rollback → export → destroy rehearsal before the event. Use the measured provisioning duration plus contingency for the event start time; do not depend on the old 20-minute estimate.

Before teardown, export the decision audit/database, dashboard evidence, application logs, k6 output, and release metadata. Disable automated reconciliation in the declared configuration, remove application/ops ingresses and workloads while controllers and the Kubernetes API remain available, and wait for ALB/target-group cleanup. Then destroy platform and AWS foundation in dependency order. Preserve shared state/OIDC infrastructure.

Verify no demo ALBs, EC2 nodes, NAT gateways, RDS instances, EBS volumes, or allocated public IPs remain. Check retained logs/backups/artifacts separately; deleting the cluster alone does not establish zero remaining charges. The current RDS configuration skips a final snapshot and ECR allows forced deletion, so exports must precede teardown.

## 5. Validation performed

- `docker compose config --quiet`: passed. This validates configuration only; the full stack was not started.
- Helm 3.19.0 lint: both charts passed; template rendering produced 21 application resources and 6 platform resources. Inspection confirmed empty dashboard data and omitted traffic-router/progress-abort settings.
- Terraform 1.13.5 `fmt -check -recursive`: passed.
- Backend `go test -race ./...`: passed after allowing local test-server sockets outside the sandbox. `go vet ./...`: passed.
- Terraform `init -backend=false` and `validate`: passed in a temporary copy, using the committed provider versions and resolved EKS module 21.26.0 / VPC module 6.7.3. Linux provider checksums were added only to the temporary lockfile. Validation required local provider communication sockets outside the sandbox; the repository lockfile and remote state were untouched.
- No live Terraform plan/apply, AWS inventory, Kubernetes API schema validation, image push, rollout rehearsal, or cost measurement was performed. These remain deployment gates, not completed checks.
