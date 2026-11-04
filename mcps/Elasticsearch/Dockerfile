# FROM cgr.dev/chainguard/node:latest
FROM cgr.dev/chainguard/wolfi-base:latest
# FROM node:alpine

RUN apk --no-cache add nodejs npm

WORKDIR /app
COPY . ./
RUN npm install && npm run build && npm prune --omit=dev

ENTRYPOINT ["npm", "start"]