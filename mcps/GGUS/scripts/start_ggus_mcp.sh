#!/usr/bin/env sh

if [ -z "${GGUS_TOKEN}" ]; then
    echo "ERROR: GGUS_TOKEN environment variable is not set."
    exit 1
fi

npm start
