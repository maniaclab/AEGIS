FROM cgr.dev/chainguard/wolfi-base:latest

RUN apk --no-cache add nodejs npm ca-certificates

WORKDIR /app
COPY . ./
RUN npm install && npm run build && apk --no-cache upgrade

COPY scripts/ /opt/ggus-mcp/
RUN chmod +x /opt/ggus-mcp/*.sh

EXPOSE 8000

ENTRYPOINT ["/opt/ggus-mcp/start_ggus_mcp.sh"]
