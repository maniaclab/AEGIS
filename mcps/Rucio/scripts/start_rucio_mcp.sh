#!/usr/bin/env bash

while true; do
    date
    ls ${X509_USER_PROXY}
    RESULT=$?
    if [ $RESULT -eq 0 ]; then
        break
    fi
    echo "INFO Waiting for the proxy."
    sleep 6
done

# exec rucio-mcp serve \
#     --transport "${RUCIO_MCP_TRANSPORT:-http}" \
#     --host 0.0.0.0 \
#     --port "${RUCIO_MCP_PORT:-8000}" \
#     --auth-type "${RUCIO_MCP_AUTH_TYPE:-x509_proxy}"

echo $RUCIO_MCP_TOKEN
exec rucio-mcp serve --transport "http" --host 0.0.0.0  --port "8000" --site atlas --auth-type "x509_proxy" --shared-secret ${RUCIO_MCP_TOKEN} --resource-url "https://rucio.atlas-ml.org"