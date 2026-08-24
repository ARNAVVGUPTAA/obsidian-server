FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./

# The `node` user already exists at uid/gid 1000, which lines up with the
# typical host user owning the bind-mounted ./data directory.
RUN mkdir -p /data && chown -R node:node /app /data

USER node

ENV PORT=2222
ENV DATA_DIR=/data

EXPOSE 2222

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:2222/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
