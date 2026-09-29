# Infrastructure implementation checklist

Branch: `infra/deployment-readiness`, created from `main` at `533d814`.

Scope: implement the deployment-readiness fixes in [DEPLOYMENT_REVIEW.md](DEPLOYMENT_REVIEW.md), reconcile the architecture docs, and prepare a reproducible deployment. Checked items are implemented and locally verified; live deployment/rehearsal gates remain separate.

Keep EKS Auto Mode in Singapore, private RDS, Argo CD, basic Argo Rollouts canaries, and local Compose as the judging baseline. The chosen access update exposes FuelOps and authenticated Argo CD on their `hemal.me` HTTPS hostnames; see [HTTPS setup](HTTPS_SETUP.md). Implement the following in order as small commits.

## 1. Pin dependencies and make bootstrap predictable

Files: `infra/main.tf`, `infra/platform.tf`, `infra/variables.tf`, `infra/versions.tf`, `infra/outputs.tf`, `deploy/platform/`, `.github/workflows/ci.yml`.

- [x] Exact-pin the EKS module to `21.26.0` and VPC module to `6.7.3`, the versions resolved during the static review. These still need a live rehearsal.
- [x] Pin and render metrics-server `3.14.0`, kube-prometheus-stack `91.8.1`, argo-rollouts `2.43.2`, argo-cd `10.9.2`, and argocd-apps `2.0.5` against Kubernetes `1.36.0`. Live compatibility remains unverified.
- [x] Pin and render Tempo chart `2.4.0` / Tempo `2.10.8` from the maintained community repository. Check actual mock-plan Helm values, package digests, Collector/Tempo ports, Grafana datasource discovery/RBAC, and tracing enabled/disabled rendering in CI.
- [x] Reconcile main's linked datasources, metrics generator, logs, and dashboard. Pin/render Loki `7.3.0` and OTel log collector `0.173.1`; verify log routing and the Auto Mode storage dependency.
- [ ] Verify Collector → Tempo delivery, Grafana datasource provisioning/querying, and Collector metric scraping during the live rehearsal.
- [x] Retain existing provider hashes and add Linux checksums. Pin CI to Terraform `1.13.5` / Helm `3.19.0`; initialize with a read-only lockfile.
- [x] Create namespaces explicitly and make releases depend on them. Keep the application gate downstream of controller readiness; step 2 removes operator ingress from the platform chart.
- [x] Default the Argo application to disabled. Require full SHA tags through schema validation when Argo renders the Git chart; actual ECR image existence remains a preflight check.
- [ ] Define explicit foundation → platform → application bootstrap stages and reverse teardown order. Prefer separate AWS/platform roots; inspect existing remote state before moving resource ownership and prepare state migration if anything is already managed.

Completion: each Terraform root validates, charts render with pinned dependencies, the documented bootstrap has no dependency on unavailable namespaces/images, and existing resources are not accidentally planned for replacement.

Increment 1 implements the checked items above, with mocked Terraform bootstrap/activation tests and Helm image-validation checks in CI. It also fixes the app's Prometheus URL to match the pinned chart's rendered Service. See [infra/README.md](../infra/README.md) for exact versions, adoption steps, and validation commands. No live plan was run, so replacement risk still needs account/state inspection before applying. Root splitting remains pending.

The latest observability merge centralizes all linked Grafana datasources in Terraform's monitoring release; app dashboards remain in `fuelops`. Collector ports match their listeners, and application activation waits for Tempo and platform logging. Tempo remains ephemeral with 24-hour retention; Loki uses a 10 GiB gp3 PVC. Merging the PR and deployment remain deferred. Step 2 supports shared GitHub OIDC provider reuse; workload secret scope is the next code increment, followed by deployment-specific image configuration.

## 2. Correct access defaults and resource ownership

Files: `infra/github.tf`, `infra/platform.tf`, `infra/variables.tf`, `deploy/platform/templates/ops-ingress.yaml`, `deploy/charts/fuelops/templates/_helpers.tpl`, `README.md`.

