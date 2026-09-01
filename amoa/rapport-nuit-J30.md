# Rapport de nuit — J30

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition
de fini). Lu en entier : `CLAUDE.md`, `amoa/questions/REPONSES-2026-09-06.md`,
`amoa/07-demonstration.md`, les écarts `amoa/questions/L1-01-res-users-public-id-uniqueness.md`,
`L0-06-live-driver-positions.md`, `L7-04.md`, la spécification L7-04
(`amoa/specs/L7-notifications.md`), et les sections D26/D43/D49/D50/D52 de
`amoa/01-architecture.md`.

Branche `J30-demonstration` (depuis `J29-demonstration`, elle-même non fusionnée — J28/J29).
Un commit par tâche.

Périmètre confié :

1. **D52** — la contrainte d'unicité manquante, et la vérification systématique.
2. **Le SMTP sans valeur par défaut** — D43 retournée, appliquée.
3. **L'outil de figuration** — les chauffeurs du jeu de données qui se déplacent dans Douala.
4. **Les deux corrections de L7-04** — la resynchronisation qui dit ce qu'elle ignore, l'écran
   qui affiche un fait plutôt qu'une attente muette.

Puis : `make reset`, `make seed`, l'outil de figuration, la passe finale, et le scénario du §3
de `amoa/07-demonstration.md` joué de bout en bout.

---

## 1. D52 — la contrainte d'unicité, et la comparaison mécanique

### Le défaut, et la troisième occurrence cherchée

`res.users.babana_public_id` promet l'unicité (docstring, `UserIdSchema` C-01) ; la contrainte
`res_users_babana_public_id_unique` **n'existait pas en base**. Cause connue (écart J29) : Odoo
remplit une colonne stockée neuve avec `default` sur une table déjà peuplée en **une seule
évaluation** de la valeur par défaut — les sept comptes système reçoivent le même UUID, et
`unique(babana_public_id)` échoue à la création. Odoo journalise `unable to add constraint` et
poursuit.

**La comparaison mécanique demandée a trouvé exactement le motif redouté.** Le nouveau test
`tests/test_sql_constraints_in_db.py` énumère les contraintes `_sql_constraints` que le module
déclare (Odoo les reflète dans `ir.model.constraint`) et exige pour chacune une ligne dans
`pg_constraint`. Sur la base telle qu'elle tournait avant correction : **19 contraintes
vérifiées, 1 absente** — `res_users_babana_public_id_unique`, et elle seule.

Deux fausses pistes écartées au passage, qui montrent pourquoi la comparaison devait être écrite
avec soin plutôt que « à l'œil » :

- `babana_idempotency_record_babana_idempotency_key_endpoint_unique` fait **64 caractères** ;
  PostgreSQL limite à 63 et Odoo applique alors `make_identifier` (préfixe tronqué + crc32 :
  `..._endpo_17a6cd1e`). La contrainte **est** posée, sous ce nom. Une comparaison naïve par nom
  l'aurait déclarée manquante à tort. Le test reconstruit le nom réel avec la fonction d'Odoo.
- `ir.model.constraint` trace aussi les clés étrangères des `Many2one` (definition vide, nom
  déjà résolu, `model` parfois trompeur). Le test ne retient que les entrées portant une
  `definition` explicite (`unique(...)`, `check(...)`) — les `_sql_constraints` du module.

Résultat après enquête : **une seule** contrainte réellement absente, celle de l'écart. Pas de
troisième occurrence dormante côté contraintes SQL. Le corollaire — « un identifiant unique
généré par valeur par défaut n'est pas unique sur une table peuplée » — ne concerne aujourd'hui
que `res.users` : `res.partner.babana_google_sub` n'a pas de `default`, les autres `public_id`
sont sur des tables créées vides par le module. C'est une coïncidence, pas une garantie, et
c'est désormais le test qui la surveille.

### La correction

