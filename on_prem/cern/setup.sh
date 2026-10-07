# login to lxplus8.cern.ch
source 'Personal ivukotic-openrc.sh'

# CLUSTERS
openstack coe cluster list

# Delete cluster if there is one
openstack coe cluster delete ivukotic

# check version of cluster templates
openstack coe cluster template list

# create a cluster with 3 nodes
openstack coe cluster create --keypair lxplus --cluster-template kubernetes-1.36.2-1 --flavor=m2.medium --node-count 3 --merge-labels --labels cinder_csi_enabled=True ivukotic

# get env
openstack coe cluster config ivukotic > env.sh

# login to the cluster
. ./env.sh

# bootstrap the cluster using fluxcd
flux bootstrap github --owner ATLAS-Analytics --repository=flux_admin --branch=main --path=clusters/ivukotic

# everything in this directory is deployed to the cluster using fluxcd.

# force reconcile the kustomization
flux reconcile kustomization aegis --with-source

# check flux state
flux get all -A                     # everything at a glance
flux get kustomizations             # READY + applied revision + error message
flux get sources git
flux get helmreleases -A

flux get kustomizations --watch     # live updates

kubectl -n flux-system describe kustomization aegis     # conditions + events
flux events --for Kustomization/aegis
flux logs --kind=Kustomization --name=aegis --level=error

flux tree kustomization aegis  # list every object it manages