# Rapport de la session de nuit — J1

Démarrage : 2026-08-09.

## État par tâche

| ID | Statut | Branche | Commentaire |
|---|---|---|---|
| C-03 | finie | `C-03-ride-state-machine` | Table de transitions complète en `code/docs/contracts/ride-state-machine.md` + source JSON + script de vérification. Deux écarts consignés (voir Questions ouvertes) |
| C-01 | finie | `C-01-http-contracts` | `@babana/contracts` (Zod), 19 endpoints, 27 codes d'erreur, `docs/contracts/http-api.md`. Bootstrap minimal du monorepo npm en avance sur L0-03 |
| C-02 | finie | `C-02-realtime-contracts` | 22 messages WebSocket (`z.discriminatedUnion`), politique de reconnexion dans `docs/contracts/realtime-events.md`. Réutilise `NearbyDriverSchema`/`RideStateSchema` de C-01. Bug de test trouvé grâce à un trou de couverture `tsc` (voir hypothèses) |
| L0-01 | finie | `L0-01-docker-infra` | 7 services sains vérifiés en vrai (`make up`, `make reset && make up`). Bug trouvé et corrigé dans le Caddyfile de référence (assetlinks.json 404). Squelettes minimaux pour realtime/mocks, complétés par L0-04/L0-08 ce soir |
| L0-02 | finie | `L0-02-odoo-module-skeleton` | Module babana : 3 groupes, catégorie dédiée. Installation/désinstallation/réinstallation et `--test-enable` vérifiés contre le conteneur réel. Deux bugs trouvés (commentaire XML `--`, `make test` cassé depuis L0-01) |
| L0-08 | non commencée | — | — |
| L0-03 | non commencée | — | — |
| L0-04 | non commencée | — | — |
| L0-06 | non commencée | — | — |

## Ce qui tourne

Depuis `code/` :

```bash
npm install    # 9 paquets, aucune vulnérabilité signalée
npm test       # 48 tests (node:test via tsx) + vérification structurelle de la machine à états — tout vert
npm run build --workspaces --if-present   # compile @babana/contracts, génère dist/json-schema/ (19 endpoints x 2 + errors.json)
npm run typecheck --workspaces --if-present   # tsc --noEmit propre
```

`make` n'existe pas encore (arrive avec L0-01) : les commandes ci-dessus sont l'équivalent
provisoire de `make test` / `make lint` tant que le Makefile n'est pas créé.

**Mise à jour L0-01** — depuis `code/`, sur cette machine, à l'instant du commit :

```bash
cp infra/env/.env.example infra/env/.env    # fait automatiquement par `make up` sinon
make up             # sept services sains : postgres, redis, odoo, realtime, caddy, minio, mailpit
                     # + mock-google-identity, mock-maps (compose.dev.yaml)
make verify          # infra/smoke-test.sh : 5/5 vérifications automatiques passent
make secrets-scan    # tools/secret-scan/scan.sh : aucun secret détecté
make reset && make up   # reconstruit un environnement complet et vierge -- vérifié, exit 0
```

Endpoints vérifiés par `curl` réel (pas seulement lus dans la configuration) :
`https://api.localhost/web/health` (200), `https://api.localhost/rt/health` (200),
`https://admin.localhost` (303, redirection Odoo normale), `https://localhost/.well-known/assetlinks.json`
(200), `https://admin.localhost` avec `ADMIN_ALLOWED_IPS` restrictif (403, testé manuellement en
recréant le conteneur caddy avec une plage n'incluant pas l'appelant). Objet MinIO déposé dans
`babana-documents` puis lu en direct sans URL signée : 403.

`make client`, `make driver` et `make seed` ne fonctionnent pas encore : `@babana/client`,
`@babana/driver` (L0-03) et `services/odoo/scripts/seed.py` (hors lot de cette nuit) n'existent
pas. Attendu à ce stade, pas un défaut de L0-01.

