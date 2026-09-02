# Rapport de nuit — J29

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition
de fini). Lu en entier : `CLAUDE.md`, `amoa/07-demonstration.md`, les spécifications L0-06,
L0-07, L6-18, et l'écart `amoa/questions/L6-18-cors-api-web-quote.md`.

Périmètre confié — une démonstration client, trois pièces au périmètre pilote :

1. **Jeu de données de démonstration** — `make seed` (L0-06, jamais terminée).
2. **Servir le bundle Client sous la même origine** — part de L6-18, montage D46.
3. **Déploiement** — L0-07, aussi loin que possible depuis cet environnement.

Branche `J29-demonstration` (depuis `L7-04-driver-proposal-push`, elle-même non fusionnée —
J28). Un commit par tâche. Les fichiers d'écart sont posés sur cette branche faute de pouvoir
committer sur `master` sans manœuvre de fusion en cours de session ; `master` s'y ramène en
avance rapide, ils sont donc lisibles dès la revue (même situation que l'écart L7-04 laissé sur
sa branche à J28).

---

## 1. `make seed` — jeu de données de démonstration

### Le constat, vérifié

`make seed` n'a jamais tourné : la cible pointait sur `services/odoo/scripts/seed.py`, fichier
et répertoire absents. La commande figure dans `CLAUDE.md` depuis le premier jour ; les tests
construisent chacun leurs données, personne n'en a jamais eu besoin.

**Deux autres commandes documentées passées au même regard** (prompt) :

- **`make verify`** (`infra/smoke-test.sh`) : fonctionne — six vérifications vertes contre la
  pile réelle. Rien à corriger.
- **`make secrets-scan`** (`tools/secret-scan/scan.sh`) : **échouait en silence depuis le
  21 août**. Le stub de trousseau web (`apps/client/webpack-stubs/react-native-keychain.web.js`,
  ajouté à L6-00R le 21 août) déclare `const STORAGE_KEY = 'babana-dev-keychain-stub'` — un nom
  de clé `localStorage`, pas un secret. L'heuristique d'entropie de la vérification #4 le prend
  pour une valeur assignée à une variable `*_KEY` ; les fichiers `.js` ne sont pas dans sa liste
  d'exclusion (seulement `.ts`, `.md`, `.env.example`). `make secrets-scan` renvoyait donc 1
  depuis dix jours, sans que les passes finales J27/J28 (qui ne lancent pas cette cible) le
  voient. Une commande documentée qui échoue est pire qu'une commande absente : corrigé en
  ajoutant le marqueur à la liste d'exclusion, exactement comme les deux marqueurs de
  substitution factices déjà présents. `make secrets-scan` repasse vert.

### `make seed`

**`Makefile`** — la cible :
- installe d'abord le module (`odoo -d babana --stop-after-init --no-http -i babana`) : `make up`
  seul ne l'installe **jamais** (`compose.dev.yaml` lance `odoo --dev=reload`, sans `-i`) — sur
  une base fraîche, `make seed` sans cette étape échouerait, les modèles n'existant pas. `-i` sur
  un module déjà installé ne fait que recharger le registre, l'étape reste idempotente ;
- puis exécute `seed.py` dans un `odoo shell` (même `sh -c '... --db_host=...'` que `make test`,
  qui contourne l'entrypoint de l'image).

**`services/odoo/scripts/seed.py`** — idempotent (chaque objet gardé par une clé naturelle :
`google_sub`, immatriculation, nom de zone, marqueur `pickup_label` pour l'historique). Deux
exécutions consécutives ne produisent pas deux flottes : la seconde ne fait que vérifier
(`+0 cette exécution`). Contenu :

- **6 zones réelles de Douala** reprises de `services/mocks/maps/fixtures/douala.json` (Akwa,
  Bonapriso, Deïdo, New-Bell, Bonabéri, Makepe) — rectangle serré (~0,7 km) autour du centroïde,
  priorité 10 pour passer devant le rectangle englobant par défaut (conservé comme repli). **Une
  grille tarifaire par zone**, valeurs de l'ordre du marché moto-taxi (base 250–300, 100–130
  FCFA/km, plancher 350–500, Bonabéri majorée 1,15 pour le passage du pont) — explicitement
  provisoires (D21), `active_from` daté deux ans en arrière pour couvrir l'historique.