`pre_init_hook` (`__init__.py::_pre_init_backfill_unique_defaults`, déclaré au manifeste). Il
s'exécute à la première installation seulement, après `registry.setup_models` et **avant**
`registry.load` (donc avant `_add_sql_constraints`) : il crée la colonne `babana_public_id` et
la remplit `WHERE babana_public_id IS NULL` avec `gen_random_uuid()::text`. `gen_random_uuid()`
est volatile — PostgreSQL 16 l'évalue **par ligne**, chaque compte système reçoit un identifiant
distinct. Odoo voit ensuite la colonne présente et peuplée, ne rejoue pas son remplissage en une
passe, et pose la contrainte sans erreur.

### Vérifié

Sur la base de développement, module désinstallé puis colonne supprimée puis `-i babana` (chemin
`new_install`, celui qui déclenche le hook) :

- aucun `unable to add constraint` dans les journaux d'installation ;
- `SELECT count(*), count(distinct babana_public_id) FROM res_users` → `7 | 7` (avant : `7 | 1`) ;
- `pg_constraint` porte `res_users_babana_public_id_unique  UNIQUE (babana_public_id)` ;
- `tests/test_sql_constraints_in_db.py` : **0 failed** (19 contraintes vérifiées, 0 absente).

La vérification définitive est la passe finale sur `make reset` (section dédiée en fin de
rapport) : le hook ne se déclenche que sur une base où le module n'a jamais été installé.

### Fichiers

`code/services/odoo/addons/babana/__init__.py` (hook) ;
`code/services/odoo/addons/babana/__manifest__.py` (`pre_init_hook`) ;
`code/services/odoo/addons/babana/tests/test_sql_constraints_in_db.py` (nouveau) ;
`code/services/odoo/addons/babana/tests/__init__.py` (enregistrement).

---

## 2. Le SMTP sans valeur par défaut — D43 retournée, appliquée

### Le défaut, et la règle

`SMTP_HOST=mailpit` était la valeur par défaut de `infra/env/.env.example`, que `make up`
recopie en `infra/env/.env` et qu'un `.env` de production part de recopier aussi. Une mise en
production qui suit le chemin documenté enverrait ses factures à `mailpit` — qui les **accepte**,
les garde, et ne signale rien. C'est D43 retournée : là (28 août), une configuration absente
retombait sur le vrai fournisseur et masquait sa panne ; ici elle retombait sur le simulateur,
et c'est pire, parce qu'un simulateur répond « envoyé ».

**Arbitrage appliqué** : les réglages qui désignent un fournisseur externe (réel ou simulateur)
n'ont **pas** de valeur dans `.env.example`. Vides. La valeur de développement est posée
explicitement par la configuration de développement.

### Les autres cas trouvés

Passés au même regard, dans `.env.example` :

| Variable | Consommateur | Avant | Après |
|---|---|---|---|
| `SMTP_HOST`, `SMTP_PORT` | Odoo (envoi de facture) | `mailpit` / `1025` | **vides** ; `compose.dev.yaml` pose `mailpit`/`1025` |
| `GOOGLE_JWKS_URL` | Odoo (`google_identity.py`) | `http://mock-google-identity:4000/...` | **vide** ; `compose.dev.yaml` pose le mock |
| `GOOGLE_ROUTING_URL` | Odoo (`routing.py`) | `http://mock-maps:4001/route` | **vide** ; `compose.dev.yaml` pose le mock |
| `BABANA_MAPS_SEARCH_URL` | build de `apps/client` (`process.env` de l'hôte) | `http://localhost:4001/search` | **vide** ; `make client` / `make client-web` posent la valeur mock |

`SMTP_FROM=no-reply@babana.cm` **garde** sa valeur : ce n'est pas une adresse de fournisseur
mais celle du domaine babana.cm, identique dans tous les environnements.

Deux de ces quatre échouaient déjà bruyamment en production si vides (`_jwks_url` lève ;
`routing.py` avait un repli code `DEFAULT_ROUTING_URL` **vers le mock** — supprimé, remplacé par
`_routing_url()` qui lève, sur le modèle de `_jwks_url`). `SMTP_HOST` était le seul vraiment
silencieux, mais les quatre partageaient la même forme : une adresse de simulateur servie comme
« valeur par défaut raisonnable ».

### Ce qui bouge, et le choix sur la garde `:?`

- **`infra/compose.yaml`** : `GOOGLE_JWKS_URL` perd sa garde `${...:?}`, `GOOGLE_ROUTING_URL`
  perd son défaut `${...:-http://mock-maps...}`. Motif : avec la valeur vide dans `.env`, une
  garde `:?` dans le fichier de base **empêcherait `make up`** de démarrer (l'interpolation
  échoue avant la fusion avec `compose.dev.yaml` — vérifié). La protection de la production ne
  disparaît pas, elle change d'endroit : **`deploy.sh`** (qui n'utilise que `compose.yaml`) fait
  désormais un `die` — pas un `warn` — si `GOOGLE_JWKS_URL`, `GOOGLE_ROUTING_URL` ou `SMTP_HOST`
  est vide ou pointe vers un simulateur, et le code d'Odoo lève de toute façon à l'appel. C'est
  un choix d'implémentation (protocole d'écart : « décider, avancer, le mentionner ») —
  l'alternative aurait été un jeu de variables `*_PROD_*` ou un fichier `.env.prod.example`
  distinct, ce que D19 écarte (« une seule variable dont la valeur change »).
