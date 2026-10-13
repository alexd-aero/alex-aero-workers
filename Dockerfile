# Alex·Aero: one image for x86_64 and arm64 (Raspberry Pi 4/5, Apple Silicon, Graviton).
# Node serves the dashboard and workers directly on $PUBLIC_PORT (no nginx needed).
FROM node:22-bookworm-slim

ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 bash curl ca-certificates tini procps \
 && rm -rf /var/lib/apt/lists/* \
 && arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
 && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}" -o /usr/local/bin/cloudflared \
 && chmod +x /usr/local/bin/cloudflared

WORKDIR /app
RUN npm install --prefix /app/.workerd-local workerd --no-audit --no-fund \
 && npm cache clean --force

COPY package.json server.js run.sh kill.sh ./
COPY public ./public
COPY bin ./bin
RUN mkdir -p /app/storage && chown -R node:node /app

USER node
ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    PUBLIC_PORT=27715 \
    BACKEND_PORT=27715
VOLUME ["/app/storage"]
EXPOSE 27715
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s CMD curl -fsS "http://127.0.0.1:${BACKEND_PORT}/api/health" || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
