# Rapport de nuit — J18

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-26.md` lu en entier avant d'ouvrir quoi que ce
soit. Périmètre : les deux corrections d'abord (recherche de lieu vers `mock-maps`, endpoint
fantôme retiré), puis L6-09.

---

## Correction 1 — la recherche de lieu vers `mock-maps` (D19)

Même mécanisme que `GOOGLE_ROUTING_URL` côté Odoo (`services/odoo/addons/babana/services/
routing.py`) : une seule variable d'environnement fait pointer le module vers un fournisseur ou un
autre, aucune branche conditionnelle sur l'environnement dans le code.

**Deux formes différentes, pas seulement une URL différente**, comme l'écart de la nuit dernière
l'avait déjà identifié (`amoa/questions/C-01R.md` §2) : Google enveloppe chaque résultat dans
`geometry.location.{lat,lng}` avec une enveloppe `status` ; `mock-maps` sert des quartiers plats
`{name,latitude,longitude}` sans `status` du tout. `packages/maps/src/providers/google/places.ts`
porte maintenant un adaptateur de forme (`normalizeSearchResult`, duck-typing sur la présence du
champ `geometry` — jamais une lecture de l'environnement) et envoie systématiquement les deux noms
de paramètre de requête possibles (`query` pour Google, `q` pour `mock-maps`) : chaque serveur
ignore celui qu'il ne connaît pas, ce qui évite de faire dépendre le nom du paramètre du
fournisseur ciblé.

**La clé API devient optionnelle en pratique, sans cesser d'être obligatoire en configuration.**
`configureGoogleMapsProvider({ apiKey, searchUrl })` distingue maintenant « jamais configuré »
(`apiKey === undefined`, la vraie faute de câblage, toujours détectée) de « configuré à vide »
(`apiKey === ''`, le cas réel du développement avec `mock-maps`, qui n'a besoin d'aucune clé). La
version précédente confondait les deux (`!apiKey`), ce qui faisait échouer `searchPlace` avant même
d'atteindre le réseau dès que `BABANA_GOOGLE_MAPS_API_KEY` était vide — exactement le symptôme
décrit dans l'écart (« `PlacePicker` échoue silencieusement »). `searchPlace` n'envoie le paramètre
`key` que si une clé non vide est configurée.

`BABANA_MAPS_SEARCH_URL` (nouvelle variable, `apps/client/config.ts`) suit la convention déjà en
place dans ce fichier : défaut à la valeur de production si absente (l'adresse Google réelle, codée
dans `providers/google/places.ts::PLACES_TEXT_SEARCH_URL`), jamais à `mock-maps` — contrairement à
`GOOGLE_ROUTING_URL` côté Odoo, où le défaut de repli est `mock-maps` parce que ce code tourne
toujours dans le réseau Docker interne. Un build de production qui oublierait de définir cette
variable continuerait donc d'appeler la vraie API Google plutôt que de basculer silencieusement
vers un simulateur — l'erreur serait visible (`REQUEST_DENIED`, faute de clé), jamais un repli
muet. `infra/env/.env.example` la pointe vers `http://localhost:4001/search` : `mock-maps` expose
son port directement à l'hôte (`infra/compose.dev.yaml`, `ports: ["4001:4001"]`), le navigateur qui
exécute l'app web l'atteint donc sans passer par Caddy — pas besoin du montage jetable de la nuit
dernière.

**`infra/env/.env` (non suivi) régénéré.** Il datait d'avant plusieurs variables déjà présentes
dans `.env.example` (`GOOGLE_ROUTING_URL`, `BABANA_GOOGLE_MAPS_API_KEY`, les identifiants Google
Sign-In) — supprimé pour que `make up` le recrée à neuf depuis `.env.example`, seul moyen de lui
faire porter `BABANA_MAPS_SEARCH_URL` ce soir. Rien à perdre : ce fichier ne contient que des
valeurs de développement factices, jamais suivies par git.

