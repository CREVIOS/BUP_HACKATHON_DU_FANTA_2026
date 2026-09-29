# Infrastructure bootstrap

This increment pins dependencies, orders namespace/controller creation, and separates platform bootstrap from application activation. The configuration is still one Terraform root. Splitting AWS and platform state requires an inventory of existing remote state first.

Public ops ingress, rollback analysis, HPA/GitOps ownership, and release-status reporting still need the subsequent fixes in [the work plan](../docs/INFRA_WORK_PLAN.md). Passing the checks below does not establish readiness for public deployment.

## Dependency baseline

| Component | Pinned version | Source |
|---|---|---|
| Terraform CLI in CI | 1.13.5 | `.github/workflows/ci.yml` |
| Helm CLI in CI | 3.19.0 | `.github/workflows/ci.yml` |
| EKS module | 21.26.0 | [terraform-aws-eks](https://github.com/terraform-aws-modules/terraform-aws-eks/releases/tag/v21.26.0) |
| VPC module | 6.7.3 | [terraform-aws-vpc](https://github.com/terraform-aws-modules/terraform-aws-vpc/releases/tag/v6.7.3) |
| metrics-server chart | 3.14.0 | [Chart repository](https://kubernetes-sigs.github.io/metrics-server/) |
| kube-prometheus-stack chart | 91.8.1 | [Chart repository](https://prometheus-community.github.io/helm-charts/) |
| argo-cd chart | 10.9.2 | [Chart repository](https://argoproj.github.io/argo-helm/) |
| argo-rollouts chart | 2.43.2 | [Chart repository](https://argoproj.github.io/argo-helm/) |
| argocd-apps chart | 2.0.5 | [Chart repository](https://argoproj.github.io/argo-helm/) |

The Kubernetes target remains `1.36`. All five external charts were rendered locally against `1.36.0` using the configured Helm values with mock secrets; live compatibility must still be proved in the rehearsal. The app's Prometheus URL was checked against the rendered monitoring Service. Keep `.terraform.lock.hcl`: provider versions are unchanged, Linux package hashes have been added, and existing hashes retained. Module and chart versions are pinned separately because the provider lockfile does not pin them.

## Creation order

1. AWS resources: VPC, EKS, RDS, ECR, and GitHub wiring.
2. Explicitly managed `argocd`, `argo-rollouts`, and `monitoring` namespaces; the existing `fuelops` namespace retains its Terraform address.
3. Argo CD, Argo Rollouts, monitoring, and metrics-server releases. The pinned controller values use ephemeral storage.
4. The local platform chart, including the Auto Mode IngressClass, gp3 StorageClass, and current ops ingresses. It waits for controller releases, so their namespaces and Services already exist. If controller persistence is added later, install the StorageClass in a separate earlier stage to avoid this dependency cycle.
5. The `argocd-apps` Helm release. With `enable_application = false` (default), it has **no Application objects**, so a fresh bootstrap cannot launch app migrations/workloads. The release itself retains its existing Terraform address.

App activation is a separate reviewed configuration change after the platform is ready:

- Publish backend and web images, and verify their full 40-character commit SHA tags exist in the intended ECR repositories.
- Commit those tags in `deploy/charts/fuelops/values.yaml` in the Git revision Argo will track. Include the new `values.schema.json` in that revision.
- Set `enable_application = true` in the deployment's persistent Terraform variable configuration. Terraform leaves image tags owned by Git; it does not override them through Helm parameters.
- Review the resulting Terraform plan, then apply it as part of the deployment runbook. Confirm Argo sync/migration/rollout status separately; `application_enabled` only reports the configuration switch.

The chart's JSON schema rejects `bootstrap`, `latest`, `dev`, empty, and short tags. Enforcement happens when Helm/Argo renders the actual Git chart, before Kubernetes resources or PreSync hooks are created. Terraform validation alone does not verify remote Git contents or ECR image existence. A valid-looking SHA whose image was never pushed is still a deployment error.

Do not use `enable_application = false` as a pause or teardown control for an existing deployment: it removes the Application from the Helm release, and workload cleanup depends on that Application's deletion policy. It is a bootstrap switch.

## Adopting an existing environment

Keep `enable_application = true` if the existing Application must remain managed. Before applying, inspect the current state and namespace inventory. Namespaces originally created by Helm may already exist without Terraform namespace resources. Import only those existing namespaces that are absent from state, using addresses such as:

```bash
terraform -chdir=infra import 'kubernetes_namespace_v1.platform["argocd"]' argocd
terraform -chdir=infra import 'kubernetes_namespace_v1.platform["argo-rollouts"]' argo-rollouts
terraform -chdir=infra import 'kubernetes_namespace_v1.platform["monitoring"]' monitoring
```

These are state-changing adoption commands, not prerequisites for an empty environment. Review the plan afterward for unexpected deletes/replacements and chart upgrades/downgrades. No live state inventory or migration has been performed as part of this increment.

## Local and CI validation

From the repository root, using the pinned CLI versions:

```bash
terraform -chdir=infra fmt -check -recursive
terraform -chdir=infra init -backend=false -input=false -lockfile=readonly
terraform -chdir=infra validate
terraform -chdir=infra test
python3 scripts/check_bootstrap_charts.py
```

`terraform test` uses mocked providers and plan-only runs; it does not need AWS/GitHub credentials or a live cluster. The tests cover disabled/enabled application creation, namespace assignment, the chosen Git revision, and Git ownership of image tags. The Python check uses only the standard library and Helm: it lints/renders both local charts, then proves either image's invalid tag/repository prevents rendering.

The app chart deliberately fails default `helm lint`/`helm template` while its values contain bootstrap placeholders. For a one-off local render, supply synthetic full SHA tags; this does not publish images:

```bash
helm template fuelops deploy/charts/fuelops --namespace fuelops \
  --set-string image.tag=0123456789abcdef0123456789abcdef01234567 \
  --set-string web.tag=0123456789abcdef0123456789abcdef01234567
```

The remaining live checks are namespace adoption or clean creation, controller readiness, actual image availability, RDS connectivity, Argo sync, and a complete cleanup rehearsal. Export evidence and remove app resources while controllers are running; the eventual root split must preserve that teardown order.