- **5 chauffeurs approuvés** — noms plausibles (Emmanuel Ndoumbè, Aristide Mbarga, Cédric Ewané,
  Guy Njoya, Roland Kotto), motos affectées (immatriculations Littoral, marques courantes —
  Sanili, Nanfang, Haojin, Royal, Kymco ; une `premium`), permis + pièce d'identité **vérifiés**,
  affectation durable via `babana.assignment`, `is_online` vrai. Créés par le vrai chemin
  (`_babana_find_or_create_from_google` puis `action_approve` — seule écriture RH du système).
- **1 client** — Nadège Eloundou, numéro renseigné + contact d'urgence.
- **1 superviseur** — Béatrice Manga, `group_babana_supervisor`.
- **8 courses terminées** (`settled`), étalées sur deux semaines, jouées par les vraies
  transitions (`action_request` → `propose` → `accept` → `start` → `complete` → `settle`) : jamais
  d'écriture directe de `state` (invariant 2). Chaque encaissement crée son mouvement de compte
  courant : après le seed, quatre chauffeurs ont un solde dû non nul (675 à 3 000 FCFA), le
  cinquième est à zéro — la nouvelle recrue. Les horodatages du cycle sont antidatés par SQL
  direct (seul contournement de l'ORM, uniquement des dates, jamais `state`).

### La partie qui ne rentre pas dans le seed Odoo — écart déposé

`amoa/questions/L0-06-live-driver-positions.md`. « Positions dispersées, tenues à jour en
direct » (prompt §1, scénario §3 étape 1) est un état du pool géo-indexé Redis, pas une donnée
Odoo. Ce pool n'a qu'un écrivain — le script Lua d'éligibilité (D26) — alimenté uniquement par
des `position.update` sur une connexion WebSocket chauffeur. Un `odoo shell` n'a aucun de ces
leviers, et lui en donner un violerait D26.

Porté par un **compagnon committé** (pas un script jetable comme les nuits de vérification) :
`services/realtime/scripts/demo-drivers.mjs`, lancé par **`make seed-drivers`**. Sans dépendance
(`fetch` / `WebSocket` / `crypto.randomUUID` natifs Node 22). Il fait ce que fait l'app
Chauffeur : `mock-google-identity` → `POST /api/v1/auth/google` → WS `?token=` →
`availability.set { online: true }` → `position.update` toutes les 15 s, à des positions
dispersées et déterministes (D21) autour d'un centre configurable. Ctrl-C repasse chacun hors
ligne. **Vérifié** : les cinq chauffeurs entrent bien dans `babana:drivers:available`, positions
correctes (`GEOPOS`).

Contrat entre les deux fichiers : `google_sub` = `babana-demo-driver-1..N`. Rien d'autre.

L'écart porte sur l'emballage : `make seed-drivers` est une commande **à lancer à la main et à
laisser ouverte** pendant la démonstration (elle tient les connexions) — ce n'est pas tout à
fait « rien à créer à la main ». Option alternative proposée : un service derrière un profil
`demo` de `compose.dev.yaml`. Recommandation : garder la commande pour cette semaine (on voit
les chauffeurs se connecter, on peut en couper un pour montrer un départ de la liste).

### Réserves pour quelqu'un de réel

1. **Devise.** `make seed` installe le module (`-i babana`) avec les **données de démonstration
   Odoo** (défaut de dev), qui créent des écritures comptables — Odoo refuse alors de changer la
   devise de la société. Le seed le tente dans un savepoint et retombe proprement sur la devise
   en place (USD), journalisé. **Confirmé à la passe finale sur base fraîche** : le back-office
   affiche `$`. Les **montants** restent justes et vérifiables de tête ; l'app et l'API
   affichent « XAF » (le contrat le fixe). Contournement pour la démonstration :
   `-i babana --without-demo=all` (base propre, XAF passe) ou devise fixée à la main au premier
   lancement. À trancher si le symbole compte pour le rendez-vous.
2. **Documents chauffeur.** `storage_key` pointe vers des objets S3 qui n'existent pas
   (`seed/<sub>/license.jpg`). Le back-office montre les documents comme *vérifiés* ; les
   ouvrir échouerait. Le scénario de démonstration ne les ouvre pas. À remplacer par de vrais
   téléversements si une démonstration doit montrer la consultation d'une pièce.
3. **`res_users_babana_public_id_unique` ne s'applique jamais** — vérifié sur base fraîche : les
   7 comptes système d'Odoo partagent un même `babana_public_id`, la contrainte
   `_sql_constraints` échoue en silence à l'installation. Défaut **L1-01** préexistant, pas
   introduit par le seed (qui crée des comptes à `public_id` uniques par `create()`). Écart
   déposé : `amoa/questions/L1-01-res-users-public-id-uniqueness.md`.

### Fichiers

`code/Makefile` (cibles `seed`, `seed-drivers`, `.PHONY`) ; `code/services/odoo/scripts/seed.py`
(nouveau) ; `code/services/odoo/scripts/README.md` (nouveau) ;
`code/services/realtime/scripts/demo-drivers.mjs` (nouveau) ; `code/tools/secret-scan/scan.sh`
(faux positif) ; `amoa/questions/L0-06-live-driver-positions.md` (nouveau).
Écart connexe trouvé à la passe finale : `amoa/questions/L1-01-res-users-public-id-uniqueness.md`.

---

## 2. Servir le bundle Client sous la même origine (part de L6-18)

### Le montage

Caddy sert désormais le **bundle web du Client** sur le domaine principal, et proxifie `/api/*`
et `/rt/*` **sous cette même origine** (D46, L6-18). C'est le montage que la vérification de J20
utilisait en jetable (`verify.localhost`) ; il entre dans l'infrastructure.

**`infra/caddy/Caddyfile`** — le bloc apex devient :
- `/.well-known/assetlinks.json` : public (métadonnée de liens d'app, lue de l'extérieur par
  Google) — hors de la liste d'adresses ;
- tout le reste derrière `@allowed remote_ip {$WEB_ALLOWED_IPS:0.0.0.0/0}` :
  - `handle /api/*` → `odoo:8069`, `handle /rt/*` → `realtime:3000` : **même origine que le
    bundle**, donc aucun préflight, aucun en-tête CORS sur une API à jeton porteur (D46) ;
  - `handle /s/*` → `realtime:3000` : partage de trajet, fermé lui aussi pendant le pilote ;
  - `handle { root * /srv/web ; try_files {path} /index.html ; file_server }` : le bundle, avec
    repli SPA.
  - `respond 403` sinon (même patron que `admin.`).

L'hôte `api.` est **inchangé** : c'est l'origine dédiée des applications natives (jetons), le
bundle web n'en a jamais besoin puisqu'il appelle la sienne.

**L'accès reste fermé** (prompt : « tant que les habilitations n'existent pas ») : nouvelle
variable **`WEB_ALLOWED_IPS`**, distincte d'`ADMIN_ALLOWED_IPS` — on peut ouvrir la démonstration
au client sans lui ouvrir le back-office. `0.0.0.0/0` en développement. Documentée dans
`.env.example` et `infra/env/README.md` (table + section rotation : verrou temporaire, passe à
`0.0.0.0/0` quand L8-01/L8-02 sont en place).

