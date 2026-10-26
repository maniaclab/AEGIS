# Deployment of AEGIS k8s resources

Deployed on AF UC cluster.
All deployments have 1 replica and no PodDisruptionBudget.
Images are tagged `latest` and with the build date (`YYYY-MM-DD`); the commit SHA is recorded in the `org.opencontainers.image.revision` label. Deployments use date tags.