- **`infra/compose.dev.yaml`** : nouveau bloc `odoo.environment` avec les quatre valeurs mock /
  mailpit. C'est là, désormais, qu'est « la configuration de développement ».
- **`Makefile`** : `client` et `client-web` passent `BABANA_MAPS_SEARCH_URL` (défaut
  `?=`, surchargable) — cette variable est lue de `process.env` de l'hôte au build, pas d'un
  conteneur, donc `compose.dev.yaml` ne peut pas la porter.
- **`routing.py`** : `DEFAULT_ROUTING_URL` supprimé, `_routing_url()` lève si non configurée.
- **README `infra/env/`, `docs/operations/production.md`** : table et procédure de déploiement
  mises à jour (colonne « développement » : vide + où la valeur est réellement posée).

### Le garde-fou mécanique

`test/config/env-example.test.ts` (nouveau, workspace `@babana/concurrency-tests`,
`config/*.test.ts` ajouté au script et au tsconfig) : lit `infra/env/.env.example`, exige que
les cinq variables ci-dessus soient **déclarées et vides**, et qu'**aucune** ligne de valeur ne
contienne un marqueur de simulateur (`mailpit`, `mock-google-identity`, `mock-maps`, `:4000`,
`:4001`). Vérifié à blanc : en remettant `SMTP_HOST=mailpit`, le test échoue (deux assertions).

### Vérifié

- `docker compose -f compose.yaml -f compose.dev.yaml config` sur un `.env` fraîchement copié de
  l'exemple : le service `odoo` résout `GOOGLE_JWKS_URL`, `GOOGLE_ROUTING_URL`, `SMTP_HOST/PORT`
  vers les valeurs mock/mailpit de `compose.dev.yaml`. `make up` démarre donc sans rien ajouter.
- `docker compose -f compose.yaml config` seul (chemin `deploy.sh`) : ces variables résolvent à
  `""`, sans erreur — `deploy.sh` les refuserait ensuite.
- `test/config/env-example.test.ts` : vert ; échoue quand on réintroduit une valeur de mock.
- La passe finale (section dédiée) rejoue `make test` complet sur base fraîche.

### Fichiers

`code/infra/env/.env.example`, `code/infra/env/README.md` ; `code/infra/compose.yaml`,
`code/infra/compose.dev.yaml` ; `code/Makefile` (cibles `client`, `client-web`) ;
`code/services/odoo/addons/babana/services/routing.py` ; `code/infra/production/deploy.sh` ;
`code/docs/operations/production.md` ; `code/test/config/env-example.test.ts` (nouveau),
`code/test/package.json`, `code/test/tsconfig.json`.

---