**`apps/client/config.web.ts`** (nouveau) — webpack résout `.web.ts` avant `.ts`
(`resolve.extensions`), donc c'est ici, et jamais dans un écran (D22, même patron que
`location.web.ts`), que l'export web apprend à parler à sa propre origine :
`API_BASE_URL = window.location.origin`, `REALTIME_WS_URL = origin.replace(/^http/, 'ws') +
'/rt/ws'`. `process.env.*` garde la priorité (une prévisualisation `staging.babana.cm` explicite
l'emporte). Ajouté à l'`exclude` de `tsconfig.json`, comme `location.web.ts`.

**`infra/compose.yaml`** — le conteneur Caddy monte `../apps/client/dist-web:/srv/web:ro`.
Construit sur l'hôte par **`make client-web`** (`npm run build:web -w @babana/client`) ;
répertoire vide → Caddy rend 404 jusqu'à la première construction. `dist-web/` est déjà dans
`.gitignore` (`dist-web/`).

### Vérifié, contre la pile réelle

Après `make client-web` puis recréation du conteneur Caddy :

- `GET https://localhost/` → `index.html` ; `GET /bundle.js` → 200, `text/javascript`, 3,15 Mo ;
- `POST https://localhost/api/v1/quote` (sans jeton) → **401 d'Odoo**, pas un 404 — la requête
  traverse bien Caddy jusqu'au contrôleur ;
- `POST https://localhost/api/v1/auth/google` → `VALIDATION_ERROR` d'Odoo, forme attendue ;
- route SPA inconnue → `index.html` ; `/rt/health` via l'apex → 200 ; assetlinks → 200 (public) ;
- le bundle reconstruit ne contient plus `api.babana.cm` (0 occurrence) et porte bien
  `window.location.origin` / `replace(/^http/,'ws')` : `config.web.ts` est pris en compte.
- `caddy validate` : *Valid configuration*.
- `npm run typecheck`, `npm run lint`, `npm test` de `@babana/client` : verts (106 tests,
  inchangé depuis J28).

### Ce que ça débloque

L'écart `amoa/questions/L6-18-cors-api-web-quote.md` (J18/J24) : `OPTIONS /api/v1/quote → 401`
cassait le préflight CORS **parce que le banc d'essai avait deux origines**. Servi sous une
seule, le navigateur n'émet aucun `OPTIONS` : le blocage ne peut plus se produire, sans avoir
ajouté d'en-tête CORS à l'API à jeton (ce que l'écart demandait justement d'éviter). Ce point de
l'écart est **résolu par le montage**, pas par une politique CORS.

### Ce qui reste explicitement à L6-18 (hors de cette nuit)

Le fournisseur de carte **web** (`packages/maps/src/providers/web/` — aujourd'hui les stubs
`webpack-stubs/` font juste compiler), le second chemin d'authentification (flux OAuth web,
`packages/api-client/src/auth/web.ts`), la bannière de dégradation, la session en mémoire seule
(D39), le déploiement Vercel par prévisualisation de branche. Le montage même origine est la
part qui « serait à faire de toute façon » (D46) et qui entrait dans l'infrastructure ce soir.

