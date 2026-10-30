# Deployment of AEGIS k8s resources

Deployed on the ATLAS Analytics Kubernetes cluster at CERN OpenStack (namespace `aegis`).
The UChicago AF deployment lives in [`../deploy/`](../deploy/) and is separate; keep changes in sync by hand where both need them.
Sealed secrets are encrypted per cluster, so a `*-sealed.yaml` from `deploy/` will not decrypt here (and vice versa).
All deployments have 1 replica and no PodDisruptionBudget.
Images are tagged `latest` and with the build date (`YYYY-MM-DD`); the commit SHA is recorded in the `org.opencontainers.image.revision` label. Deployments use date tags.

Cluster management tips:

```bash
openstack coe cluster list

# check version of cluster templates
openstack coe cluster template list

# Delete cluster
openstack coe cluster delete aegis

# Create cluster
openstack coe cluster create --keypair lxplus --cluster-template kubernetes-1.36.2-1 --flavor=m2.medium --node-count 4 --merge-labels --labels eos_enabled=false --labels cvmfs_csi_enabled=false aegis

# Get the script to configure the cluster for later use
openstack coe cluster config aegis > env-aegis.sh

# then follow Readme from flux_admin repo to install flux, seal secrets key, bootstrap everything.
```