## 3. L'outil de figuration — chauffeurs qui se déplacent dans Douala

### Ce qui change par rapport à J29

`services/realtime/scripts/demo-drivers.mjs` existait (J29) : il mettait les chauffeurs semés en
ligne par le vrai chemin (auth Google → WS → `availability.set` → `position.update`), mais à des
**positions fixes** avec un tremblement de ±25 m tiré au hasard. Le prompt J30 demande qu'ils
**se déplacent** — « des déplacements plausibles, pas aléatoires (D21) : une moto suit des rues,
elle ne traverse pas le Wouri ».

Le chemin d'authentification, la reconnexion et l'extinction propre (repasse hors ligne) sont
**inchangés** — c'est la partie « vrai chemin » que l'écart validait. Seule la génération des
positions est réécrite.

### Les déplacements

- **Six itinéraires fixes**, tracés en décalages `(dLat, dLng)` par rapport à
  `BABANA_DEMO_ORIGIN` (Akwa, `4.0483,9.6934` par défaut — inchangé) : boucle Akwa centre,
  Akwa→Deïdo, Akwa→New-Bell, boucle Bonapriso, boucle Bali/Akwa ouest, Akwa nord→Bépanda.
  Longueurs 1,6 à 2,9 km. Chaque tracé suit grossièrement une trame de rues (segments
  cardinaux, virages aux carrefours).
- **Tous à l'est du Wouri** : longitude minimale ≈ 9,689 (le fleuve est vers 9,67–9,68 à cette
  latitude, Bonabéri rive gauche est à 9,66). Aucun itinéraire ne l'approche, aucun saut
  discontinu entre deux points (plus grand écart entre sommets : 601 m, interpolé).
- **Aucun `Math.random()`.** Vitesse constante (`BABANA_DEMO_SPEED_KMH`, 22 km/h par défaut —
  croisière d'une moto en ville), position émise toutes les 15 s (`< POSITION_TTL_SECONDS`),
  soit ~92 m par pas. Départ de chaque chauffeur étalé sur son tracé de façon déterministe
  (`((index-1) * 0.37) mod 1`) : deux chauffeurs sur le même tracé ne se superposent pas. La
  flotte est identique d'une exécution à l'autre (D21).
- Les tracés dont le dernier point rejoint le premier sont parcourus **en boucle continue** ;
  les autres **en aller-retour** (demi-tour aux extrémités). Le cap (`headingDegrees`) et la
  vitesse (`speedMetersPerSecond`) émis sont ceux du segment courant — plus de `null`.

### Vérifié

- `node --check` : OK.
- Simulation hors ligne de la géométrie (`buildItinerary` / `locate` / `tick`) : positions qui
  avancent de ~92 m par pas, cap qui tourne aux virages (0°→7°→66°→85° sur la boucle Akwa),
  bornes lat 4,027–4,069 / lng 9,689–9,715, boucles qui reviennent, aller-retours qui
  repartent.
- Bout en bout contre la pile réelle : section « passe finale », après `make seed`
  (`make seed-drivers` a besoin des chauffeurs `babana-demo-driver-N` approuvés).

### Ce qui n'est pas fait, et pourquoi

L'outil reste une **commande à lancer et à laisser ouverte** pendant la démonstration (elle tient
les connexions WebSocket). C'est le point de l'écart `L0-06-live-driver-positions.md` non
tranché (commande à la main vs service `compose.dev.yaml` profil `demo`). Rien de neuf à
signaler : la recommandation J29 (garder la commande — on voit les chauffeurs se connecter, on
peut en couper un) tient pour cette démonstration.

### Fichiers

`code/services/realtime/scripts/demo-drivers.mjs`.

---

## 4. Les deux corrections de L7-04

### A. La resynchronisation dit ce qu'elle ignore

**Avant** : `handleSessionResync` échouait **entièrement** si Odoo était injoignable — aucun
`session.synced` envoyé (`console.error` puis `return`). Le raisonnement d'origine était juste
(ne pas renvoyer `activeRideId: null` qui laisserait croire à tort qu'aucune course n'est en
cours), mais il privait le chauffeur d'une proposition **connue localement** — elle vit en Redis,
pas dans Odoo.

