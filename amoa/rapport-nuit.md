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
| L0-08 | finie | `L0-08-mocks` | mock-google-identity (JWKS + 5 variantes invalides, vérifiées par signature réelle) et mock-maps (routage déterministe, recherche Douala, panne simulée). Critères 1 et 5 hors de portée ce soir (dépendances non traitées), documenté dans `services/mocks/README.md` |
| L0-03 | partielle | `L0-03-react-native-monorepo` | 6/7 critères vérifiés contre les outils réels (npm install, Metro, tsc, jest, eslint, config de build). Critère 4 (APK release) bloqué : aucun SDK Android sur cette machine, voir `amoa/questions/L0-03.md` |
| L0-04 | finie | `L0-04-realtime-skeleton` | Serveur HTTP + WebSocket, config validée, client Odoo avec réessais, zéro client PostgreSQL. Tous les critères vérifiés contre la pile réelle. Deux bugs Docker trouvés et corrigés (ws mal résolu, tsconfig.base.json manquant) |
| L0-06 | finie | `L0-06-env-secrets` | `.env.example` étendu à toutes les variables listées, `infra/env/README.md` (table complète + rotation par secret). Vérifié : `cp .env.example .env && make up` reproduit les 9 services sains. Écart mailpit/production documenté |

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

**Accès back-office Odoo** (`https://admin.localhost`, base `babana`) : `admin` / `admin`. C'est
le compte de démo qu'Odoo crée par défaut à la création de la base (`-i babana` charge les
données de démo) — je n'ai fixé aucun mot de passe nulle part (invariant 5, aucun secret dans le
dépôt), donc c'est un défaut Odoo, pas un choix. Vérifié par `POST /web/session/authenticate`,
`uid: 2`, `is_admin: true`. À changer avant toute exposition au-delà du poste de développement.

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

**Mise à jour L0-08** — vérifié contre les conteneurs réels (`docker compose up -d --build
mock-google-identity mock-maps`) : jeton valide vérifié avec succès (`node:crypto.verify`)
contre le JWKS publié par `GET http://localhost:4000/.well-known/jwks.json` ; les cinq variantes
`invalid` (`aud`, `exp`, `email_verified`, `signature`, `iss`) produisent chacune exactement
l'altération attendue, `signature` échoue bien la vérification. `GET /route` déterministe sur
appels répétés identiques ; `GET /search?q=bepanda` trouve « Bépanda » malgré l'absence
d'accent. `POST /_control/fail` fait passer `/route` de 200 à 503 puis retour à 200.
`docker run -e NODE_ENV=production` sur chacune des deux images : exit 1, message explicite.

**Mise à jour L0-03** — depuis `code/` :

```bash
npm install                                    # 868+ paquets, symlinks node_modules/@babana/* confirmés
npm run build --workspaces --if-present        # packages/{contracts,ui,maps,api-client} compilent
npm run typecheck --workspaces --if-present    # exit 0, les 4 paquets + les 2 apps
npm run lint --workspaces --if-present         # exit 0
npm test                                       # exit 0, jest inclus (App.tsx rendu, react-test-renderer)
npm run start -w @babana/client                # Metro sur :8081, /status -> 200, bundle Android ~4,1 Mo
npm run start -w @babana/driver                # idem sur :8082
```

Bundle Android de chaque app vérifié par téléchargement direct
(`curl .../index.bundle?platform=android&dev=true`) et recherche du texte de l'écran et d'une
constante de `@babana/ui` dedans — présents dans les deux. `BABANA_API_URL=https://api.localhost
npm run start -w @babana/client` change bien l'URL figée dans le bundle par rapport à la valeur
par défaut `https://api.babana.cm`.

**Ne tourne pas** : `npm run android` / `./gradlew assembleRelease` — aucun SDK Android sur cette
machine (`ANDROID_HOME` non défini, aucun dossier SDK trouvé). Détail dans
`amoa/questions/L0-03.md`.

**Mise à jour L0-04** — service réel, reconstruit et vérifié contre `make up` :

```bash
curl -k https://api.localhost/rt/health
# {"ok":true,"dependencies":{"redis":"ok","odoo":"ok"}}
```

Lancé sans les variables requises (`node dist/index.js` avec seulement `PORT` et `REDIS_URL`
positionnés) : sortie exacte —

```
Configuration invalide, le service refuse de démarrer :
  - ODOO_INTERNAL_URL : Required
  - REALTIME_SHARED_SECRET : Required
  - JWT_SECRET : Required
exit=1
```

Connexion WebSocket réelle sans jeton vers `wss://api.localhost/rt/ws` : fermée avec le code
`4401`. `make test` complet (paquets + apps + service temps réel + suite Odoo) : exit 0.

