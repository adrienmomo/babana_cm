# Squelette minimal (L0-01) — remplacé par L0-04. Node 22 par cohérence avec
# amoa/04-monorepo-et-services.md §3 ("realtime | Construit, Node 22").
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/realtime ./services/realtime
EXPOSE 3000
CMD ["node", "services/realtime/src/index.js"]