**Troisième voie** (prompt J30, `REPONSES-2026-09-06.md` §4) : la réponse part quand même.

- Nouveau champ de contrat `session.synced.rideStateKnown: boolean` (requis, jamais implicite —
  esprit D49). `true` quand Odoo a répondu ; `false` quand il était injoignable.
- Sur échec Odoo : `rideStateKnown: false`, `activeRideId`/`activeRideState` à `null` **faute
  d'information** (pas parce que l'absence est confirmée), et `activeProposal` est lu en Redis et
  porté quand même (`peekActiveProposal` s'exécute désormais dans les deux branches).
- Côté chauffeur, les deux consommateurs qui traduisaient « `activeRideState` absent » en « pas
  en course » sont gardés : `HomeScreen.tsx` (verrou de la bascule en ligne) et
  `location/tracker.ts` (cadence de capture) ne touchent à l'état de course **que si
  `rideStateKnown`**. `ActiveRideScreen.tsx` teste un **match positif**
  (`activeRideId === rideId && activeRideState === 'in_progress'`) — insensible au cas
  indéterminé, laissé tel quel.

### B. L'écran affiche un fait plutôt qu'une attente muette

`ProposalScreen` en mode `notification`, pendant qu'il attend la réponse de revalidation :
affichait « Vérification de la proposition… », immuable, même hors connexion. La consigne « pas
de délai inventé » reste tenue — mais l'app **connaît son état de connexion**. Le texte devient
« Vérification de la proposition… — hors connexion » quand `realtimeClient.getState() !==
'connected'`. Aucune durée devinée, aucune conclusion tirée sur la proposition : juste le fait
observé. Nouvel abonnement `onRealtimeConnectionStateChange` (déjà utilisé par `HomeScreen`).

### Tests

- `packages/contracts/test/realtime.test.ts` : `rideStateKnown` requis, et le cas
  `rideStateKnown: false` accepté.
- `services/realtime/test/resync.test.ts` : le test « dégradation silencieuse, aucun message »
  est **réécrit** (la décision a changé, pas le code adapté au test — CLAUDE.md) : la réponse
  part avec `rideStateKnown: false` ; nouveau test « un chauffeur avec une proposition vivante
  la reçoit malgré tout ».
- `apps/driver` : `HomeScreen.test.tsx` (nouvelle : `rideStateKnown: false` ne déverrouille pas
  la bascule), `tracker.test.ts` (nouvelle : `rideStateKnown: false` ne fait pas sortir de
  course, `true` oui), `ProposalScreen.test.tsx` (nouvelle : « hors connexion » affiché comme
  un fait, aucune conclusion). Mock `../../realtime` étendu (`getState`,
  `onRealtimeConnectionStateChange`).
- `make test` complet en passe finale. Suites déjà rejouées ici : contracts 79, realtime 206,
  driver 162, client 106, api-client 80, maps 19, navigation 4 — toutes vertes ;
  `verify-realtime-message-map` / `verify-ride-state-machine` OK ; `typecheck` + `lint` de tous
  les espaces de travail verts.

### Fichiers

`code/packages/contracts/src/realtime/server-to-client.ts` ;
`code/services/realtime/src/ws/resync.ts` ; `code/apps/driver/src/screens/ProposalScreen.tsx`,
`code/apps/driver/src/screens/HomeScreen.tsx`, `code/apps/driver/src/location/tracker.ts` ;
`code/docs/contracts/realtime-events.md`, `code/docs/contracts/realtime-message-map.json` ;
tests : `code/packages/contracts/test/realtime.test.ts`,
`code/services/realtime/test/resync.test.ts`,
`code/apps/driver/src/screens/__tests__/{ProposalScreen,HomeScreen,ActiveRideScreen}.test.tsx`,
`code/apps/driver/src/location/__tests__/tracker.test.ts`.
