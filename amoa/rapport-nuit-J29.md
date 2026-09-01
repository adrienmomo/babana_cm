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

1. **Devise.** Sur une base qui porte déjà des écritures comptables (données de démonstration
   Odoo), passer la société en XAF est refusé par Odoo — le seed le tente dans un savepoint et
   retombe proprement sur la devise en place (USD sur la base de développement actuelle), en le
   journalisant. Les **montants** restent justes et vérifiables de tête ; seul le symbole au
   back-office peut être `$` au lieu de FCFA. L'app, elle, affiche toujours « XAF » (le contrat
   le fixe). Sur une base vraiment vierge sans données de démonstration Odoo, le passage en XAF
   devrait réussir — à confirmer à la passe finale.
2. **Documents chauffeur.** `storage_key` pointe vers des objets S3 qui n'existent pas
   (`seed/<sub>/license.jpg`). Le back-office montre les documents comme *vérifiés* ; les
   ouvrir échouerait. Le scénario de démonstration ne les ouvre pas. À remplacer par de vrais
   téléversements si une démonstration doit montrer la consultation d'une pièce.
3. **`res_users_babana_public_id_unique`** ne s'ajoute pas sur la base de développement actuelle
   (sept comptes y partagent un même `babana_public_id`, séquelle de `HttpCase` répétés) —
   sans rapport avec le seed, qui crée des comptes à `public_id` uniques. À vérifier absent
   après `make reset`.

### Fichiers

`code/Makefile` (cibles `seed`, `seed-drivers`, `.PHONY`) ; `code/services/odoo/scripts/seed.py`
(nouveau) ; `code/services/odoo/scripts/README.md` (nouveau) ;
`code/services/realtime/scripts/demo-drivers.mjs` (nouveau) ; `code/tools/secret-scan/scan.sh`
(faux positif) ; `amoa/questions/L0-06-live-driver-positions.md` (nouveau).

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
