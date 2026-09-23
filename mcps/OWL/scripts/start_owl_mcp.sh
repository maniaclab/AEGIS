#!/usr/bin/env sh
#
# Entrypoint for both OWL processes. OWL_MODE selects which one this container is.
# `exec` matters: node must be PID 1's direct replacement so it receives SIGTERM
# from the kubelet and can close the pg pool instead of being killed after the
# termination grace period.

if [ -z "${DATABASE_URL}" ]; then
    echo "ERROR: DATABASE_URL environment variable is not set."
    exit 1
fi

case "${OWL_MODE:-mcp}" in
    mcp)
        exec node dist/index.js
        ;;
    worker)
        exec node dist/worker.js
        ;;
    *)
        echo "ERROR: OWL_MODE must be 'mcp' or 'worker', got '${OWL_MODE}'."
        exit 1
        ;;
esac
