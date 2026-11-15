# Gatekeeper agent image (for the deploy-elsewhere path, e.g. Fly.io/Render).
# The HMAC secret MUST be passed as an environment variable at runtime
# (AGENT_GAMES_HMAC_SECRET) — never baked into the image.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js config.js decide.js circuit.js store.js onchain.js ./
COPY circuits/ ./circuits/
RUN mkdir -p data && chown -R node:node /app
USER node
ENV PORT=8788 HOST=0.0.0.0
EXPOSE 8788
CMD ["node", "server.js"]
