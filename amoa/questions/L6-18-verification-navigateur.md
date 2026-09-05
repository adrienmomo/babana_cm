# Écart — vérification navigateur de L6-18, deux tensions rencontrées (5 septembre 2026)

Consigné plutôt que contourné en silence, conformément au protocole. Les deux points sont
résolus pour cette nuit ; ils méritent d'être tranchés explicitement avant le pilote.

## 1. Le prérequis GCP n'était pas fait

`amoa/PROMPT-NUIT-J48.md` demandait un projet Google Cloud (identifiant OAuth Web + clé Maps
JavaScript) déposé dans `infra/env/.env` avant la nuit — nécessaire pour deux des trois pièces.
Constaté en ouvrant le fichier : toujours les valeurs factices de `.env.example`. Signalé
immédiatement plutôt que de construire un contournement de développement en silence ; les deux
valeurs ont été fournies en cours de session et déposées dans `infra/env/.env` (jamais commité,
`.gitignore` vérifié). Elles y restent maintenant — real credentials en clair sur ce poste,
comme tout le reste de ce fichier.

**Ce que ça change pour la prochaine fois** : si une nuit future doit à nouveau vérifier un flux
qui dépend d'un compte externe réel, le déposer dans `.env` AVANT le lancement reste la bonne
méthode — mais le prompt de lancement devrait le vérifier lui-même (`grep` sur la valeur factice)
plutôt que de compter sur la nuit pour s'en apercevoir.

## 2. `GOOGLE_JWKS_URL` n'a qu'une seule source à la fois — D19 et une vérification réelle
   sont en tension

`services/odoo/addons/babana/services/google_identity.py::_jwks_url` lit une seule variable
globale. En développement, elle pointe vers `mock-google-identity` (`infra/compose.dev.yaml`) —
c'est ce qui permet à `make seed-drivers`, aux tests d'intégration et à toute connexion native
simulée de fonctionner sans compte externe (D19). Un ID token **réellement signé par Google**
(le flux web GIS, avec le vrai identifiant client) ne vérifie jamais contre les clés du
simulateur — l'inverse est vrai aussi.

**Constaté en vérifiant ce soir** : `make seed-drivers` échouait (`INVALID_GOOGLE_TOKEN`) pendant
la fenêtre où j'avais basculé `GOOGLE_JWKS_URL` vers `https://www.googleapis.com/oauth2/v3/certs`
pour authentifier réellement le navigateur — les chauffeurs de démonstration utilisent
`mock-google-identity`, désormais non reconnu. Un seul environnement Odoo ne peut donc pas, en
même temps, vérifier un jeton mock ET un jeton réel : la démonstration complète (connexion web
réelle + chauffeurs simulés en ligne) n'est pas possible avec l'architecture actuelle sans un
second Odoo ou un mécanisme de sélection par émetteur.

**Contourné pour ce soir** : bascule temporaire de `GOOGLE_JWKS_URL` (surcharge Compose locale,
jamais committée) pour la fenêtre de vérification du flux web réel, puis retour immédiat à la
configuration standard (mock) avant `make reset`/`make seed`/`make test`. Aucune trace laissée
dans le dépôt (`git status` vérifié après coup, `infra/caddy/Caddyfile` et `infra/compose*.yaml`
identiques à `master`).

**Proposition** : si le pilote a un jour besoin de faire cohabiter un flux d'authentification
réel (recette, démonstration client) et des acteurs simulés (chauffeurs de test) dans le même
environnement, `google_identity.py` devra accepter plusieurs sources JWKS (par exemple choisies
par l'émetteur déclaré dans l'en-tête du jeton, ou une liste au lieu d'une valeur unique) — hors
du périmètre de L6-18, à trancher si/quand ce besoin se présente réellement.

## 3. Choix d'implémentation non bloquant, mentionné pour mémoire

Le fichier que la spécification nomme (`packages/api-client/src/auth/web.ts`) a été livré sous le
nom `googleSignIn.web.ts` — extension `.web.ts` du fichier natif `googleSignIn.ts`, cohérent avec
le mécanisme déjà en place dans ce dépôt (`location.web.ts`, `config.web.ts`) et avec
`tokenStorage.web.ts`/`activeProvider.web.ts` ajoutés cette même nuit. Ce choix évite un fichier
`index.web.ts` supplémentaire pour faire le pont de nommage. Nommage interne, ne justifiait pas un
arrêt (CLAUDE.md, protocole d'écart).
