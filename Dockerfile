# One build, three images:
#   docker build --target house       -t ghcr.io/thelakeprotocol/lake-house .
#   docker build --target specialists -t ghcr.io/thelakeprotocol/lake-specialists .
#   docker build --target cli         -t ghcr.io/thelakeprotocol/lake .
FROM node:22-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages packages
COPY site/package.json site/package.json
RUN pnpm install --frozen-lockfile --filter "./packages/**"
RUN pnpm -r --filter "./packages/**" build
RUN pnpm deploy --filter @thelakeprotocol/house --prod /out/house \
 && pnpm deploy --filter @thelakeprotocol/specialists --prod /out/specialists \
 && pnpm deploy --filter @thelakeprotocol/visitor --prod /out/cli

FROM node:22-slim AS house
LABEL org.opencontainers.image.source=https://github.com/thelakeprotocol/lake \
      org.opencontainers.image.description="A Lake house: your Solid pod and the housekeeper that guards it." \
      org.opencontainers.image.licenses=Apache-2.0
WORKDIR /app
COPY --from=build /out/house .
COPY personas /personas
COPY personas/stan.yaml /rules.yaml
ENV LAKE_DATA=/data LAKE_RULES=/rules.yaml NODE_ENV=production
VOLUME /data
EXPOSE 4000 3000
ENTRYPOINT ["node", "dist/main.js"]

FROM node:22-slim AS specialists
LABEL org.opencontainers.image.source=https://github.com/thelakeprotocol/lake \
      org.opencontainers.image.description="Lake specialist agents (issuer now; ethics, auditor, payments next)." \
      org.opencontainers.image.licenses=Apache-2.0
WORKDIR /app
COPY --from=build /out/specialists .
ENV NODE_ENV=production
VOLUME /data
EXPOSE 4300
ENTRYPOINT ["node", "dist/main.js"]
CMD ["issuer"]

FROM node:22-slim AS cli
LABEL org.opencontainers.image.source=https://github.com/thelakeprotocol/lake \
      org.opencontainers.image.description="The lake CLI: knock, and soon dispatch, attack, revoke." \
      org.opencontainers.image.licenses=Apache-2.0
WORKDIR /app
COPY --from=build /out/cli .
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/cli.js"]