## Ce qui ne tourne pas

_(à compléter)_

## Questions ouvertes

- `amoa/questions/L0-06.md` — `mailpit` fait partie des sept services de `infra/compose.yaml`
  (censé tourner identiquement en dev et en production selon D18), mais capture le courrier sans
  jamais le relayer : les factures réelles de production (CDC §III.3) ne partiraient jamais.
  Aucune bascule vers un vrai relais SMTP n'existe. **Bloquant avant L0-07**, pas avant.
  Écart secondaire mineur : fournisseurs SMS et FCM non nommés, pour information de L1-09.
- **Note d'exploitation, pas un fichier de question** : un bind mount Docker Desktop (macOS,
  gRPC-FUSE) s'est figé à trois reprises cette nuit après une recréation de conteneur ailleurs
  dans le projet compose (`services/odoo/addons` pendant L0-02, `infra/caddy/wellknown` puis
  `services/odoo/addons` à nouveau pendant L0-04) — le répertoire apparaît vide côté conteneur
  alors qu'il ne l'est pas côté hôte. `docker compose restart <service>` le résout à chaque fois.
  Si ça se reproduit demain : ce n'est pas un défaut du dépôt, vérifier d'abord avec un
  redémarrage du conteneur concerné avant de chercher plus loin. Envisager de vérifier le mode
  de partage de fichiers de Docker Desktop (VirtioFS plutôt que gRPC-FUSE) si ça devient gênant.
- `amoa/questions/L0-03.md` — critère d'acceptation 4 (APK Android release) non vérifiable :
  aucun SDK Android sur cette machine. Node 20.15.1 également sous la version minimale de
  React Native 0.86 (>= 22.11.0). **Bloquant pour clore complètement L0-03**, non bloquant pour
  la suite (le reste du monorepo fonctionne).
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
- **L0-03** : projets Android/iOS générés par `@react-native-community/cli`
  (`--skip-git-init --package-name cm.babana.client` / `cm.babana.driver`) plutôt qu'écrits à la
  main — un projet natif correct à la main est précisément le genre de détail qui se règle mal
  en reprise.
- **L0-03** : `babel-plugin-transform-inline-environment-variables` (nouvelle dépendance,
  signalée) plutôt que `react-native-config`, pour éviter une liaison native supplémentaire pour
  un besoin aussi simple qu'une URL de base injectée au build.
- **L0-03** : `env.d.ts` déclare uniquement `process.env` plutôt que d'installer `@types/node`
  en entier, qui exposerait toute l'API Node comme si elle existait sur React Native.
- **L0-03** : `apps/*/.eslintrc.js` n'a plus `root: true`, pour se combiner avec
  `code/.eslintrc.cjs` (racine du monorepo) plutôt que l'ignorer.
- **L0-04** : ioredis, `ws`, `fetch` natif de Node — pas de framework HTTP (Express, Fastify)
  pour un service qui n'expose qu'un `/health` et une mise à niveau WebSocket ce soir.
- **L0-04** : jeton applicatif transmis en `?token=` sur l'URL WebSocket, pas en en-tête —
  méthode la plus largement supportée au handshake par les clients web et React Native.
- **L0-04** : code de fermeture WebSocket `4401` pour une connexion non authentifiée (plage
  4000-4999 réservée par RFC 6455 §7.4.2), en écho à HTTP 401.
- **L0-04** : forme des claims du jeton applicatif (`sub`, `role`, `exp`) posée par hypothèse —
  L1-01, qui les émettra réellement, n'a pas tourné ce soir. À confirmer à ce moment-là.
- **L0-06** : adresse Redis interne et URL interne d'Odoo volontairement absentes de `.env` —
  fixées en dur dans `infra/compose.yaml` parce qu'elles décrivent la topologie du réseau Docker,
  identique dans les trois environnements par construction (D18). Explicité dans le README pour
  qu'un futur lecteur ne les cherche pas en vain.
- **L0-06** : `GOOGLE_OAUTH_CLIENT_IDS` reste une variable unique (liste séparée par des
  virgules) plutôt que trois variables distinctes par plateforme — c'est ce que
  `infra/compose.yaml` consomme déjà tel quel depuis L0-01 ; les trois identifiants sources sont
  documentés dans le README sans changer la variable que le service lit réellement.
- **L0-04** : `services/realtime/Dockerfile` n'installe pas depuis `package-lock.json` de la
  racine — ce lockfile encode tout l'arbre du monorepo (apps/* compris), absent de ce contexte
  de build ; le copier faisait hoister un `ws` transitif de react-native au lieu du `ws` déclaré
  par `@babana/realtime` lui-même. `npm install` frais, résolu contre les seuls `package.json`
  présents dans le contexte.