- [x] Remove legacy operator ingresses and document localhost access. The later user-selected HTTPS configuration publishes authenticated Argo CD on `argocd.hemal.me`; Grafana and Rollouts remain private.
- [x] Wire the two existing ACM certificate ARNs to Auto Mode, with hostname routing and HTTP-to-HTTPS redirects for FuelOps/Argo CD. Support opting out of public Argo ingress and document Cloudflare records.
- [ ] Verify certificate issuance/coverage, live SNI selection, redirects, DNS, and Argo login during the deployment rehearsal.
- [x] Make the Rollouts dashboard read-only for workloads. Keep Argo CD/Grafana authentication enabled and restore Argo CD server TLS.
- [x] Restrict both GitHub OIDC roles to the repository's exact `main`-branch subject. Preserve `main`'s configured immutable prefix, allow a validated exact-subject override, and restrict manual dispatches to `main` too.
- [x] Support reuse of an existing account-level GitHub OIDC provider through a data source. Preserve existing managed state with a moved block, guard deletion, and document the handoff; actual account ownership and state handoff remain deployment prerequisites.
- [ ] Document the current secret model: encrypted Terraform state plus Kubernetes Secrets. Limit each workload to secrets it uses; distinguish this from a future Secrets Manager integration.
- [ ] Wire the operator API's `OPERATOR_TOKEN`/`ADMIN_TOKEN` into the API workload before public deployment. Both unset enables admin access for every caller; the current JWT/seed-user Secret entries do not configure these tokens.
- [ ] Make account-specific image repositories/configuration derive from the chosen deployment inputs rather than assuming the hard-coded account everywhere.

Completion: rendering publishes only the configured FuelOps/Argo HTTPS ingresses, release trust is narrowly scoped, shared identity/state resources survive demo teardown, and operators have authenticated public Argo access plus a working private access procedure.

