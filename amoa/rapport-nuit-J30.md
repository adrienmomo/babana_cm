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