### Fichiers

`code/infra/caddy/Caddyfile` ; `code/infra/compose.yaml` (montage `/srv/web`, `WEB_ALLOWED_IPS`) ;
`code/apps/client/config.web.ts` (nouveau) ; `code/apps/client/tsconfig.json` (exclude) ;
`code/Makefile` (cible `client-web`) ; `code/infra/env/.env.example`, `code/infra/env/README.md`
(`WEB_ALLOWED_IPS`).

---

## 3. Déploiement (L0-07) — aussi loin que possible depuis ici

### Où je m'arrête, exactement

**Aucune étape de la procédure §9 n'a été exécutée sur une machine** — il n'y a pas de VPS, pas
de DNS, pas de secrets réels dans cet environnement. Ce qui est fait : **les scripts et le
runbook qui codifient les dix étapes**, écrits pour que leur première exécution réelle soit
mécanique et que la frontière « fait / attend une machine » soit nette.

| # | Étape §9 | État |
|---|---|---|
| 1 | Provisionner le VPS | Dimensionnement fixé (§9). **Attend** un compte hébergeur. Recommandation écrite : Hetzner par défaut. |
| 2–3 | Durcir SSH + pare-feu + MAJ auto | `infra/production/bootstrap.sh` — complet, idempotent, garde-fou « pas de clé → on ne coupe pas l'accès », port 80 laissé ouvert (piège ACME). **Attend** root sur le VPS + la vraie liste `SSH_ADMIN_IPS`. |
| 4 | DNS | Noms fixés. **Attend** l'accès registrar + la propagation. |
| 5–6 | Déployer + vérifier | `infra/production/deploy.sh` — `infra/compose.yaml` **seul** (jamais `compose.dev.yaml` : ports internes, sources montées, mailpit, mocks), build du bundle web, `-u babana`, `infra/smoke-test.sh`, enregistrement du commit déployé. Contrôles préalables sur le `.env` (BABANA_DOMAIN, GOOGLE_JWKS_URL/ROUTING_URL non-mock, NODE_ENV). **Attend** un `.env` de production avec les vrais secrets + le DNS résolu. |
| 7 | Sauvegardes externes + **restauration prouvée** | `backup.sh` (pg_dump -Fc + miroir MinIO + `.env` chiffré age → remote rclone chez un **autre** hébergeur, rétention 14 j) et `restore.sh` (sur hôte vierge : recrée la base, recharge, `smoke-test` + contrôle de cohérence métier). **Attend** un stockage objet distinct + l'exécution réelle. Journal « Restauration prouvée » vide dans `production.md` — **L8-08 n'est pas satisfait tant qu'il l'est**. |
| 8 | Supervision **hébergée ailleurs** | `infra/production/monitoring/` — `probe.sh` (HTTP seul : 3 hôtes, `/web/health`, `/rt/health`, **expiration des certificats**) et `probe-host.sh` (SSH : disque, **vol de CPU** (steal %, spécifique D18), âge de la dernière sauvegarde, file Odoo L3-12 en *placeholder*). `ALERT_CMD` par alerte. README : doit tourner sur une **autre** machine, et le test « panne provoquée » reste à faire. |
| 9 | Latence de référence depuis Douala | Gabarit `docs/operations/latency-baseline.md` (méthode : API / WS / `/quote`, trois moments, p95). **Attend** une connexion camerounaise réelle. Marqué « NON MESURÉE ». |
| 10 | Retour arrière + détenteurs d'accès | `infra/production/rollback.sh` (retour de code ; s'arrête net si le schéma a migré → restaurer la base). Tables « détenteurs d'accès » et « seuil de bascule d'hébergeur » dans `production.md` — **à remplir**, la valeur du seuil dépend de la référence de latence. |