## Ce qui ne tourne pas

_(à compléter)_

## Questions ouvertes

- `amoa/questions/L0-01.md` — le bloc `/.well-known/assetlinks.json` du Caddyfile donné « tel
  quel » par `04-monorepo-et-services.md` §7 ne sert pas le fichier (404, `root` sans réécriture
  de chemin). Corrigé dans le code, non bloquant, à corriger dans le document de référence.
- `amoa/questions/C-03.md` — deux écarts sur la machine à états : (1) le critère d'acceptation 1
  de C-03 exige que `cancelled` apparaisse en source, ce qui contredit son caractère terminal ;
  (2) le critère d'acceptation 3 de C-01 exige exactement quatre écritures Odoo, mais
  l'annulation doit aussi écrire pour rester traçable. Hypothèse appliquée dans les deux cas
  (documentée dans le fichier). **Bloquant pour L4-01/L4-02**, pas pour cette nuit.

## Hypothèses prises

- **C-03** : `draft` n'est jamais persisté en base — le premier enregistrement `babana.ride`
  naît directement en `state = requested`. Choix non spécifié explicitement, mais cohérent avec
  le critère « `draft` jamais cible ».
- **C-03** : `cancelled` est traité comme un état terminal (aucune transition sortante), au même
  titre que `settled`. Voir `amoa/questions/C-03.md`, écart 1.
- **C-03** : les écritures Odoo déclenchées par une annulation sont des « écritures de clôture »,
  distinctes des quatre moments de la règle de partition. Voir `amoa/questions/C-03.md`, écart 2.
- **C-03** : ajout d'une transition `rejected → cancelled`, non listée dans le minimum de la
  spécification, pour couvrir le cas où le client abandonne après un refus sans resélectionner.
- **C-03** : `in_progress → cancelled` déclarée transition interdite (absente du minimum
  spécifié) — une fois le trajet démarré physiquement, la course va jusqu'à `completed` ; un
  incident se traite via `babana.incident`, hors machine à états. À confirmer.
