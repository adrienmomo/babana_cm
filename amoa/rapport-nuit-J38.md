# Rapport de nuit — J38

Tenu au fil de l'eau, une entrée par tâche finie. Lu en entier : `CLAUDE.md`,
`amoa/questions/REPONSES-2026-09-14.md`,
`services/odoo/addons/babana/models/babana_ride_invoice.py`,
`services/odoo/addons/babana/tests/test_invoice.py`,
`tools/config-coherence/scan.ts`, `tools/config-coherence/variables.ts`,
`infra/env/.env.example`, `infra/env/README.md`, `Makefile`,
`apps/client/config.ts`, `apps/client/config.web.ts`, `apps/driver/config.ts`,
`infra/production/deploy.sh`, `infra/production/lib/build-web-bundle.sh`,
`infra/production/backup.sh`, `infra/production/restore.sh`,
`infra/production/monitoring/probe-host.sh`, `docs/operations/production.md`,
`amoa/specs/L8-securite.md` (L8-08).

Périmètre confié : L8-08 (sauvegardes et restauration, avec preuve exécutée), D60 (le bouton
d'envoi de facture ne commite plus la requête), D61 (les adresses de serveur sortent des replis
suffisants).

---

## 1. D60 — lever n'est pas une façon d'afficher

### Le défaut, tel qu'arbitré la nuit dernière

`button_send_invoice_email` faisait `env.cr.commit()` puis levait `UserError` sur échec.
`Cursor.commit()` exécute au passage tout point d'accroche au commit encore en attente sur ce
curseur (`env.cr.postcommit`, D32/D33) — un gestionnaire qui commite puis lève déclenche donc les
effets externes d'une requête qui se termine en erreur. Rien n'enregistrait de point d'accroche
avant ce bouton, mais la garantie tenait à ce fait précaire, pas à une propriété du code.

### Le correctif

Le gestionnaire ne lève plus. Sur échec, il renvoie une notification cliente
(`ir.actions.client` / `display_notification`, `type: danger`, `sticky: true`) portant le même
message que l'ancienne `UserError` — la transaction se termine normalement, l'écriture d'échec
(`babana_mail_error` sur la facture, via `_babana_attempt_invoice_email`) est dedans. Aucun
`env.cr.commit()` explicite n'est plus nécessaire : il n'y a plus rien à protéger d'un rollback
puisqu'il n'y a plus d'exception.

### Vérifié dans le vrai back-office (point 9)

Course C2026000347 (encaissée, facture envoyée) : email du client effacé par `odoo shell` pour
provoquer un échec réel, bouton « Envoyer / renvoyer la facture par email » cliqué. Notification
rouge affichée : « Envoi de la facture — Ce client n'a pas d'adresse email connue -- impossible
d'envoyer la facture. » — sans popup bloquant, sans page cassée. **Rechargement de la page** :
le ruban rouge « Échec d'envoi de la facture » était bien présent — l'écriture d'échec a survécu
au rechargement, la preuve visuelle que rien n'a été rejoué en arrière. Email restauré, bouton
recliqué en rattrapage : le ruban a disparu, `invoice_email_state` repassé à « Envoyée ». Course
laissée dans son état d'origine.

### Un défaut sans filet, maintenant couvert

Avant ce soir, le seul test qui passait par `button_send_invoice_email()` empruntait le chemin du
succès ; les deux tests d'échec existants appelaient `_babana_send_invoice_email()` directement,
jamais le bouton. Deux tests ajoutés à `test_invoice.py` :
- `test_button_on_failure_does_not_raise_and_returns_a_notification` — le bouton ne lève pas et
  renvoie bien `{'type': 'ir.actions.client', 'tag': 'display_notification', ...}` avec
  `type: 'danger'` et le message attendu ;