**Critère de fin de la mise en production (§9)** : étape 7 réussie + étape 8 qui alerte pour de
vrai. Les deux attendent une machine. Aucune n'est cochée.

### Écart mailpit (`amoa/questions/L0-06.md`) — traité

L'écart disait « bloquant avant L0-07 ». Sa moitié SMTP est **déjà résolue** par l'état du
dépôt : `infra/compose.yaml` utilise `${SMTP_HOST}` / `${SMTP_PORT}` (plus de littéral
`mailpit`), et `mailpit` n'est que dans `compose.dev.yaml`. Reste que `make up` inclut toujours
`compose.dev.yaml` — d'où `deploy.sh` qui n'utilise que `compose.yaml`, et `production.md` qui
liste `SMTP_HOST=<relais réel>` parmi les variables du `.env` de production. Note datée ajoutée
à l'écart. Le fournisseur **SMS** reste non tranché (hors périmètre, avant L1-09).

### Choix d'implémentation (mentionnés, pas des écarts)

- Scripts en `sh` POSIX (`#!/bin/sh`), vérifiés `sh -n` sous busybox/dash (le bash 3.2 de macOS
  a un analyseur de here-documents cassé — faux négatif local, sans objet sur Debian).
- `rclone` + `age` comme seuls outils ajoutés côté sauvegarde — justifiés par « stockage chez un
  autre fournisseur » et « `.env` jamais en clair » de la spécification.
- `infra/production/.state/` (commit déployé, horodatages, historique de sauvegarde) est local à
  l'hôte, ajouté à `.gitignore`.

### Fichiers

`code/infra/production/{README.md, bootstrap.sh, deploy.sh, rollback.sh, backup.sh, restore.sh}`
(nouveaux) ; `code/infra/production/monitoring/{README.md, probe.sh, probe-host.sh}` (nouveaux) ;
`code/docs/operations/{production.md, latency-baseline.md}` (nouveaux) ; `.gitignore`
(`.state/`) ; `amoa/questions/L0-06.md` (note datée).

---

## Le scénario §3 passe-t-il en entier sur une base fraîchement seedée ?

**Oui, de bout en bout.** Répétition jouée contre la pile réelle (API + WebSocket, les vrais
chemins — pas les tests), sur `make reset && make up && make seed && make seed-drivers`, avec un
harnais jetable qui suit les huit étapes de `07-demonstration.md` §3 :