**Fichiers.** `packages/maps/src/providers/google/config.ts`,
`packages/maps/src/providers/google/places.ts`, `packages/maps/test/places.test.ts` (cinq tests
ajoutés : clé vide acceptée, forme plate traduite, paramètre `q` envoyé, panne HTTP sans enveloppe
`status` levée explicitement, repli sur l'adresse Google réelle sans `searchUrl` configuré),
`apps/client/config.ts`, `apps/client/src/bootstrap.ts`, `infra/env/.env.example`,
`infra/env/README.md`.

**Vérifié.** `packages/maps` : 11/11 tests verts. `apps/client` : `tsc --noEmit` propre, 13 suites /
69 tests verts. `apps/driver` inchangé (n'utilise pas `searchPlace`, laissé tel quel). La preuve en
navigateur — un point de départ et d'arrivée réellement désignés par la recherche, contre le vrai
`mock-maps` — est réservée à la passe finale de fin de nuit, avec le parcours complet.

---

## Correction 2 — `GET /drivers/nearby` retiré du contrat

Arbitrage déjà posé la nuit dernière (`amoa/questions/REPONSES-2026-08-26.md` §2, `amoa/questions/
C-01R.md` §1) : la découverte de chauffeurs proches passe entièrement par `nearby.subscribe` /
`nearby.drivers` (C-02, flux WebSocket) — un abonnement tient la liste à jour pendant que le client
compare, ce qu'un `GET` ne fera jamais. L'endpoint n'a jamais été implémenté (vérifié par `grep`
avant d'écrire quoi que ce soit, comme le veut `CLAUDE.md`).

**Retiré, pas gardé en exception.** `nearbyDrivers` disparaît de `HTTP_ENDPOINTS`
(`packages/contracts/src/http/index.ts`) ainsi que `NearbyDriversQuerySchema`,
`NearbyDriversResponseSchema`, `NearbyDriversErrors` et leurs exemples
(`packages/contracts/src/http/driver.ts`). `NearbyDriverSchema` (l'objet chauffeur, singulier)
reste : c'est la forme partagée que `nearby.drivers` (WebSocket,
`packages/contracts/src/realtime/server-to-client.ts::NearbyDriversPayloadSchema`) réutilisait déjà
et continue de réutiliser seule — D17 (une seule définition) tenu, juste avec un seul consommateur
désormais plutôt que deux.

La suite de conformité (`test/http-contract/endpoint-coverage.test.ts`) perd son exception
`nearbyDrivers` de `NOT_YET_IMPLEMENTED` : elle n'a plus besoin de vérifier un 404 attendu, ce
endpoint n'existant simplement plus dans `HTTP_ENDPOINTS` — la vérification de complétude (chaque
clé du contrat doit apparaître dans `EXERCISES` ou `NOT_YET_IMPLEMENTED`, jamais dans aucun ni dans
les deux) n'a même plus à en connaître l'existence.

**Effet de bord révélé par `tsc`, pas par une recherche manuelle** : `nearbyDrivers` était le seul
endpoint `GET` du contrat à porter un `requestSchema` non nul (les paramètres de requête).
Une fois retiré, `packages/api-client/src/http/client.ts::attemptOnce` — générique sur
`Name extends EndpointName` — voyait son type `endpoint` se réduire à l'union exacte des
descripteurs restants, dans laquelle plus aucun membre ne combine `method: 'GET'` et
`requestSchema` non nul : TypeScript signalait la branche qui gère ce cas comme statiquement
impossible (`This comparison appears to be unintentional`). Corrigé par une annotation de type
explicite (`http.HttpEndpointDescriptor`, l'interface générale, pas le type littéral inféré) —
la branche reste posée, correctement typée, pour le prochain `GET` paramétré, même si aucun
endpoint ne l'exerce plus aujourd'hui. Les quatre tests de `packages/api-client/test/http/
client.test.ts` qui prenaient `nearbyDrivers` comme exemple générique de `GET` sont réécrits contre
`driverCash` (le seul autre `GET` authentifié du contrat), sans rien perdre de ce qu'ils
prouvaient (réessai, idempotence absente sur lecture, `ZodError` de réponse non rejouée).

**Doute noté, pas traité ce soir** : `LOCATION_REQUIRED` (catalogue général des erreurs,
`packages/contracts/src/http/errors.ts`) n'est plus déclaré par aucun endpoint — c'était la seule
erreur propre à `nearbyDrivers` en plus de `RATE_LIMITED` (toujours utilisé par
`phoneVerifyStart`). Rien ne le supprime automatiquement du catalogue, et rien ne l'exige : un
code d'erreur général inutilisé aujourd'hui n'est pas une faute, seulement un relief à surveiller
s'il traîne encore au moment d'un futur endpoint qui aurait besoin d'un motif voisin.

**Fichiers.** `packages/contracts/src/http/{index,driver,common,ride}.ts`,
`packages/contracts/src/realtime/server-to-client.ts`, `packages/contracts/test/{http,realtime}.
test.ts`, `packages/api-client/src/http/client.ts`, `packages/api-client/test/http/client.test.ts`,
`test/http-contract/endpoint-coverage.test.ts`, `docs/contracts/{http-api,realtime-events}.md`.

**Vérifié.** `packages/contracts` : build + génération des schémas JSON (plus de fichier
`nearbyDrivers` dans `dist/json-schema/`) + 63/63 tests verts. `packages/api-client` : `tsc
--noEmit` propre, 10 suites / 50 tests verts. `test/` (suite de conformité, `tsc -p tsconfig.json`)
compile sans erreur — son exécution contre la vraie pile est due à la passe finale, avec le
parcours complet.
