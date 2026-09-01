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
