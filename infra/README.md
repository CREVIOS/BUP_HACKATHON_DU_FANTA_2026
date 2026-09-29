# Infrastructure bootstrap

The configuration pins dependencies, orders namespace/controller creation, separates platform bootstrap from application activation, and keeps operator tools off the public ALB. The configuration is still one Terraform root. Splitting AWS and platform state requires an inventory of existing remote state first.

Shared OIDC provider ownership, workload secret scope, rollback analysis, HPA/GitOps ownership, and release-status reporting still need the subsequent fixes in [the work plan](../docs/INFRA_WORK_PLAN.md). Passing the checks below does not establish readiness for public deployment.

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
4. The local platform chart, including the Auto Mode IngressClass and gp3 StorageClass. It retains the dependency on controller releases so the application gate waits for them. It creates no operator ingresses. If controller persistence is added later, install the StorageClass in a separate earlier stage to avoid this dependency cycle.
5. The `argocd-apps` Helm release. With `enable_application = false` (default), it has **no Application objects**, so a fresh bootstrap cannot launch app migrations/workloads. The release itself retains its existing Terraform address.

App activation is a separate reviewed configuration change after the platform is ready:

- Publish backend and web images, and verify their full 40-character commit SHA tags exist in the intended ECR repositories.
- Commit those tags in `deploy/charts/fuelops/values.yaml` in the Git revision Argo will track. Include the new `values.schema.json` in that revision.
- Set `enable_application = true` in the deployment's persistent Terraform variable configuration. Terraform leaves image tags owned by Git; it does not override them through Helm parameters.
- Review the resulting Terraform plan, then apply it as part of the deployment runbook. Confirm Argo sync/migration/rollout status separately; `application_enabled` only reports the configuration switch.

The chart's JSON schema rejects `bootstrap`, `latest`, `dev`, empty, and short tags. Enforcement happens when Helm/Argo renders the actual Git chart, before Kubernetes resources or PreSync hooks are created. Terraform validation alone does not verify remote Git contents or ECR image existence. A valid-looking SHA whose image was never pushed is still a deployment error.

Do not use `enable_application = false` as a pause or teardown control for an existing deployment: it removes the Application from the Helm release, and workload cleanup depends on that Application's deletion policy. It is a bootstrap switch.

## Private operator access

Argo CD, Grafana, and the Rollouts dashboard use `ClusterIP` Services with no ingress. Only the application's `/` and `/api` routes are published through the ALB. Configure `kubectl` with the `kubeconfig_command` Terraform output using an operator identity authorized for this EKS cluster; the image-publishing GitHub role has no cluster access. Port-forwarding requires Kubernetes permission to access the selected Pods and create `pods/portforward` requests.

Run each command in its own terminal and leave it running while using that tool:

```bash
kubectl -n argocd port-forward --address=127.0.0.1 svc/argocd-server 8443:443
kubectl -n monitoring port-forward --address=127.0.0.1 svc/kps-grafana 3000:80
kubectl -n argo-rollouts port-forward --address=127.0.0.1 svc/argo-rollouts-dashboard 3100:3100
```

| Tool | Local URL | Authentication |
|---|---|---|
| Argo CD | `https://localhost:8443/` | `admin` and the initial Argo CD password; TLS uses Argo CD's generated certificate, so expect a certificate warning on first access |
| Grafana | `http://localhost:3000/` | `admin` and the generated Grafana password |
| Rollouts | `http://localhost:3100/` | No dashboard login; operator access uses the Kubernetes tunnel, and dashboard workload permissions are read-only |

Retrieve passwords locally without saving them in the repository or CI logs:

```bash
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 --decode
terraform -chdir=infra output -raw grafana_admin_password
```

Use the current Argo CD password if the initial one has been rotated. Argo CD and Grafana anonymous access remain disabled. Each UI serves from `/`; the former `/argocd`, `/grafana`, and `/rollouts` ALB paths are removed. Stopping the port-forward process closes its local listener. `ClusterIP` does not isolate these tools from other in-cluster clients; the Rollouts dashboard has no independent authentication layer. Its pinned chart retains coordination Lease permissions, while its Rollout, Deployment, and analysis workload access is read-only.

## GitHub release trust

