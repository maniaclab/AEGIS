# --- Fetch the public USATLAS AF documentation -------------------------------
FROM cgr.dev/chainguard/wolfi-base:latest AS af-docs

# Branch, tag or commit sha of usatlas/af-docs to pull the docs from.
# Override with --build-arg AF_DOCS_REF=<sha> to pin, or to bust the build cache.
ARG AF_DOCS_REF=main

RUN apk --no-cache add curl gnutar findutils

# Keep only the Markdown, with the layout of the repo's docs/ directory intact.
RUN mkdir -p /tmp/src /af-docs && \
    curl -fsSL "https://codeload.github.com/usatlas/af-docs/tar.gz/${AF_DOCS_REF}" \
        | tar -xz -C /tmp/src && \
    cp -r /tmp/src/*/docs/. /af-docs/ && \
    find /af-docs -type f ! -name '*.md' -exec rm -f {} + && \
    find /af-docs -depth -type d -exec rmdir {} + 2>/dev/null || true

# --- Knowledge MCP server ----------------------------------------------------
FROM cgr.dev/chainguard/wolfi-base:latest

RUN apk --no-cache add nodejs npm

WORKDIR /app

COPY . ./

ENV ADC_DIR=/app/AnalysisFacilities

# Merged on top of the local knowledge base, so upstream af-docs wins on clashes.
COPY --from=af-docs /af-docs/ ${ADC_DIR}/

RUN npm install && npm run build

ENTRYPOINT ["npm", "start"]
