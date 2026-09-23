#!/usr/bin/env sh

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

npm start