`github_oidc_subject` is a **required deployment input**. Confirm the repository's actual OIDC subject format in GitHub settings before planning an apply; there is no guessed default. The policy uses exact `StringEquals` matches for this subject and the `sts.amazonaws.com` audience. Terraform accepts only this `github_repo` on `refs/heads/main`, including GitHub's optional immutable numeric owner/repository IDs.

For the name-only format, the input is:

```hcl
github_oidc_subject = "repo:CREVIOS/BUP_HACKATHON_DU_FANTA_2026:ref:refs/heads/main"
```

For an immutable subject, use `repo:OWNER@OWNER_ID/REPO@REPO_ID:ref:refs/heads/main` with the actual names and IDs. GitHub documents both formats in its [OIDC reference](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims) and [AWS integration guide](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws). Custom subject templates need a separate policy change; do not broaden the subject to a wildcard to make a release pass.

The release workflow also restricts its publication job to `main`, including manual dispatches. Protect that branch and workflow changes in GitHub. If releases later use a protected GitHub environment, update its deployment restrictions and the exact IAM subject together. The role remains ECR-only. Reusing an account-level OIDC provider safely is still pending: the current root owns the provider, so review its ownership before applying or destroying this stack.

## Adopting an existing environment

Keep `enable_application = true` if the existing Application must remain managed. Before applying, inspect the current state and namespace inventory. Namespaces originally created by Helm may already exist without Terraform namespace resources. Import only those existing namespaces that are absent from state, using addresses such as:

```bash
terraform -chdir=infra import 'kubernetes_namespace_v1.platform["argocd"]' argocd
terraform -chdir=infra import 'kubernetes_namespace_v1.platform["argo-rollouts"]' argo-rollouts
terraform -chdir=infra import 'kubernetes_namespace_v1.platform["monitoring"]' monitoring
```

These are state-changing adoption commands, not prerequisites for an empty environment. Review the plan afterward for unexpected deletes/replacements and chart upgrades/downgrades. No live state inventory or migration has been performed as part of this increment.

The operator-access increment upgrades the local platform chart to `0.2.0`; applying it removes its three previously managed operator Ingress objects. It also restores Argo CD server TLS and changes UI paths to `/`. Establish operator Kubernetes access first, then verify the three port-forwards and confirm `kubectl get ingress -A` has no operator ingresses. Inspect the ALB rules to confirm the old operator backends are gone; the app's catch-all route may still answer those URLs. An existing environment's access remains unchanged until this configuration is applied.

## Local and CI validation

From the repository root, using the pinned CLI versions:

```bash
terraform -chdir=infra fmt -check -recursive
terraform -chdir=infra init -backend=false -input=false -lockfile=readonly
terraform -chdir=infra validate
terraform -chdir=infra test
python3 scripts/check_bootstrap_charts.py
```

`terraform test` uses mocked providers and plan-only runs; it does not need AWS/GitHub credentials or a live cluster. Its fixtures supply a test OIDC subject. The tests cover disabled/enabled application creation, namespace assignment, Git ownership of image tags, private/authenticated operator values, read-only dashboard configuration, exact legacy/immutable OIDC subjects, and rejection of wildcard, wrong-branch, wrong-repository, pull-request, and environment subjects. The Python check uses only the standard library and Helm: it lints/renders both local charts, rejects platform ingress resources, then proves either image's invalid tag/repository prevents rendering.

Increment 2 validation: Terraform formatting/validation and all nine mock plan tests passed. Both local charts passed their checks. The three affected pinned upstream charts were rendered with values from the mock plan against Kubernetes `1.36.0`; the rendered manifests confirmed ClusterIP-only Services, no operator ingress, Argo CD TLS and authentication, Grafana authentication and root URL, port-forward Service ports, and read-only dashboard workload RBAC. The app still renders its single `/` and `/api` ingress. Live behavior has not been verified.

The app chart deliberately fails default `helm lint`/`helm template` while its values contain bootstrap placeholders. For a one-off local render, supply synthetic full SHA tags; this does not publish images:

```bash
helm template fuelops deploy/charts/fuelops --namespace fuelops \
  --set-string image.tag=0123456789abcdef0123456789abcdef01234567 \
  --set-string web.tag=0123456789abcdef0123456789abcdef01234567
```

The remaining live checks are namespace adoption or clean creation, controller readiness, actual image availability, RDS connectivity, Argo sync, and a complete cleanup rehearsal. Export evidence and remove app resources while controllers are running; the eventual root split must preserve that teardown order.