| Étape §3 | Résultat |
|---|---|
| 1. Le client voit 5 chauffeurs autour de lui | ✅ `nearby.drivers` : 5 chauffeurs, distances 448–1631 m, gammes standard/premium, `nearby.subscribe.ack` avec `broadcastIntervalMs: 5000` |
| 2–3. Départ/arrivée désignés, l'estimation s'affiche avec son détail | ✅ `POST /quote` → 700 XAF, `baseFare 300 + distanceFare 378 + rounding 22 = 700` (somme = total, vérifiable de tête) |
| 4. Le client choisit un chauffeur | ✅ `POST /rides` (requested) puis `POST /rides/{id}/select-driver` |
| 5. Le chauffeur reçoit la proposition et **refuse** ; le client revient à la sélection, ce chauffeur en moins | ✅ `proposal.new` reçu, `proposal.reject` émis, `ride.rejected` reçu côté client ; la 2ᵉ liste `nearby.drivers` exclut bien le refusant (`excludeDriverIds`) |
| 6. Un second chauffeur accepte | ✅ `proposal.accept` → course `assigned` |
| 7. Course démarrée, terminée, encaissée | ✅ `start` → `in_progress`, `complete` → `completed` (montant 700, `measured=false`), `settle` → `settled`, `driverCashBalance: 3700`, `cashLimitReached: false` |
| 8. Bascule back-office | ✅ course `C2026000009 settled`, règle « Grille Akwa » (zone résolue), `fare_rule_snapshot` décomposable, **le solde du chauffeur a monté d'exactement le montant encaissé** (3000 → 3700), mouvement de compte courant `collection` lié à la course |

**Le seul écart constaté, cosmétique** : le back-office affiche les montants en **USD**, pas en
FCFA. La base de démonstration installe les données de démonstration génériques d'Odoo, qui
créent des écritures comptables ; Odoo refuse alors de changer la devise de la société. Le seed
tente le passage en XAF dans un savepoint et retombe proprement (journalisé). **Les montants
sont justes** (700, 1 250…), seul le symbole diffère, et l'API/l'app affichent bien « XAF » (le
contrat le fixe). Contournement pour une démonstration : installer sans données de démonstration
(`-i babana --without-demo=all`) ou fixer la devise à la main au premier lancement — à
documenter si le symbole compte pour le rendez-vous.

Aucune remise n'a été jouée dans la répétition (étape 8, « si vous en jouez une ») — le chemin
d'écriture comptable de la remise (L5-05) existe et est couvert par les tests, mais n'est pas
requis par le parcours nominal.

---

## Passe finale

Environnement : `make reset && make up` (base fraîche), Docker Desktop, Node 22.23.

### `make seed` sur base fraîche

`make reset && make up && make seed` : **exécuté, vert, idempotent**. Première exécution : 6
zones, 6 grilles, 1 client, 1 superviseur, 5 chauffeurs approuvés (motos, documents,
affectations), 8 courses `settled` avec leurs mouvements de compte courant. Seconde exécution
consécutive : `+0 cette exécution`, aucun doublon. `make seed-drivers` : les 5 chauffeurs
entrent dans `babana:drivers:available` avec des positions dispersées.

Un avertissement docutils (`<string>:38 Unexpected indentation`) apparaît **au tout premier
`-i babana`** — rendu RST du champ `description` du manifeste, cosmétique, ne se reproduit
jamais ensuite.

### `make lint`, `make typecheck`

Verts, les neuf espaces de travail (sur base seedée).

### `make test`

- **Suite babana** : `0 failed, 0 error(s)` — **609 tests** (`odoo.tests.stats: babana`). Tous
  les `npm test` verts : `@babana/api-client` 80, `@babana/contracts` 79, `@babana/maps` 19,
  `@babana/navigation` 4, `@babana/realtime` 205, `@babana/client` 106, `@babana/driver` 159,
  `@babana/concurrency-tests` 31 (Redis + Odoo réels, L3-13). `verify-ride-state-machine` et
  `verify-realtime-message-map` OK — 23 messages du contrat, mêmes 3 en attente qu'à J28.