Increment 2 implements the three access items above. Mocked Terraform plans and chart rendering cover the configured defaults; live port-forward/login checks, ALB rule removal, and OIDC assumption still require the deployment rehearsal. The ownership follow-up adds an existing-provider ARN input, issuer/audience/account validation, both-role trust checks, deletion protection, and a persistent workflow repository variable. The [OIDC handoff procedure](../infra/README.md#shared-github-oidc-ownership) must be completed before teardown if the provider is already managed here. Workload secret scope and account-specific image configuration remain open, so this step is not yet complete. See [private operator access](../infra/README.md#private-operator-access) for commands and existing-environment effects.

Merge integration with `main` preserves its separate Terraform role/EKS access entries, removal of the GitHub provider, scanner layer-read permission, Next.js frontend, and published image tags. The platform chart advances to `0.3.0` so private access supersedes `main`'s separate public ops ALB. PR checks remain credential-free; live Terraform runs manually from `main` and exposes application activation/revision inputs. Frontend CI uses its pinned pnpm version/lockfile, and the web chart targets the Next.js image's port 3000.

## 3. Make rollout checks and HPA reliable

Files: `deploy/charts/fuelops/templates/rollouts.yaml`, `analysis.yaml`, `observability.yaml`, `values.yaml`, `infra/platform.tf`; smoke/load fixtures under `deploy/` or `scripts/`.

- [ ] Add explicit progress deadlines and automatic abort for an unready candidate; bound migration/analysis Jobs so failures terminate predictably.
- [ ] Ignore API Rollout `/spec/replicas` in Argo CD while HPA owns it. Limit selector ignores to Rollouts-managed stable/canary Services.
- [ ] Smoke-test a real API response, including a non-null snapshot and expected fields; a 200 status alone is insufficient.
- [ ] Exclude health, metrics, and version routes from business RED queries. Require a minimum business-request volume, fresh scrapes, and enough warm-up time before promotion.
- [ ] Fail or stop promotion when telemetry remains missing; keep representative canary traffic running through the analysis window.
- [ ] Add separate reproducible checks for readiness failure, smoke failure, and metric-triggered abort. Each starts from a healthy stable revision.
- [ ] Keep the basic-canary traffic model explicit: ready candidate pods may receive user traffic before smoke completes; weights approximate replica proportions.
- [ ] Add intel's business-request fixture once its endpoint exists. Until then, describe its checks as readiness-only and do not claim business-error rollback coverage.

Completion: meaningful render/schema checks and analysis-query fixtures pass locally/CI. Live proof remains a deployment gate: unhealthy candidates abort, missing telemetry cannot approve promotion, and HPA scaling persists without GitOps resetting it.

## 4. Make CI promote and verify the tested release

Files: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `infra/github.tf`, `infra/platform.tf`, `infra/variables.tf`, release scripts.

- [ ] Use a CI-controlled deployment branch, proposed name `deploy/demo`, that Argo CD tracks. This is separate from the development branch `infra/deployment-readiness`.
- [ ] Promote the tested chart content and exact backend/web image pair together only after CI passes. Ordinary chart commits on `main` must not bypass this gate.
- [ ] Make publication rerunnable after partial success with immutable ECR tags; preserve the identity of the tested artifacts.
- [ ] Pin/install release tooling, scan both images and repository secrets, and add chart rendering/schema checks plus a bounded fresh-Compose smoke test.
- [ ] Provide a narrowly scoped authenticated deployment-status reader. Wait for the exact promoted revision, migration success, and healthy Rollouts; fail CI on abort/timeout and upload diagnostics.
- [ ] Document how to restore the known-good GitOps revision after an abort. Account for the web image and ingestor as well as API/intel compatibility.
- [ ] Keep infrastructure application separate from the image publisher role. Ensure infra-only changes run validation; define the reviewed-plan application procedure.

Completion: CI cannot report successful deployment merely because a Git push succeeded; failed checks cannot reach the deployment branch; failed releases produce actionable artifacts. Live branch protection, OIDC, and status access are verified during preflight.

## 5. Finish monitoring evidence and reconcile documentation

Files: `infra/platform.tf`, `deploy/charts/fuelops/templates/observability.yaml`, new `deploy/charts/fuelops/dashboards/`, `docs/INFRA_DECISIONS.md`, `docs/PLAN.md`, `README.md`.

- [x] Preserve main's Rollouts/Argo CD metrics and ServiceMonitors with the monitoring CRD dependency.
- [x] Preserve and render main's FuelOps operations dashboard and verify Grafana discovers its ConfigMap.
- [ ] Confirm the dashboard's panels against live data and the actual metric/labels used by the aborted-rollout alert.
- [ ] Enable and verify Loki compactor retention cleanup; the inherited 48-hour limit alone does not enforce log deletion. Review migration to the Loki community chart separately.
- [ ] Define log and monitoring export commands and retention. Configure an alert receiver if notifications are part of the promised demo; otherwise document the limitation.
- [ ] Rewrite the active architecture/decision table for EKS/Singapore, two images, Kubernetes Services, Prometheus, the current secret model, and Jev configuration. Archive superseded ECS decisions.
- [ ] Update the DevOps track in `PLAN.md` and add bootstrap, private ops access, release, rollback, evidence export, and teardown instructions to `README.md`.
- [ ] Mark backend auth, advisory-lock/outbox work, intelligence endpoints, and DB read-only fallback as pending until implemented and tested.
- [ ] Replace the old cost/timing claims with a budget worksheet and measured rehearsal results when available; do not invent a new fixed estimate.

Completion: dashboards contain real panels, configuration and docs agree, and every resilience/deployment claim is either verified or explicitly pending.

## Validation and remaining inputs

For implementation changes, run Terraform formatting/validation for each root, Helm lint/render, Kubernetes/CRD schema validation, focused analysis fixtures, workflow validation, and the relevant existing backend tests. Before calling the stack deploy-ready, perform the live first deployment, failed-release checks, HPA test, and clean teardown described in the review.

Before account-affecting steps, establish the target account/profile, ownership of the existing state/OIDC resources, GitHub branch protection and deployment-status access, and verify the supplied ACM certificates. Public HTTPS domains are now selected: `fuelops.hemal.me` and `argocd.hemal.me`, with Cloudflare DNS and Argo login. The intel business smoke test depends on the backend endpoint; an external alert receiver depends on the team's chosen destination.
