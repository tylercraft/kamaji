# The screenshots process's browser (ops/screenshots-plan.md): Microsoft's Playwright image,
# pinned by digest (v1.64.1-noble, arm64), with playwright-core at the same version and the shot
# script. The screenshots process builds it on the mini when this folder changes
# (packages/server/src/shots/image.ts); it's never pushed anywhere.
FROM mcr.microsoft.com/playwright@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f
RUN npm install --global --no-audit --no-fund playwright-core@1.64.1 && npm cache clean --force
COPY shoot.mjs guard.mjs /
USER pwuser
ENTRYPOINT ["node", "/shoot.mjs"]
