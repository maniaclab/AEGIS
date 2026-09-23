FROM cgr.dev/chainguard/wolfi-base:latest

RUN apk --no-cache add nodejs npm ca-certificates

WORKDIR /app
COPY . ./
RUN npm install && npm run build && apk --no-cache upgrade

COPY scripts/ /opt/owl-mcp/
RUN chmod +x /opt/owl-mcp/*.sh

EXPOSE 8000

# One image, two roles: OWL_MODE=mcp (default) or OWL_MODE=worker.
ENTRYPOINT ["/opt/owl-mcp/start_owl_mcp.sh"]
