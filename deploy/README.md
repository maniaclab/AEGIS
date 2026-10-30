# Deployment of AEGIS k8s resources

Deployed on the UChicago AF cluster (namespace `aegis`) by Flux, which watches `main` of this repository.
The CERN OpenStack deployment lives in [`../deploy-CERN/`](../deploy-CERN/) and is separate.
Sealed secrets are encrypted per cluster, so a `*-sealed.yaml` from `deploy-CERN/` will not decrypt here (and vice versa).
All deployments have 1 replica and no PodDisruptionBudget.
Images are tagged `latest` and with the build date (`YYYY-MM-DD`); the commit SHA is recorded in the `org.opencontainers.image.revision` label. Deployments use date tags.
