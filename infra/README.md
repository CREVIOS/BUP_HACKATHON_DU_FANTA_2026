# Infrastructure bootstrap

The configuration pins dependencies, orders namespace/controller creation, and separates platform bootstrap from application activation. The selected deployment uses a shared HTTPS ALB for `fuelops.hemal.me`, authenticated Grafana at `fuelops.hemal.me/grafana/`, and authenticated `argocd.hemal.me`. Rollouts retains private access. See [HTTPS setup](../docs/HTTPS_SETUP.md) for the two existing ACM certificates and Cloudflare DNS steps. The configuration is still one Terraform root. Splitting AWS and platform state requires an inventory of existing remote state first.

Shared OIDC provider reuse is supported, with a documented handoff for providers already in this state. Workload secret scope, rollback analysis, HPA/GitOps ownership, and release-status reporting still need the subsequent fixes in [the work plan](../docs/INFRA_WORK_PLAN.md). Passing the checks below does not establish readiness for public deployment.

## Dependency baseline

| Component | Pinned version | Source |
|---|---|---|
| Terraform CLI in CI | 1.13.5 | `.github/workflows/ci.yml` |
| Helm CLI in CI | 3.19.0 | `.github/workflows/ci.yml` |
| EKS module | 21.26.0 | [terraform-aws-eks](https://github.com/terraform-aws-modules/terraform-aws-eks/releases/tag/v21.26.0) |
| VPC module | 6.7.3 | [terraform-aws-vpc](https://github.com/terraform-aws-modules/terraform-aws-vpc/releases/tag/v6.7.3) |
| metrics-server chart | 3.14.0 | [Chart repository](https://kubernetes-sigs.github.io/metrics-server/) |
| kube-prometheus-stack chart | 91.8.1 | [Chart repository](https://prometheus-community.github.io/helm-charts/) |
| Tempo chart / application | 2.4.0 / 2.10.8 | [Chart release](https://github.com/grafana-community/helm-charts/releases/tag/tempo-2.4.0) |
| Loki chart / application | 7.3.0 / 3.6.12 | [Chart release](https://github.com/grafana/helm-charts/releases/tag/helm-loki-7.3.0) |
| OTel log-collector chart / application | 0.173.1 / 0.160.0 | [Chart release](https://github.com/open-telemetry/opentelemetry-helm-charts/releases/tag/opentelemetry-collector-0.173.1) |
| argo-cd chart | 10.9.2 | [Chart repository](https://argoproj.github.io/argo-helm/) |
| argo-rollouts chart | 2.43.2 | [Chart repository](https://argoproj.github.io/argo-helm/) |
| argocd-apps chart | 2.0.5 | [Chart repository](https://argoproj.github.io/argo-helm/) |

The Kubernetes target remains `1.36`. All eight external charts were rendered locally against `1.36.0` using the configured Helm values with mock secrets; live compatibility must still be proved in the rehearsal. The app's Prometheus URL was checked against the rendered monitoring Service. Keep `.terraform.lock.hcl`: provider versions are unchanged, Linux package hashes have been added, and existing hashes retained. Module and chart versions are pinned separately because the provider lockfile does not pin them.

Tempo uses the maintained community chart repository linked from [Grafana's installation guide](https://grafana.com/docs/tempo/latest/set-up-for-tracing/setup-tempo/deploy/kubernetes/helm-chart/). The pin deliberately stays on Tempo 2; a Tempo 3 migration is separate work. Loki stays on the chart family introduced by `main`; the [community-chart migration](https://grafana.com/docs/loki/latest/setup/upgrade/upgrade-to-community/) changes deployment values and needs a separate upgrade review. CI checks monitoring, Tempo, Loki, and log-collector package digests in `scripts/observability-charts.lock.json` against the versions in the actual mocked Terraform plan. When changing a pin, review the upstream package, update its lock entry, and run the rendering checks.

## Creation order

1. AWS resources: VPC, EKS, RDS, ECR, and separate GitHub image-publisher/Terraform roles. Repository variables and Argo's read-only deploy key are registered separately; Terraform no longer uses the GitHub provider.
2. Explicitly managed `argocd`, `argo-rollouts`, and `monitoring` namespaces; the existing `fuelops` namespace retains its Terraform address.
3. Monitoring and metrics-server releases; Tempo, Argo CD, and Argo Rollouts depend on monitoring. This installs the ServiceMonitor CRD before the delivery controllers' metrics resources. The pinned controller values use ephemeral storage.
4. The local platform chart, including the Auto Mode IngressClass with existing ACM certificates, the optional authenticated Argo CD HTTPS ingress, and gp3 StorageClass. It retains the dependency on controller releases so the application gate waits for them. The selected Terraform deployment enables public Argo ingress; `argocd_ingress_enabled=false` opts out. If controller persistence is added later, install the StorageClass in a separate earlier stage to avoid this dependency cycle.
5. Loki, after monitoring and the platform StorageClass, followed by the node log-collector DaemonSet.
6. The `argocd-apps` Helm release, which also waits for Tempo and the log collector. With `enable_application = false` (default), it has **no Application objects**, so a fresh bootstrap cannot launch app migrations/workloads. The release itself retains its existing Terraform address.

App activation is a separate reviewed configuration change after the platform is ready:

- Verify nonempty `OPERATOR_TOKEN` and `ADMIN_TOKEN` keys in the operator-owned `fuelops-auth` Secret before activation. App chart `0.3.0` requires those keys only for the API and sets `REQUIRE_AUTH=true`; promote the new backend image too, so empty values fail startup. Existing `JWT_SECRET`/`SEED_USERS` entries do not configure bearer authentication. See [operator access and API auth](../docs/OPERATOR_ACCESS_AUTH.md) for preflight, import, and rollout steps.
- Confirm both configured ACM certificates are Issued, unexpired, and cover their corresponding hostnames. Terraform validates ARN format/account/region, but does not inspect certificate issuance or hostname coverage. Follow [HTTPS setup](../docs/HTTPS_SETUP.md) for the controlled ingress transition and Cloudflare records.
- Publish backend and web images, and verify their full 40-character commit SHA tags exist in the intended ECR repositories.
- Commit those tags in `deploy/charts/fuelops/values.yaml` in the Git revision Argo will track. Include the new `values.schema.json` in that revision.
- Set `enable_application = true` in the deployment's persistent Terraform variable configuration. Terraform leaves image tags owned by Git; it does not override them through Helm parameters.
- Review the resulting Terraform plan, then apply it as part of the deployment runbook. Confirm Argo sync/migration/rollout status separately; `application_enabled` only reports the configuration switch.

The chart's JSON schema rejects `bootstrap`, `latest`, `dev`, empty, and short tags. Enforcement happens when Helm/Argo renders the actual Git chart, before Kubernetes resources or PreSync hooks are created. Terraform validation alone does not verify remote Git contents or ECR image existence. A valid-looking SHA whose image was never pushed is still a deployment error.

Do not use `enable_application = false` as a pause or teardown control for an existing deployment: it removes the Application from the Helm release, and workload cleanup depends on that Application's deletion policy. It is a bootstrap switch.

## Private operator access

The optional `monitoring_operator_principal_arns` set manages STANDARD EKS access entries with `AmazonEKSEditPolicy` scoped only to `monitoring`. It preserves the manually established Grafana access, including Secret reads and port-forwarding; it grants no application/Argo access. Import both the existing entry and policy association before applying, and persist `MONITORING_OPERATOR_PRINCIPAL_ARNS` as a GitHub Actions repository variable containing the JSON array. See the [adoption runbook](../docs/OPERATOR_ACCESS_AUTH.md). This does not modify the existing root/Terraform-role entries.

Argo CD, Grafana, and the Rollouts dashboard use `ClusterIP` Services. Platform-owned HTTPS ingresses publish Argo CD at `https://argocd.hemal.me` and Grafana at `https://fuelops.hemal.me/grafana/`, both with login required. Rollouts has no ingress. `argocd_ingress_enabled=false` and `grafana_ingress_enabled=false` independently restore private-only access. Configure `kubectl` with the `kubeconfig_command` Terraform output using an operator identity authorized for this EKS cluster; the image-publishing GitHub role has no cluster access. Port-forwarding requires permission to access selected Pods and create `pods/portforward` requests.

Run each command in its own terminal and leave it running while using that tool:

```bash
kubectl -n argocd port-forward --address=127.0.0.1 svc/argocd-server 8443:443
kubectl -n monitoring port-forward --address=127.0.0.1 svc/kps-grafana 3000:80
kubectl -n argo-rollouts port-forward --address=127.0.0.1 svc/argo-rollouts-dashboard 3100:3100
```

| Tool | Local URL | Authentication |
|---|---|---|
| Argo CD | `https://localhost:8443/` | `admin` and the initial Argo CD password; TLS uses Argo CD's generated certificate, so expect a certificate warning on first access |
| Grafana | Public: `https://fuelops.hemal.me/grafana/`; private mode: `http://localhost:3000/` | `admin` and the existing/generated Grafana password; public-mode cookies require HTTPS |
| Rollouts | `http://localhost:3100/` | No dashboard login; operator access uses the Kubernetes tunnel, and dashboard workload permissions are read-only |

Retrieve passwords locally without saving them in the repository or CI logs:

```bash
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 --decode
terraform -chdir=infra output -raw grafana_admin_password
```

Use the current Argo CD password if the initial one has been rotated. Argo CD and Grafana anonymous access remain disabled. Grafana serves `/grafana/` in public mode, with matching probes and sidecar reload URLs; its HTTP tunnel is then for health checks, not browser login with Secure cookies. The legacy `/argocd` and `/rollouts` routes stay removed. Stopping the port-forward closes its listener. `ClusterIP` does not isolate these tools from in-cluster clients; Rollouts has no independent login. Its pinned chart retains coordination Lease permissions, while Rollout, Deployment, and analysis workload access is read-only.

## Tracing and metrics

The application chart configures `api`, `intel`, and `ingestor` to export OTLP/gRPC to `otel-collector.fuelops.svc:4317`. The Collector forwards traces to `tempo.monitoring.svc:4317` and exposes OTel metrics on port `8889` for its PodMonitor. Both Collector and Tempo also expose their configured OTLP/HTTP receiver on `4318`. Grafana queries Tempo over HTTP at `tempo.monitoring.svc:3200`; these Services remain private.

Terraform now provisions all Grafana datasources together in `monitoring`, preserving main's Prometheus exemplar links, Tempo service map and trace-to-metric/log links, and Loki log-to-trace links. The datasource sidecar watches only `monitoring`; the old app-owned `fuelops-tempo-datasource` ConfigMap is removed on Argo sync to avoid duplicate UID definitions. Dashboard discovery still watches all namespaces so it can import the operations dashboard from `fuelops`. Tempo's metrics generator remote-writes service-graph/span metrics to Prometheus, whose remote-write receiver and exemplar storage are enabled.

Tempo runs one replica with explicit ephemeral local storage and 24-hour retention. A Pod replacement loses stored traces; export useful evidence before teardown. Setting `otel.endpoint` to `""` in the application values removes the OTel environment variables, app Collector resources, and its PodMonitor on the next successful Argo sync. Terraform-managed Tempo, Loki, node log collection, and Grafana datasources remain, as do the existing application `/metrics` PodMonitor and Prometheus rules. The switch controls application OTel export, not platform logging.

The node-level OTel DaemonSet tails Pod files for `fuelops`, `argocd`, and `argo-rollouts`, enriches them with Kubernetes metadata, and sends OTLP/HTTP to `loki.monitoring.svc:3100/otlp`. Its unused network receiver host ports are disabled. Loki uses a single replica and a 10 GiB PVC explicitly assigned to the Auto Mode `gp3` StorageClass. The pinned chart deletes the PVC when its StatefulSet is deleted; export logs before teardown. The inherited `48h` retention limit is configured, but compactor retention cleanup is not enabled or verified yet; do not rely on it to bound disk use. Verify node log-file access and storage readiness on Auto Mode during rehearsal.

During the deferred deployment rehearsal:

1. Confirm the Tempo/Loki StatefulSets, Loki's PVC, app Collector Deployment, and log-agent DaemonSet are ready. Inspect their logs for configuration or export errors.
2. Send a business API request and allow the ingestor to process a simulator tick. Record the request time and any trace ID from application logs.
3. Open Grafana at its HTTPS URL (or the port-forward in private mode). Confirm Prometheus, Tempo, and Loki datasources are present, find fresh traces and logs, and exercise their cross-links. Open the operations dashboard and check its panels against real data.
4. Confirm Prometheus has healthy app/Collector targets and Argo CD/Rollouts ServiceMonitors, receives fresh samples and span metrics, and populates the service map.

Local rendering verifies configuration and resource wiring. Successful ingestion, datasource provisioning, cross-links, dashboard queries, and metric scraping still require this live check.

## GitHub release trust

Both AWS roles use exact `StringEquals` matches for the `sts.amazonaws.com` audience and this repository on `refs/heads/main`. The default subject is derived from `github_oidc_sub_prefix`, preserving the immutable repository identity configured on `main`: `repo:CREVIOS@48938983/BUP_HACKATHON_DU_FANTA_2026@1394116440`. Confirm the prefix for the target repository before applying, especially after a fork or transfer. `github_oidc_subject` is now an optional exact-subject override; the merge no longer requires a new input for the existing repository. Both inputs validate the repository name and reject wildcards.

For a repository that uses the name-only format, the explicit subject override is:

```hcl
github_oidc_subject = "repo:CREVIOS/BUP_HACKATHON_DU_FANTA_2026:ref:refs/heads/main"
```

For an immutable subject, use `repo:OWNER@OWNER_ID/REPO@REPO_ID:ref:refs/heads/main` with the actual names and IDs. GitHub documents both formats in its [OIDC reference](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims) and [AWS integration guide](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws). Custom subject templates need a separate policy change; do not broaden the subject to a wildcard to make a release pass.

The release workflow also restricts its publication job to `main`, including manual dispatches. Protect that branch and workflow changes in GitHub. If releases later use a protected GitHub environment, update its deployment restrictions and the exact IAM subject together. The image-publisher role remains ECR-only, including layer-download permission for image scanning. The separate Terraform role introduced on `main` retains its AdministratorAccess policy and EKS access entry; narrowing that infrastructure role is separate work.

## Shared GitHub OIDC ownership

GitHub's IAM OIDC provider is account-level identity infrastructure and can serve multiple repositories. AWS rejects another provider with the same issuer URL in the same account; inspect ownership before bootstrap. See the [AWS provider API](https://docs.aws.amazon.com/IAM/latest/APIReference/API_CreateOpenIDConnectProvider.html).

| Configuration | Provider ownership | Teardown behavior |
|---|---|---|
| `existing_github_oidc_provider_arn = ""` (default) | This root creates/manages the provider; preserves the previous bootstrap behavior | `prevent_destroy` blocks deletion until ownership is handed off |
| Exact existing provider ARN | A data source reads the provider; its audiences, thumbprints, and tags stay with the external owner | Demo teardown has no managed OIDC provider to delete |

For an existing account-owned provider, persist the following in the deployment's Terraform inputs, substituting the actual account ID:

```hcl
existing_github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
```

Also set the GitHub repository variable `AWS_GITHUB_OIDC_PROVIDER_ARN` to that ARN for the manual infra workflow. It is configuration, not a secret. The workflow passes the same setting on plan, apply, and destroy; an unset variable retains managed bootstrap. The data source requires the active AWS account/partition, GitHub's exact issuer, and an audience list containing `sts.amazonaws.com`. It accepts additional audiences without changing them. Both roles continue to require their exact `main`-branch subject and STS audience. A missing or incompatible provider fails the plan instead of falling back to creation.

The outputs `github_oidc_provider_arn` and `github_oidc_provider_managed` show the selected provider and whether this root owns it. Reusing a provider does not make the image-publisher or Terraform roles externally owned; those remain demo resources.

### Handoff when the provider is already in demo state

This is a future account/state operation, not part of local validation. If an external owner already manages the provider and this demo state has no provider entry, set the ARN and skip the state-removal procedure.

1. Pause infra runs and coordinate with the account owner. Verify the AWS identity, backend bucket/key, and workspace. Save a restricted state backup outside the repository; state contains secrets. Agree which account-level bootstrap or administrator will own the provider after handoff.
2. Inspect `terraform -chdir=infra state list` and the provider entry to record its actual ARN and address. The old address is `aws_iam_openid_connect_provider.github`; after applying the new `moved` block it is `aws_iam_openid_connect_provider.github[0]`. The move preserves the existing object in managed mode. Check the live provider with `aws iam get-open-id-connect-provider --open-id-connect-provider-arn <actual-arn>`.
3. Prepare the exact ARN in every persistent deployment input, including `AWS_GITHUB_OIDC_PROVIDER_ARN`. Keep workflow runs paused through the handoff. Simply setting the ARN while the provider remains managed would request deletion of the old managed instance; the guard rejects that plan.
4. Remove only this provider's binding from demo state, using the address found in step 2. For the indexed address, preview and then execute:

   ```bash
   terraform -chdir=infra state rm -dry-run 'aws_iam_openid_connect_provider.github[0]'
   terraform -chdir=infra state rm 'aws_iam_openid_connect_provider.github[0]'
   ```

   Use the old unindexed address instead if that is what state lists. This forgets the binding without deleting the AWS provider. If another Terraform root will own it, import it there under its reviewed configuration. Do not import it back into this demo root. See [Terraform state removal](https://developer.hashicorp.com/terraform/cli/commands/state/rm).
5. Review a fresh demo plan with reuse configured: no OIDC provider create/update/delete, both role principals still use the same ARN, and the ownership output is false. Verify the shared owner's inventory, then resume infra runs. Keep the ARN configured through teardown and later redeployments.

The guard deliberately blocks ordinary destroy while this root still owns the provider. Complete the handoff before the demo cleanup window; do not remove the guard to make cleanup pass. `prevent_destroy` only protects the object while its resource block remains in configuration; it is not a replacement for ownership discipline. See [Terraform lifecycle behavior](https://developer.hashicorp.com/terraform/language/meta-arguments/lifecycle#prevent_destroy). No live state handoff has been performed here.

## Terraform workflow and repository setup

PRs run credential-free validation and mock plans through `ci.yml`; they do not attempt to assume the main-only Terraform role. The `infra` workflow runs live `plan`, `apply`, or `destroy` only by manual dispatch from `main`, with Terraform `1.13.5` and the read-only provider lockfile. Its `enable_application` input defaults to **true** to retain management of an existing app, matching the previous workflow's behavior. Select **false only for a fresh bootstrap**. Local Terraform still defaults to false. The `git_revision` input accepts a branch or an exact release commit; use the release commit for a fixed rehearsal.

Before running workflows, register these GitHub repository variables: `AWS_REGION`, `AWS_ROLE_ARN` from `github_actions_role_arn`, `TF_ROLE_ARN` from `terraform_role_arn`, and `ECR_REGISTRY` matching the registry in `ecr_repositories`. Set `AWS_GITHUB_OIDC_PROVIDER_ARN` when using shared identity infrastructure, following the handoff above if this root currently owns it. Add `argocd_deploy_public_key` as a read-only repository deploy key. These settings are managed outside Terraform after `main` removed the GitHub provider. If an older state still contains GitHub-provider resources, review and transfer their ownership before applying; do not treat a proposed deploy-key deletion as routine cleanup. No state handoff has been performed here.

## Adopting an existing environment

Keep `enable_application = true` if the existing Application must remain managed. Before applying, inspect the current state and namespace inventory. Namespaces originally created by Helm may already exist without Terraform namespace resources. Import only those existing namespaces that are absent from state, using addresses such as:

```bash
terraform -chdir=infra import 'kubernetes_namespace_v1.platform["argocd"]' argocd
terraform -chdir=infra import 'kubernetes_namespace_v1.platform["argo-rollouts"]' argo-rollouts
terraform -chdir=infra import 'kubernetes_namespace_v1.platform["monitoring"]' monitoring
```

These are state-changing adoption commands, not prerequisites for an empty environment. Review the plan afterward for unexpected deletes/replacements and chart upgrades/downgrades. No live state inventory or migration has been performed as part of this increment.

The local platform chart is now `0.5.0` and the application chart `0.3.0`. The earlier platform `0.3.0` increment removed the separate `alb-ops` class and legacy operator ingresses. The current selection adds authenticated Argo CD and Grafana to the shared application ALB. Grafana's `/grafana` rule precedes the application's catch-all and reuses the FuelOps certificate. Establish operator access first, then verify that only the configured FuelOps/Argo/Grafana routes are public. Inspect old ops-ALB cleanup. Raw ALB URLs are not application entrypoints. See [HTTPS setup](../docs/HTTPS_SETUP.md); live access changes only after apply/sync.

The tracing increment retains the `helm_release.tempo` address and release name while changing its chart repository and pinning its version. Inspect the live plan and installed release before adopting this change; the previously unpinned version is unknown until that inventory. Ephemeral trace history is not guaranteed to survive the update.

## Local and CI validation

From the repository root, using the pinned CLI versions:

```bash
terraform -chdir=infra fmt -check -recursive
terraform -chdir=infra init -backend=false -input=false -lockfile=readonly
terraform -chdir=infra validate
terraform -chdir=infra test
python3 -m venv /tmp/fuelops-infra-checks
/tmp/fuelops-infra-checks/bin/python -m pip install -r scripts/requirements-infra.txt
/tmp/fuelops-infra-checks/bin/python -B scripts/check_bootstrap_charts.py
/tmp/fuelops-infra-checks/bin/python -B scripts/check_observability.py
```

`terraform test` uses mocked providers and plan-only runs; it does not need AWS/GitHub credentials or a live cluster. The tests cover disabled/enabled application creation, namespace assignment, Git ownership of image tags, authenticated operator values, read-only dashboard configuration, exact legacy/immutable OIDC subjects, and rejection of wildcard, wrong-branch, wrong-repository, pull-request, and environment subjects. HTTPS cases cover both certificate ARNs, invalid account/region/format/duplicate certificates, hostname validation, and Argo's public/private URL switch. The additional observability plan supplies fake secrets/certificates and verifies Tempo's namespace, private Service, and ephemeral storage. The bootstrap Python check uses Helm and pinned PyYAML: it renders both local charts, checks SNI certificates, host routing, redirects, Argo backend TLS, and ingress opt-out, then proves invalid certificate/hostname/image inputs prevent rendering. The observability checker also renders the actual mock-plan platform values through these HTTPS checks.

OIDC ownership tests cover managed bootstrap, read-only reuse, both roles' unchanged trust conditions, and rejection of invalid/wildcard provider ARNs, a different account/partition, an incompatible issuer, or a missing STS audience. These mocks verify configuration behavior; provider existence and current state ownership still need account inspection.

The observability check needs Python 3.12, pinned PyYAML, and initialized Terraform providers. It obtains the real Helm values from the dedicated mock plan, downloads and checksum-verifies the four pinned observability packages, and renders them with the local charts. It checks Service selectors and ports, Collector pipelines, Tempo remote write, unique linked datasources, dashboard discovery, Loki storage, file-log routing, private Services, and tracing enabled/disabled behavior. Use `TERRAFORM` and `HELM` to override CLI paths; `--infra-dir` accepts an initialized temporary root and `--chart-cache` reuses packages while still checking their digests. No cloud credentials are used. CI disables the Terraform wrapper so the checker receives unmodified JSON output.

Increment 2 validation: Terraform formatting/validation and all nine mock plan tests passed. Both local charts passed their checks. The three affected pinned upstream charts were rendered with values from the mock plan against Kubernetes `1.36.0`; the rendered manifests confirmed ClusterIP-only Services, no operator ingress, Argo CD TLS and authentication, Grafana authentication and root URL, port-forward Service ports, and read-only dashboard workload RBAC. The app still renders its single `/` and `/api` ingress. Live behavior has not been verified.

Merge validation against `main` at `cf0f21a`: read-only Terraform initialization and validation passed, along with all 11 mock plans, Helm checks, application/platform render assertions, Compose configuration, backend race tests/vet, frontend production build using pnpm `12.6.0`, and actionlint. The new assertions cover both roles using the existing immutable subject prefix; render inspection confirms the Next.js Service/probe target matches its image's port 3000 and preserves the published image tags.

The follow-up merge of `main` at `9d01920` preserves the new OpenTelemetry/Tempo implementation. Terraform validation and all 11 mock plans, local Helm checks, Compose configuration, and backend race tests/vet passed again for the affected files. Frontend and workflow configuration were unchanged by that follow-up.

Tracing increment validation: Terraform formatting/validation, all 12 mock plans, bootstrap chart checks, the enabled/disabled observability render check, and actionlint passed. CI now runs the new mock plan and render check. The upstream chart renders include the pinned Tempo package and Grafana's cross-namespace datasource configuration. Live tracing remains a rehearsal gate.

OIDC ownership increment validation: Terraform formatting/validation, all 20 mock plans, the observability render check, and infra workflow actionlint passed. A separate local fixture using the actual provider resource/moved block, synthetic state, disabled refresh, and loopback-only AWS endpoints confirmed a move with zero resource changes, rejection of a mode switch before handoff, and no provider destruction after synthetic handoff. This did not inspect or modify live AWS resources or remote state.

Observability merge validation against `main` at `51fc9a2`: Terraform formatting/validation, all 20 mock plans, bootstrap and expanded observability chart checks, and backend race tests/vet passed. Actual mock-plan values also rendered the Argo CD/Rollouts ServiceMonitors with the monitoring API available, while preserving private Services. The merge retains main's dashboard, linked datasources, trace-aware logging, and published image pair; Loki/log-agent pins and storage dependencies are explicit. Loki retention cleanup and all live telemetry checks remain open.

The follow-up merge of `main` at `0a1456e` brings in the operator API without infrastructure conflicts. Backend race tests/vet passed again. Terraform/chart configuration was unchanged by that follow-up. Its new bearer-token inputs still need the API workload wiring noted in the activation prerequisites above.

HTTPS increment validation: Terraform formatting/validation and all 27 mock plans passed. Both chart checks and the expanded observability render check passed, including the actual Terraform-to-platform certificate values, two-host routing, redirects, Argo backend TLS, private-ingress opt-out, and invalid certificate/hostname rejection. The CI workflow YAML also parsed successfully after moving the chart check behind PyYAML installation. These checks do not contact AWS or Kubernetes. The separate ACM read-only lookup could not run because the AWS connection credentials had expired; certificate issuance and all live DNS/TLS checks remain unverified. No deployment or DNS change was performed.

Merge validation against `main` at `1025c86`: resolved the web template conflict while preserving main's port 3000, 96 MiB memory request, 256 MiB limit, and published image pair. Bootstrap/HTTPS chart checks, backend race tests/vet, all 165 frontend tests, and the frontend production build passed. Terraform/platform configuration was unchanged by this merge. FuelOps token provisioning and live deployment checks remain pending.

The follow-up merge of `main` at `4197a73` aligns the Kubernetes API listener, Services, ingress, and web `API_PROXY_TARGET` on port 8000. The bootstrap check now verifies that entire port path; its stale 8080 expectation caused the PR check failure. The merge retains main's optional `fuelops-web` secret and Node 22 type definitions, and removes a duplicate web `env` mapping introduced by the merge. Bootstrap/HTTPS and expanded observability checks, all 165 frontend tests, and the production build passed with the updated frozen lockfile. The web secret is separate from the backend's token provisioning requirement.

Operator-access/auth and public-Grafana increment validation: Terraform formatting/validation and all 34 mock plans passed. Bootstrap/HTTPS checks verified API-only required Secret keys, protected auth settings, Grafana route precedence and private opt-out. The expanded observability render check verified the actual Terraform values against the pinned monitoring chart, including Grafana's root URL, secure cookies, disabled anonymous access, subpath probes, and local reload URLs. Backend race tests/vet passed, including empty-token startup rejection before database access. The infra workflow YAML parsed. No live import, apply, or Grafana ingress change was performed; use the [adoption and deployment runbook](../docs/OPERATOR_ACCESS_AUTH.md).

The merged app values retain the full SHA image tags published on `main`; schema validation still rejects bootstrap placeholders. For a one-off local render, synthetic full SHA tags can be supplied without publishing images:

```bash
helm template fuelops deploy/charts/fuelops --namespace fuelops \
  --set-string image.tag=0123456789abcdef0123456789abcdef01234567 \
  --set-string web.tag=0123456789abcdef0123456789abcdef01234567
```

The remaining live checks are namespace adoption or clean creation, controller readiness, actual image availability, RDS connectivity, Argo sync, and a complete cleanup rehearsal. Export evidence and remove app resources while controllers are running; the eventual root split must preserve that teardown order.
