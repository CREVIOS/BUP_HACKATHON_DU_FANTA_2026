# Adopt operator access, require API authentication, and publish Grafana

This increment starts from `main` at `1384f46`. It preserves the manually created
EKS access grant for the `work` profile's IAM user and requires authentication in
the deployed API. It does not rotate tokens or run a live Terraform apply.
The user-selected Grafana URL is `https://fuelops.hemal.me/grafana/`, using the
existing FuelOps certificate and Grafana login. Platform chart `0.5.0` adds its
route; `grafana_ingress_enabled` defaults to true and can restore private mode.

## Configuration and ownership

- `monitoring_operator_principal_arns` explicitly selects IAM users/roles to
  receive `AmazonEKSEditPolicy` only in `monitoring`. This preserves the existing
  grant, including Secret access and port-forwarding. It is broader than
  Grafana-only access and grants no access to `fuelops` or `argocd`.
- App chart `0.3.0` requires both `fuelops-auth` keys, `OPERATOR_TOKEN` and
  `ADMIN_TOKEN`, individually. Only the API receives them. The chart sets
  `REQUIRE_AUTH=true`; the new backend exits before database/listener setup if
  either token is empty or whitespace. The chart schema rejects overrides of
  these three variables in `api.env`. Local development may omit `REQUIRE_AUTH`.
- `fuelops-auth` remains operator-owned. Terraform does not read/store these
  tokens. The database/JWT/Jev values in `fuelops-env` remain Terraform-owned,
  including their presence in encrypted state. Remaining per-workload isolation
  of `fuelops-env` is separate work.

## 1. Configure and import the existing monitoring grant

In GitHub → Settings → Secrets and variables → Actions → Variables, create:

```text
Name: MONITORING_OPERATOR_PRINCIPAL_ARNS
Value: ["arn:aws:iam::373220260649:user/talentforge-admin"]
```

Persist this variable for later plans/applies. Removing a principal from the set
plans removal of its Terraform-owned grant. The value is an identity, not a secret.

Both the entry and policy association already exist in AWS. From the repository
root with this branch's Terraform configuration, use an identity permitted to
access the existing state bucket and EKS access entries:

```bash
export AWS_PROFILE=work
export TF_VAR_monitoring_operator_principal_arns='["arn:aws:iam::373220260649:user/talentforge-admin"]'
export TF_VAR_enable_application=true

aws sts get-caller-identity
terraform -chdir=infra init -input=false -lockfile=readonly \
  -backend-config='key=fuelops-sg/terraform.tfstate'
terraform -chdir=infra workspace show
terraform -chdir=infra state list
```

Confirm account `373220260649`, the expected workspace and existing deployment
state; coordinate with running infra workflows. Import each address below only
if absent from state. If another address already owns the object, reconcile that
ownership instead of importing it twice:

```bash
terraform -chdir=infra import \
  'aws_eks_access_entry.monitoring_operator["arn:aws:iam::373220260649:user/talentforge-admin"]' \
  'fuelops:arn:aws:iam::373220260649:user/talentforge-admin'

terraform -chdir=infra import \
  'aws_eks_access_policy_association.monitoring_operator["arn:aws:iam::373220260649:user/talentforge-admin"]' \
  'fuelops#arn:aws:iam::373220260649:user/talentforge-admin#arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy'
```

Import records ownership without widening the grant. These IDs follow the
provider's [entry import](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/eks_access_entry#import)
and [association import](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/eks_access_policy_association#import)
formats. For a new deployment without existing grants, skip import.

`work` currently has Kubernetes permissions only in `monitoring`. Full platform
refresh/apply needs broader Kubernetes access: use the GitHub infra workflow's
Terraform role, or a separately authorized infrastructure operator. The
GitHub-only role cannot be assumed directly from `work` under its current trust.

## 2. Prepare and release the application change

Before merging chart changes, an authorized Argo operator must pause automatic
sync and pin the Application to its current healthy revision. Keep
`enable_application=true` and that revision in platform runs; setting false
removes the Application and is not a pause control.

Using an identity authorized in `fuelops`, verify both existing token keys without
printing their values. The monitoring-only `work` grant cannot perform this check:

```bash
kubectl -n fuelops get secret fuelops-auth -o json | python3 -c '
import base64, json, sys
data = json.load(sys.stdin).get("data", {})
bad = [key for key in ("OPERATOR_TOKEN", "ADMIN_TOKEN")
       if not base64.b64decode(data.get(key, "")).strip()]
if bad:
    sys.exit("Missing or empty token keys: " + ", ".join(bad))
print("Both required token keys are nonempty; values were not displayed.")
'
```

Preserve the working tokens; this update does not require rotation. Supply any
missing values through the authorized application operator. Keep token values
out of Git, CLI arguments, CI output, and chart values. Future Secret rotation
requires a controlled API restart/rollout because environment variables are
loaded at process start.

After PR checks pass, merge and wait for the `deploy` workflow to publish both
new images and commit their SHA tags. Promote the **image-tag commit**, so the
API uses the new backend startup guard with the new chart. A chart update alone
cannot add the guard to an old image. Keep Argo pinned until the platform is ready.

## 3. Review/apply the platform update

After import and merge, run GitHub Actions → `infra` → Run workflow:

| Input | Value |
|---|---|
| Branch | `main` |
| action | `plan` |
| region | `ap-southeast-1` |
| state_key | `fuelops-sg/terraform.tfstate` |
| enable_application | `true` |
| git_revision | Existing healthy pinned application commit SHA |

Retain the existing OIDC ownership inputs. Review namespace adoption, controller
version changes, ALB changes, and all proposed replacements/deletions. The imported
grant must keep the same identity and namespace scope; provider default tags may
be added. EKS, RDS, and operator access replacements are not routine reconciliation.
The [existing-environment prerequisites](../infra/README.md#adopting-an-existing-environment)
still apply.

Once reviewed, apply through the authorized infra workflow. Its `apply` action
creates a fresh plan; it does not reuse a previous `plan` run. Keep Git and inputs
stable during this window; use an authorized local operator with a saved plan
when exact plan reuse is required.

Promote the tested image-tag revision in Argo after platform readiness. Check
migration/Rollout health and `curl -fsS https://fuelops.hemal.me/api/me`: anonymous
requests must report `auth_enabled: true` and `role: viewer`. Verify operator/admin
roles through the UI with existing tokens, without destructive actions. Retain
the previous healthy revision for rollback. Release-promotion and rollback
hardening remain separate increments.

## 4. Verify operator access and HTTPS

```bash
export AWS_PROFILE=work
aws eks update-kubeconfig --region ap-southeast-1 --name fuelops
kubectl -n monitoring get svc kps-grafana
kubectl -n monitoring port-forward --address=127.0.0.1 svc/kps-grafana 3000:80
```

After the monitoring/platform update, use `https://fuelops.hemal.me/grafana/`
with the same Grafana credentials. No DNS/certificate change is needed for this
subpath. In public mode, cookies require HTTPS; the local HTTP tunnel remains
useful for health checks, not browser login. Persistently setting
`grafana_ingress_enabled=false` restores localhost login at `/`. Until this
update, the older running instance uses `http://localhost:3000/grafana/login`.
Follow [HTTPS setup](HTTPS_SETUP.md) for route precedence, health/assets/login
checks and the remaining Argo certificate/DNS work.

Read-only observations on 2026-09-29: anonymous FuelOps access reported auth enabled
and viewer role; both ACM certificates were issued, only FuelOps' was attached;
Argo HTTPS timed out; Grafana was healthy on its older `/grafana` subpath. The
platform update and rollback rehearsal have not been verified by these checks.