- `test_button_on_failure_leaves_the_failure_state_written` — après l'appel, l'état d'échec est
  bien lisible sur la course (`invoice_email_state == 'failed'`), sans qu'aucun `commit()`
  prématuré n'ait été nécessaire pour le faire survivre.

### Tests

Suite Odoo, module `babana`, tag `TestInvoice` : 19 tests, 0 échec, 0 erreur (les deux nouveaux
compris).

---

## 2. D61 — une adresse de production en repli sort du protocole des trois moments

### Le défaut

`BABANA_API_URL`/`BABANA_REALTIME_WS_URL` étaient dans `SELF_SUFFICIENT_DEFAULTS`
(`tools/config-coherence/variables.ts`), au motif que leur repli codé en dur
(`apps/client/config.ts`, `apps/driver/config.ts`) était « une adresse de production réelle ».
Vrai, et c'est ce qui posait problème : un binaire construit sans ces variables (un oubli sur
`make client`, un futur build de recette) parlait quand même à la vraie production, sans qu'aucun
contrôle ne le signale — D43 (« un repli plausible se croit, une absence se voit ») appliqué à une
adresse qu'on avait jugée inoffensive parce qu'elle était juste.

### Le correctif — même mécanisme que L0-10, étendu à deux variables de plus

Repris le protocole des trois moments (déclarée/livrée/consommée) déjà construit pour
`BABANA_MAPS_SEARCH_URL` :

- **Déclarée** vide dans `infra/env/.env.example`, sous l'exception D43 déjà documentée en tête
  du fichier (adresses de fournisseur externe, jamais de valeur ici).
- **Livrée** en développement par `make client` / `make driver` (Makefile, valeurs locales
  `https://api.localhost` / `wss://api.localhost/rt/ws`, motif `NAME="$(NAME)"` reconnu par
  `scanDeliveredByMakefile`) ; en production, le déploiement doit les poser lui-même.
- **Consommée** : inchangé, `apps/*/config.ts` (au build, `process.env.*`).

`apps/client/config.ts` et `apps/driver/config.ts` ne retombent plus sur
`'https://api.babana.cm'`/`'wss://api.babana.cm/rt/ws'` : une fonction `requireServerAddress`
lève à l'évaluation du module si la variable est absente — même discipline que
`getSearchUrl()`/`getGoogleMapsApiKey()` du paquet `@babana/maps` (D43). `apps/client/config.web.ts`
n'est **pas** concerné : son repli (`window.location.origin`) n'est pas une adresse de production
codée en dur, c'est l'origine courante (même origine que le bundle, D46) — la distinction, entre
un réglage qui peut avoir un repli réel et une destination qui ne le doit jamais, est celle que
D61 demande, et je l'ai écrite en commentaire dans `SELF_SUFFICIENT_DEFAULTS`.