- **L0-08** : signature JWT (RS256) écrite à la main avec `node:crypto` plutôt qu'une
  bibliothèque JWT — aucune dépendance nouvelle, et contrôle total nécessaire pour produire
  précisément les cinq variantes invalides exigées sans lutter contre les garde-fous d'une
  bibliothèque qui refuserait de construire un jeton volontairement mal formé.
- **L0-08** : polyline encodée au format Google standard (précision 1e5) plutôt qu'un format
  maison — pour que `packages/maps` (L6-01) se développe dès sa création contre un format
  réaliste, cohérent avec l'esprit de l'abstraction C3/D13.
- **L0-08** : critères d'acceptation 1 et 5 non vérifiables ce soir (scénario complet L10-01,
  endpoints d'inspection OTP/notification de L1-09/L7-01) — dépendances hors du lot autorisé,
  documenté dans `services/mocks/README.md`, pas un défaut de ce qui a été construit ce soir.
- **L0-02** : `make test` a révélé un défaut qui existait déjà silencieusement depuis L0-01 —
  `docker compose exec` ne passe pas par l'entrypoint qui traduit HOST/USER/PASSWORD en
  arguments `--db_*`. La cible `test` du Makefile n'avait jamais été exécutée jusqu'à ce que
  L0-02 fournisse un module à tester. Corrigé (voir message de commit).
- **C-02** : incidemment, `tsconfig.json` de `@babana/contracts` ne couvrait que `src/` —
  `npm run typecheck` ne voyait jamais `test/`. Un doublon d'import dans un test aurait pu
  passer inaperçu indéfiniment. Ajout de `tsconfig.typecheck.json` qui couvre aussi `test/` et
  `scripts/` ; a fait remonter 4 erreurs supplémentaires (dont le doublon), toutes corrigées.

## Ce que je ferais ensuite

Les neuf tâches du lot sont traitées : huit finies, une partielle (L0-03, bloquée uniquement par
l'absence de SDK Android sur cette machine — le code est complet et vérifié partout ailleurs).

**Dans l'ordre, demain matin :**

1. **Lire `amoa/questions/` avant tout le reste**, comme le prompt de cette nuit le demande.
   Six fichiers, deux méritent une décision rapide avant de continuer le développement :
   `C-03.md` (le critère d'acceptation 1 de C-03 contredit le caractère terminal de `cancelled`)
   et `L0-06.md` (mailpit dans les sept services de production laisserait les factures réelles
   sans destinataire — à trancher avant L0-07, pas avant).
2. **Corriger le Caddyfile de référence** dans `amoa/04-monorepo-et-services.md` §7 (bloc
   `/.well-known/assetlinks.json`, `uri strip_prefix` manquant) — déjà corrigé dans le code,
   juste à répercuter dans le document pour que personne ne reproduise le même 404.
3. **Mettre à niveau Node sur cette machine et en intégration continue** vers `>= 22.11.0` avant
   de rouvrir L0-03 : c'est la version minimale de React Native 0.86, tout a fonctionné ce soir
   malgré l'avertissement mais rien ne garantit que ce sera encore vrai pour un build natif.
   Installer un SDK Android (ligne de commande suffit) pour vérifier enfin le critère
   d'acceptation 4 de L0-03 (APK release) et clore la tâche.
4. **Continuer sur le chemin critique de `03-decoupage-taches.md` §5** : après C-03, L0-01,
   L0-02, la suite naturelle est L1-01 (contrôleur d'authentification Google, testé contre
   `mock-google-identity` — le service est prêt et vérifié ce soir), puis L4-01/L4-02 (modèle et
   machine à états implémentée, qui devront trancher l'écart de C-03 en premier lieu).
5. **Vérifier une fois pour toutes le comportement du bind mount Docker Desktop** rencontré à
   trois reprises cette nuit (répertoire vide côté conteneur après une recréation ailleurs dans
   le projet) — pas bloquant, mais consommera du temps de debug à chaque redémarrage de service
   tant que ce n'est pas soit accepté comme routine (`docker compose restart <service>` avant de
   chercher plus loin), soit réglé en changeant le mode de partage de fichiers de Docker Desktop.

**Ce que cette nuit dit des spécifications** : dans l'ensemble, elles ont bien résisté — la
plupart des écarts trouvés sont des détails d'implémentation (une syntaxe XML, un ordre de
build Docker, une résolution de module) plutôt que des erreurs de conception. Les deux
exceptions notables sont C-03 (un critère d'acceptation qui contredit le modèle qu'il décrit) et
L0-06 (une conséquence de D18 pas entièrement pensée jusqu'au bout pour l'envoi d'email réel) —
toutes deux consignées, ni l'une ni l'autre corrigée en silence.
