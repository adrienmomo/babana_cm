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
