FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates dumb-init ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package.json server.mjs ./

ENV NODE_ENV=production \
    PORT=8080

USER node
EXPOSE 8080

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.mjs"]
