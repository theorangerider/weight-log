# Self-hosted Weight Log (Node.js + SQLite). See docs/self-hosting.md.
# No npm install: the server has no runtime dependencies (SQLite is built
# into Node), so the image is just Node plus the app's source files.
FROM node:24-alpine

WORKDIR /app
COPY package.json schema.sql ./
COPY migrations ./migrations
COPY public ./public
COPY src ./src
COPY server ./server

# Persistent data lives only in /data, which must be a volume or bind mount.
# VOLUME makes Docker create an anonymous volume if none is given, so data
# is never written into the container's own disposable filesystem.
RUN mkdir /data && chown node:node /data
VOLUME /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATABASE_PATH=/data/weight-log.sqlite

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "server/healthcheck.js"]

# Exec form so node is PID 1 and receives SIGTERM directly (server/main.js
# closes the server and the database cleanly).
CMD ["node", "server/main.js"]
