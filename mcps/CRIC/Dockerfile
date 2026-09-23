FROM almalinux:10 AS osg-certs
RUN dnf install -y https://repo.osg-htc.org/osg/25-main/osg-25-main-el10-release-latest.rpm && \
    dnf install -y osg-ca-certs && \
    dnf clean all

FROM cgr.dev/chainguard/wolfi-base:latest

RUN apk --no-cache add nodejs npm

WORKDIR /app
COPY . ./
RUN npm install && npm run build
RUN apk --no-cache upgrade && \
    apk --no-cache add cmake ca-certificates curl

COPY --from=osg-certs /etc/grid-security/certificates/ /etc/grid-security/certificates/
COPY scripts/ /opt/cric-mcp/
RUN chmod +x /opt/cric-mcp/*.sh

ENV X509_USER_PROXY=/etc/grid-security-ro/x509up
ENV X509_CERT_DIR=/etc/grid-security/certificates

EXPOSE 8000

ENTRYPOINT ["/opt/cric-mcp/start_cric_mcp.sh"]