`SELF_SUFFICIENT_DEFAULTS` retient désormais uniquement des RÉGLAGES (capture GPS, taille
d'upload) — jamais une DESTINATION — avec ce distinguo écrit en tête de liste pour que la
prochaine adresse n'y retourne pas par commodité.

**Portée volontairement restreinte à `apps/*/config.ts` (natif)**, pas au bundle web
(`infra/production/lib/build-web-bundle.sh`, `deploy.sh`) : `config.web.ts` n'a jamais eu ce
défaut (repli sûr, D46), y ajouter un garde-fou de build aurait été un changement sans motif
plutôt qu'une fermeture de D61 — et cela aurait cassé le test existant
`test/config/build-web-bundle.test.sh` sans raison métier. Étendre les mêmes garde-fous au bundle
web n'est donc pas fait ce soir : si une "recette" mobile automatisée voit le jour un jour, c'est
elle qui devra poser sa propre variable au build, comme `apps/client/config.ts` l'exige déjà.

### Corrigé au passage

`docs/operations/configuration.md` documentait encore `BABANA_API_URL` comme entrée de
`SELF_SUFFICIENT_DEFAULTS` avec repli `https://api.babana.cm` — n'était plus vrai après ce soir,
retiré, et une section D61 ajoutée à côté de celle de L0-10. `infra/env/README.md` (table des
variables + section "rien d'autre à renseigner") mis à jour avec les deux nouvelles lignes et la
même exception D43/D61 déjà rédigée pour `BABANA_MAPS_SEARCH_URL`.

### Tests

`test/config/config-coherence.test.ts` (6 tests, dépôt réel + preuves synthétiques des critères
2/3/4) : aucun maillon manquant. `test/config/build-web-bundle.test.sh` (3 scénarios, inchangé,
non affecté) : passe toujours. `npx tsc --noEmit` sur `apps/client` et `apps/driver` : propre —
`API_BASE_URL`/`REALTIME_WS_URL` restent typés `string`, aucun appelant à modifier. `npm run
lint -w @babana/client -w @babana/driver` : propre.

### Régression trouvée par `make test` en entier, pas par les vérifications ciblées

`requireServerAddress` lève dès l'import de `config.ts` si `BABANA_API_URL` est absente — ce que
`npx jest` **est** pour ces deux apps : les suites `apps/client`/`apps/driver` ne passent jamais
par le Makefile (`make client`), donc jamais par les valeurs de développement qu'il pose. 4 suites
sur 28 (`apps/driver`) et une partie de `apps/client` échouaient à l'import (`App.test.tsx`,
`tracker.test.ts`, `AppNavigator.test.tsx`…), avant même la moindre assertion. Trouvé seulement en
exécutant `make test` **en entier** sur base fraîche (CLAUDE.md, "la base de développement est
jetable, et doit être jetée régulièrement" -- ici, c'est la vérification complète qui manquait,
pas la base) : les vérifications ciblées de tout à l'heure (`tsc --noEmit`, `eslint`) ne chargent
jamais réellement `config.ts`, donc ne pouvaient pas voir ce défaut.

Corrigé par les deux `package.json` (`"test": "BABANA_API_URL=… BABANA_REALTIME_WS_URL=… jest"`)
-- des valeurs manifestement de test (`api.test.invalid`), jamais les adresses de développement
réelles : un test qui utiliserait par erreur `https://api.localhost` pour de vrai le signalerait
par un échec réseau, pas par un succès trompeur. **Un piège à noter** (`code/docs/odoo-pitfalls.md`
n'est pas le bon fichier, celui-ci est spécifique à Odoo -- gardé ici faute d'un meilleur endroit) :
le cache de transformation Babel de Jest est indexé par le contenu du fichier source, jamais par
les variables d'environnement lues par `babel-plugin-transform-inline-environment-variables` --
poser la variable sans `jest --clearCache` rejoue une ancienne transformation qui l'a déjà inlinée
en `undefined`. Rencontré deux fois de suite ce soir avant de comprendre pourquoi le correctif
semblait ne pas prendre.

### Tests (régression)

