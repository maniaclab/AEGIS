FROM python:3.13-slim

RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

RUN apt-get update && \
    apt-get install cmake osg-ca-certs --no-install-recommends --assume-yes

RUN pip install --no-cache-dir rucio-mcp rucio-clients

COPY scripts/ /opt/rucio-mcp/
RUN chmod +x /opt/rucio-mcp/*.sh

ENV X509_USER_PROXY=/etc/grid-security-ro/x509up
ENV X509_CERT_DIR=/etc/grid-security/certificates

EXPOSE 8000

ENTRYPOINT ["/opt/rucio-mcp/start_rucio_mcp.sh"]
