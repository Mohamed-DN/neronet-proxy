# ADR 0012: Deploy on virtual machines with compose and systemd first; Kubernetes later

- Status: Accepted (reviewer's recommendation under delegated authority, 2026-09-19)
- Date: 2026-09-19
- Decision label: D6

## Context

The repository holds a compose stack for development, a Helm chart, Kustomize overlays
for six cloud providers and Terraform modules. Only the compose stack has been run. The
Helm chart and the manifests have never been applied to a cluster, and the GitOps
workflow, which deployed nothing, was removed by the CI rework. The typical installation in a
bank or a public administration is on virtual machines on premises.

## Decision

The order is:

1. Single node: compose (or Podman) and systemd, with one command to install.
2. High availability on three virtual machines: three control-plane instances behind a
   load balancer, PostgreSQL with Patroni and three etcd voters in separate failure
   domains ([ADR 0001](0001-no-multi-master-postgresql.md)).
3. Kubernetes and OpenShift: the Helm chart, proven in CI on `kind`, after the two
   above.

The multi-cloud Terraform modules are removed until a customer asks for them. The GitOps
deploy workflow, which deployed nothing, has already been removed.

## Consequences

- `charts/`, `k8s/` and `terraform/` are unsupported and untested. Documents that
  mention them say so.
- Installation documentation is written for a virtual machine first. The lab used to
  prove it can be a Proxmox host.
- Removal of the Terraform modules is separate work; until it is done they remain in the
  tree.