- **C-03** : le script `verify-ride-state-machine.js` n'est pas encore branché sur `make test`
  (le Makefile n'existe pas avant L0-01) — **mis à jour** : branché sur `npm test` à la racine
  de `code/` pendant C-01, reste à raccorder à `make test` quand L0-01 crée le Makefile.
- **C-01** : bootstrap minimal du monorepo npm (`code/package.json`, workspaces
  `["packages/*"]`) créé en avance sur L0-03, seulement ce qui est nécessaire pour que
  `@babana/contracts` compile. L0-03 étendra les workspaces.
- **C-01** : ajout de `driver.ts`, `phone.ts`, `common.ts` — non listés dans l'arborescence de
  C-01, qui ne couvre que 6 des 8 familles d'endpoints. Détail dans le message de commit.
- **C-01** : authentification lue littéralement — seul `/auth/google` est public ;
  `/auth/refresh` et `/auth/logout` exigent aussi `Authorization: Bearer`.
- **C-01** : `NO_DRIVER_AVAILABLE` conservé au catalogue (exigé par la spécification) mais
  n'est émis par aucun endpoint de ce lot, puisque D10 fait choisir le client sur une liste qui
  peut être vide plutôt que de renvoyer une erreur.
- **C-02** : `client-to-server.ts` / `server-to-client.ts` regroupent chacun les deux familles
  d'émetteurs (chauffeur + client) de la spécification, qui n'en prévoit que deux fichiers pour
  quatre familles décrites en prose.
- **C-02** : `ride.cancelled` a un seul émetteur (le serveur) mais deux destinataires possibles
  (chauffeur et/ou client) — un seul message, pas deux, le critère d'acceptation 1 portant sur
  l'émetteur, pas sur le nombre de destinataires.
- **C-02** : ajout de `session.resync` / `session.synced`, absents des listes de messages
  nommées par la spécification mais nécessaires pour que la politique de reconnexion (exigée en
  prose par le critère d'acceptation 2) soit du code exécutable, pas seulement un paragraphe.
- **L0-01** : squelettes minimaux (un endpoint `/health`, rien d'autre) créés pour
  `services/realtime` et `services/mocks/{google-identity,maps}`, seulement pour que `make up`
  produise sept services sains dès ce soir — `compose.yaml`/`compose.dev.yaml` les référencent
  mais L0-04 et L0-08 n'ont pas encore tourné. Remplacés entièrement par ces deux tâches.
- **L0-01** : `services/odoo/Dockerfile` utilise `PyJWT[crypto]` plutôt que `google-auth` —
  seule bibliothèque des deux dont l'API accepte une URL de jeu de clés configurable
  (`GOOGLE_JWKS_URL`), nécessaire pour substituer `mock-google-identity` sans branche
  conditionnelle (D19, piège explicite de L0-08).
- **L0-01** : `GOOGLE_JWKS_URL` ajouté aux variables d'environnement d'Odoo dans `compose.yaml`
  — décrite par la section L0-08 du même document, absente du snippet `compose.yaml` du §4.
- **L0-01** : `make up` attend la fin de tous les healthchecks via `docker compose up --wait`
  plutôt que la cible `wait` donnée (`grep healthy` puis `sleep 5` unique) — insuffisante pour
  attendre qu'Odoo devienne sain (jusqu'à 200s avec les paramètres de healthcheck donnés).
- **L0-01** : le service temps réel répond à la fois sur `/health` (healthcheck Docker interne,
  sans passer par Caddy, chemin nu spécifié par L0-04) et `/rt/health` (chemin public à travers
  Caddy, qui proxie `/rt/*` sans réécriture de préfixe) — nécessaire pour que le critère
  d'acceptation 2 de L0-01 et le critère d'acceptation 1 de L0-04 soient tous deux satisfaits.
- **L0-01** : `infra/minio/bootstrap.sh` reconfigure l'alias `mc` "local" avec les identifiants
  racine avant de créer le compartiment — l'alias préconfiguré par l'image n'a aucun identifiant,
  suffisant pour le healthcheck (`mc ready`) mais pas pour créer un compartiment.
- **L0-01** : deux nouvelles cibles Makefile non listées dans `CLAUDE.md` (`make verify`,
  `make secrets-scan`) — ajouts additifs pour rendre vérifiables les critères d'acceptation 2,
  4, 5, 6 de L0-01, pas une redéfinition d'une commande existante.
- **L0-02** : licence `LGPL-3` pour le module (choix non spécifié — aligné sur la licence d'Odoo
  Community lui-même, à revoir si l'éditeur souhaite une licence propriétaire).
- **L0-02** : noms de groupe en français (« Superviseur », « Gestionnaire », « Administrateur »)
  plutôt que les identifiants techniques anglais de la spécification — cohérent avec la
  convention `CLAUDE.md` « interface en français », puisque ces noms s'affichent dans le
  back-office.
- **L0-02** : `make test` a révélé un défaut qui existait déjà silencieusement depuis L0-01 —
  `docker compose exec` ne passe pas par l'entrypoint qui traduit HOST/USER/PASSWORD en
  arguments `--db_*`. La cible `test` du Makefile n'avait jamais été exécutée jusqu'à ce que
  L0-02 fournisse un module à tester. Corrigé (voir message de commit).
- **C-02** : incidemment, `tsconfig.json` de `@babana/contracts` ne couvrait que `src/` —
  `npm run typecheck` ne voyait jamais `test/`. Un doublon d'import dans un test aurait pu
  passer inaperçu indéfiniment. Ajout de `tsconfig.typecheck.json` qui couvre aussi `test/` et
  `scripts/` ; a fait remonter 4 erreurs supplémentaires (dont le doublon), toutes corrigées.

## Ce que je ferais ensuite

_(à compléter en fin de session)_