- **Écart de comptage relevé — 609 vs 2309 à J28.** `make test` (cible inchangée par J29) fait
  `-i babana --test-enable` : sur un `make up` **frais et non seedé**, il installe babana **et
  toutes ses dépendances** (`base`, `account`, `hr`, `mail`, `account_edi_ubl_cii`…), et
  `--test-enable` exécute alors **aussi les suites de ces modules cœur** (~1 700 tests) — c'est
  ce qui composait le « 2309 » de J27/J28. Après `make seed` (qui installe déjà le module), un
  `make test` ne réinstalle plus rien : seule la suite **babana** (609) se rejoue. Les 609 sont
  la couverture du projet ; les ~1 700 autres sont les tests d'Odoo lui-même, qui ne se
  relancent qu'à une installation fraîche.
  **Conséquence pratique** : la passe complète historique (`~2309`) se fait avec `make test` sur
  un `make up` frais, **avant** `make seed`. C'est cette passe qui est en cours de vérification
  au moment d'écrire (elle dépasse largement la limite d'un appel de dix minutes ; lancée en
  arrière-plan). Le résultat sera consigné en amendement à cette entrée.
  Ce n'est pas un défaut introduit par J29 — c'est une propriété de `-i` d'Odoo révélée par le
  fait qu'il existe désormais une étape `make seed` qui installe le module. Piste, si le
  comptage doit rester stable : `make test` en `-i babana -u babana` (rejoue toujours la suite
  babana quel que soit l'état antérieur), au prix d'un double passage des 609 sur base fraîche.
  Signalé plutôt que tranché sur une cible que J27/J28 utilisent telle quelle.

### Répétition du scénario

Voir la section ci-dessus : parcours §3 complet, vert, sur base fraîchement seedée.

---

## Ce qui me laisse un doute pour quelqu'un de réel

1. **Devise USD au back-office** (détaillé plus haut). Cosmétique, mais c'est exactement le genre
   de détail qu'un client remarque à l'écran — à décider avant le rendez-vous : `--without-demo`
   ou devise fixée à la main.
2. **`make seed-drivers` doit rester ouvert** pendant toute la démonstration. Si le terminal se
   ferme, la carte se vide en 60 s (TTL des positions). Écart déposé
   (`L0-06-live-driver-positions.md`) : commande à la main, ou service `compose.dev.yaml` — à
   trancher.
3. **Documents chauffeur non ouvrables** (`storage_key` vers des objets S3 absents). Le back-office
   les montre « vérifiés » ; les ouvrir échoue. Sans objet pour le scénario, à corriger si une
   démonstration doit montrer la consultation d'une pièce.
4. **`res.users.babana_public_id` sans contrainte d'unicité en base** — trouvé en validant le
   seed sur base fraîche. Défaut L1-01 préexistant (les 7 comptes système partagent un UUID),
   sans impact sur les comptes mobiles réels. Écart déposé
   (`L1-01-res-users-public-id-uniqueness.md`).
5. **Aucune étape de L0-07 n'a tourné sur une machine.** Les scripts sont relisibles, pas
   éprouvés. Le premier `bootstrap.sh` réel, la première restauration, la première alerte de
   supervision : tout cela reste devant.
6. **Le bundle web n'a pas été vérifié dans un vrai navigateur cette nuit** — l'interstitiel de
   certificat de Chrome (racine de la CA locale de Caddy non installée dans le trousseau,
   `certutil` absent) bloque l'automatisation. Le montage même origine est prouvé par `curl` et
   par la répétition complète du scénario en WebSocket + HTTP ; la vérification visuelle demande
   d'ajouter la racine de Caddy au trousseau, comme les nuits de vérification J20/J24 l'avaient
   fait sur leur poste.

---

## Note de périmètre

Trois tâches de périmètre pilote en une nuit (L0-06 seed, part de L6-18, scaffolding L0-07),
plus la répétition et la passe. C'est un lot dense pour un dépôt à ce stade — mené en entier,
mais la part L0-07 est du **scaffolding relisible**, pas du déploiement éprouvé, et la frontière
est tracée explicitement (table « fait / attend une machine », entrée 3). Si une seule chose
devait être approfondie avant le rendez-vous, c'est la vérification visuelle du bundle web dans
un navigateur (point 6 ci-dessus).
