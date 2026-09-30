FROM cgr.dev/chainguard/wolfi-base:latest

RUN apk --no-cache add nodejs npm ca-certificates

WORKDIR /app
COPY . ./
RUN npm install && npm run build && apk --no-cache upgrade

EXPOSE 8000

ENTRYPOINT ["node", "dist/index.js"]
