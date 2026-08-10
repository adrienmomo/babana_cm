# Construction en deux temps : l'image finale n'embarque ni TypeScript ni les sources, pour
# rester légère (Node 22 -- amoa/04-monorepo-et-services.md §3, "realtime | Construit, Node 22").
FROM node:22-alpine AS build
WORKDIR /app
# Pas de package-lock.json ici, volontairement : le lockfile de la racine encode l'arbre complet
# du monorepo, apps/* compris (react-native, dont une chaîne de dépendances transitives fige
# ws@6.2.6). apps/* est absent de ce contexte de build (.dockerignore) ; copier ce lockfile tel
# quel faisait quand même hoister ws@6.2.6 à la racine de l'image, masquant le ws@8.21.3 déclaré
# par @babana/realtime lui-même -- trouvé en testant le conteneur réel, pas en le lisant.
COPY package.json tsconfig.base.json ./
COPY packages ./packages
COPY services/realtime ./services/realtime
RUN npm install
# Ordre explicite : @babana/realtime importe les types de @babana/contracts, qui doit donc être
# compilé (dist/) avant lui -- deux étapes séparées plutôt qu'un seul appel multi-workspace, dont
# l'ordre d'exécution n'est pas garanti.
RUN npm run build -w @babana/contracts
RUN npm run build -w @babana/realtime

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/realtime/dist ./services/realtime/dist
COPY --from=build /app/services/realtime/package.json ./services/realtime/package.json
WORKDIR /app/services/realtime
EXPOSE 3000
CMD ["node", "dist/index.js"]