`npm test -w @babana/client -w @babana/driver` (cache Jest vidé au préalable) : client 19/19
suites (110/110 tests), driver 28/28 suites (193/193 tests, dont le test précédemment cassé par
l'absence de `BABANA_API_URL`).

---

## 3. L8-08 — les sauvegardes, exécutées pour de vrai

`infra/production/backup.sh`/`restore.sh` existent depuis L0-07, jamais exécutés. La tâche n'était
pas de les écrire, c'était de les rendre vrais — et les exécuter pour de vrai en a immédiatement
révélé trois défauts que la relecture n'avait jamais vus.

### Ce qui a été trouvé en essayant, pas en relisant

**1. Seul le `.env` était chiffré avant de quitter la machine.** Le dump PostgreSQL et le miroir
MinIO — qui porte les pièces d'identité de chauffeurs, L1-05 — partaient en clair par `rclone
copy`. Corrigé : chacun des trois est désormais écrit en clair dans `$WORK` (un `mktemp -d` local,
jamais transmis tel quel), chiffré (age) aussitôt, puis son clair est supprimé **avant** le seul
point d'envoi hors machine. Pas de chiffrement en pipe : `set -eu` seul ne détecterait pas l'échec
de `pg_dump` au milieu d'un pipeline (le code de sortie d'un pipeline POSIX est celui de sa
DERNIÈRE commande, `age`, qui réussirait même sur une entrée vide) sans `pipefail`, une extension
absente de `sh` (dash, l'interpréteur réel de ce script en production).

**2. L'image `minio/minio` (UBI-micro) n'a pas `tar`** — seul `mc` y est installé. Les deux scripts
supposaient un `tar` dans le conteneur pour archiver/désarchiver le miroir ; la première exécution
réelle a échoué net (`tar: command not found`). Corrigé : `docker compose cp` rapatrie/dépose le
répertoire tel quel entre le conteneur et l'hôte (qui a `tar`), qui fait l'archivage/l'extraction
lui-même — ni `backup.sh` ni `restore.sh` ne demandent plus rien au conteneur MinIO qu'il ne sait
déjà faire (`mc`).

**3. `${VAR:?message}` avec une apostrophe dans `message` casse le parseur de bash 3.2** — le
`/bin/sh` de macOS (licence GPLv3 oblige, Apple n'a jamais dépassé bash 3.2). `sh -n
infra/production/backup.sh` échouait AVANT toute exécution (`unexpected EOF while looking for
matching ''`), et le même défaut préexistait déjà dans `bootstrap.sh` (non touché ce soir, hors
périmètre, mais signalé ici pour que quiconque développe depuis un Mac ne tombe pas dessus sans
explication). `dash` (l'interpréteur réel de `/bin/sh` sur la cible Debian/Ubuntu) n'y voit rien —
ce n'est pas un défaut de production, seulement une gêne locale de développement — reformulé sans
apostrophe dans les deux messages de `backup.sh` que je touchais déjà.

### Ce qui a été ajouté

`restore.sh` accepte désormais `RESTORE_COMPOSE_PROJECT` (optionnel, vide par défaut = comportement
inchangé) : posé, il fait tourner la restauration dans un projet `docker compose` **isolé**
(conteneurs et volumes séparés de toute pile déjà en cours sous le nom par défaut). C'est exactement
ce que L8-08 demande pour un « exercice de restauration à refaire périodiquement » (spécification)
sans jamais risquer d'écraser une base déjà en usage — et c'est ce qui a rendu la preuve de ce soir
possible sans toucher à la pile de développement vivante.

Documenté (jusque-là écrit nulle part dans `infra/production/` ni `docs/operations/production.md`,
critère d'acceptation 5) : **Redis n'est délibérément pas sauvegardé** — invariant 1, règle de
partition (`amoa/01-architecture.md` §2). Le service temps réel ne possède aucune donnée durable ;
une reprise se reconstruit depuis PostgreSQL (L3-14, test de résilience), jamais depuis Redis.

### La preuve exécutée ce soir — et où elle s'arrête

`age` et `rclone` sont absents de cette machine, et le réseau de cet environnement de développement
est restreint (`ghcr.io`, `github.com`, `dl-cdn.alpinelinux.org` injoignables ; Docker Hub, PyPI et
le registre npm le sont). Contourné en extrayant/exécutant les deux outils depuis des images Docker
officielles publiques (`jauderho/age`, `rclone/rclone`) au lieu d'un paquet système — deux petits
scripts de délégation dans le répertoire de travail de la session, jamais commités, jamais dans le
dépôt. **Rien dans `backup.sh`/`restore.sh` n'a été adapté à ce contournement** : les deux scripts
tournent tels quels, exactement ce qu'un hôte de production avec `age`/`rclone` réellement installés
exécuterait.

Séquence réellement exécutée :

1. `backup.sh` (réel, non simulé) contre la pile de développement **vivante** (101 courses semées) —
   `BACKUP_REMOTE` posé vers un répertoire local (le remplaçant assumé du stockage objet distant,
   `rclone copy` traite un chemin local exactement comme un remote) ;
2. vérifié que seuls des fichiers `.age` atteignent cette destination (`ls` du répertoire de sortie) ;
3. `docker compose -p babana-restore-test -f infra/compose.yaml up -d --wait postgres minio` —
   conteneurs et volumes **neufs**, projet isolé de la pile de développement ;
4. déchiffrement (`age -d`) puis `pg_restore` + rechargement MinIO dans ces conteneurs neufs, avec
   les commandes mêmes de `restore.sh` (pas une réimplémentation) ;
5. les quatre éléments demandés, retrouvés par requête directe contre la base restaurée :

| Élément | Retrouvé |
|---|---|
| Course encaissée | `C2026000355`, `state = settled` |
| Sa facture | `BINV/2026/00029`, `state = posted`, 1 425 FCFA |
| Document chauffeur | id 189, chauffeur 421, permis — objet MinIO `drivers/421/id_card/24f2394…jpg` retrouvé, **même ETag** avant/après (`dcc91063ca35554ef202652ff57705ac`) |
| Solde de compte courant | chauffeur 410 : mouvement `collection` de 425 FCFA intact |

Conteneurs et volumes de la preuve démontés ensuite (`down -v`) — reproductible, séquence complète
dans `docs/operations/production.md` §7.

**Où passe la frontière, sans ambiguïté** : ce qui précède prouve que le MÉCANISME fonctionne —
chiffrement compris, `pg_restore`, rechargement MinIO — contre des conteneurs neufs de CE dépôt.
Cela ne prouve PAS une restauration sur un **hôte vierge chez un autre hébergeur** (critère
d'acceptation 4 de L8-08, "l'exercice de restauration" que la spécification exige) : aucun compte
chez un hébergeur tiers, aucune seconde machine, n'existent dans cet environnement. Ce second geste
reste entièrement à faire par vous — la ligne du journal `docs/operations/production.md` §7 dédiée
à ce critère réel reste à sa première ligne, `_(à remplir au premier exercice)_`.

### Un défaut trouvé au passage, non corrigé (hors périmètre)

`babana.driver.document` id 227 (chauffeur 440, pièce d'identité) porte `storage_key =
"seed/babana-demo-driver-5/id_card.jpg"` — un objet qui **n'existe pas** dans MinIO, ni dans la
sauvegarde ni dans la pile de développement source (vérifié directement : `mc stat` échoue déjà
AVANT toute sauvegarde). La ligne en base existe, l'objet qu'elle prétend décrire jamais téléversé
-- vraisemblablement un défaut de `make seed`/`services/odoo/scripts/seed.py`, hors du périmètre de
cette nuit (L8-08 ne porte pas sur le jeu de données). Signalé ici plutôt que corrigé en silence ;
un supervisor qui ouvrirait ce document précis verrait un lien mort.

### Tests

Aucun test intégré à `make test` n'a été ajouté pour `backup.sh`/`restore.sh` : même choix déjà
fait pour `deploy.sh`/`bootstrap.sh` dans ce dépôt — la spécification L8-08 elle-même définit la
preuve comme un « exercice… avec compte rendu daté », pas une assertion automatisée, et une vraie
suite `make test` exigerait docker + age + rclone dans l'environnement d'intégration continue, hors
de portée de cette nuit. Vérifié à la place : `sh -n`/`dash -n` sur les deux scripts (propre, y
compris après le correctif de l'apostrophe) et l'exécution réelle ci-dessus, de bout en bout, deux
fois (l'échec du 3 septembre à 13h00 UTC avant le correctif MinIO, le succès à 13h01 après).

---

## Non-régression

`make reset && make up`, `make test` en entier sur base fraîche : suite Odoo **2 582 tests, 0
échec, 0 erreur**. `services/realtime` : 226/226 dans une première passe complète ; une deuxième
passe (après le correctif Jest ci-dessus, machine chargée par une longue soirée de docker/tests)
a montré un échec isolé sur `L3-20` (`test/nearby.test.ts`, compte de minuteurs après
`unsubscribe()`, 7 au lieu de 6 attendus) -- rejoué trois fois d'affilée en isolation, toujours
vert (315/327/312 ms). Non touché ce soir, préexistant, jamais vu échouer avant cette nuit : gardé
en doute plutôt qu'écarté en silence, voir plus bas. `apps/client` 19/19 (110 tests), `apps/driver`
28/28 (193 tests, cache Jest vidé). `test/concurrency` + `auth` + `http-contract` + `config` :
**43/43, 8/8 suites** (dont les scénarios réels contre Redis/PostgreSQL, 97 à 104 s chacun --
lents, jamais instables). `test/config/build-web-bundle.test.sh` : 3 scénarios, vert.
`make lint` et `make typecheck` sur tout l'arbre : propres.

---

## Ce qui laisse un doute pour quelqu'un de réel

**Le flake isolé de `L3-20` (`services/realtime/test/nearby.test.ts`), trouvé une seule fois cette
nuit, jamais avant.** Rejoué proprement en isolation (3/3), donc probablement une question de
charge machine plutôt qu'une vraie course critique dans le code -- mais « probablement » n'est pas
« vérifié », et ce test protège précisément une classe de défaut (un minuteur qui survit à
`unsubscribe()`) qui ne se verrait qu'en production, sous charge, des semaines plus tard. Si ce
test échoue à nouveau une prochaine nuit, sans lien avec ce qui aura changé, il mérite le
traitement complet de la politique de non-régression (test qui prouve mal, pas seulement
« rejoué et c'est reparti »).

**Le document chauffeur orphelin de `make seed`** (id 227, `storage_key` pointant vers un objet
MinIO qui n'a jamais existé, §3) -- un supervisor qui ouvrirait cette pièce précise verrait un lien
mort. Découvert en vérifiant la restauration, pas en cherchant ce défaut ; personne ne l'a
recherché ailleurs dans le jeu de données. Une seule occurrence trouvée, mais je n'ai pas balayé
l'ensemble des documents semés pour vérifier qu'elle est unique.

**La preuve L8-08 de ce soir ne couvre que la mécanique, jamais la vraie frontière du critère.**
Chiffrement, `pg_restore`, rechargement MinIO : réels, vérifiés, avec des identifiants de course
et un ETag d'objet à l'appui. Mais tout s'est passé dans des conteneurs de CE dépôt, sur CETTE
machine -- jamais sur un hôte vraiment vierge, jamais chez un hébergeur tiers, jamais avec les
`age`/`rclone` réellement installés sur un système qui n'a pas de Docker Desktop pour les
contourner. Le jour où vous ferez ce geste pour de vrai, une surprise que cette nuit n'a pas pu
voir reste possible -- l'écart entre « fonctionne dans un conteneur qu'on contrôle entièrement » et
« fonctionne sur une machine louée, DNS et pare-feu compris » n'est pas nul, `deploy.sh`/
`bootstrap.sh` l'ont déjà démontré une fois (le défaut du 13 septembre).

**`bootstrap.sh` ne provisionne ni `age` ni `rclone` sur l'hôte de production.** `backup.sh` les
exige (`command -v … || die`) mais rien ne les installe -- un point que cette nuit a buté dessus en
long sur cette machine de développement, et qui buterait pareillement sur un VPS fraîchement
provisionné qui suit seulement `bootstrap.sh`. Non corrigé ce soir (hors du périmètre confié,
`bootstrap.sh` porte le durcissement SSH/pare-feu, pas l'outillage applicatif) -- mais à poser
avant le premier déploiement réel, pas à découvrir ce jour-là.
