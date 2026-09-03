# Cohérence de la chaîne de configuration (L0-10)

Créée le 13 septembre 2026 (D59, `amoa/01-architecture.md` §9 sexies), après le troisième défaut
de la même famille en une semaine : une variable **documentée**, **gardée par un contrôle**, et
**jamais délivrée** au code qui la lit. `ADMIN_PASSWORD` (11 septembre), `SMTP_HOST` (nuit J36),
puis `BABANA_MAPS_SEARCH_URL`/`BABANA_GOOGLE_WEB_CLIENT_ID`/`BABANA_GOOGLE_MAPS_API_KEY` au build
web du Client (13 septembre) : trois incidents, un seul motif. Personne ne vérifiait le lien
entre ce qu'un document annonçait et ce qu'un mécanisme faisait réellement.

## Les trois moments

Une variable de configuration a trois moments, et un incident de cette famille est toujours
l'absence d'un des trois :

1. **Déclarée** — présente dans `infra/env/.env.example` (vide quand D43 l'exige : une adresse
   de fournisseur externe ne porte jamais la valeur d'un simulateur, voir `infra/env/README.md`).
2. **Livrée** — transmise à ce qui la consommera :
   - `infra/compose.yaml` / `infra/compose.dev.yaml` pour un conteneur (`${NOM}`) ;
   - l'environnement **exporté** du processus de build, pour une variable lue à la compilation
     (`infra/production/lib/build-web-bundle.sh`, ou les cibles `make client`/`client-web` en
     développement) — **exporté**, pas seulement posé en variable de shell : c'est exactement le
     maillon qui a manqué le 13 septembre ;
   - un `post_init_hook` (`services/odoo/addons/babana/__init__.py`), pour ce qu'Odoo doit
     traduire en enregistrement (mot de passe administrateur, relais SMTP).
3. **Consommée** — lue quelque part dans `services/`, `apps/`, `packages/` ou `infra/`.

`tools/config-coherence/scan.ts` recense les trois pour chaque variable rencontrée (déclarée, ou
simplement trouvée dans le code) et `test/config/config-coherence.test.ts` échoue dès qu'un
maillon manque, dans les deux sens : une variable consommée mais jamais déclarée, une variable
déclarée que rien ne livre, une variable déclarée et livrée que rien ne consomme. Il tourne à
chaque `make test` (glob `config/*.test.ts` de l'espace de travail `test/`).

## Portée du scan — ce qui est suivi, ce qui ne l'est pas

Suivre *toute* variable lue par ce dépôt ferait échouer la suite sur des dizaines de réglages
métier légitimes (`services/realtime/src/config.ts` en a plus de trente, `apps/driver/config.ts`
une douzaine) qui ont un repli **réel** — un seuil, un délai, une adresse de production déjà
correcte — et dont l'absence ne casse rien. Ce n'est pas le défaut du 13 septembre. Le scan ne
suit donc que ce qui ressemble structurellement à ce défaut-là : une adresse ou un secret de
fournisseur dont l'absence dégrade silencieusement (`undefined`, `''`, ou une exception Python
sans repli).

Trois listes explicites, dans `tools/config-coherence/variables.ts`, documentent ce qui est
volontairement hors du protocole des trois moments — jamais un défaut silencieux :

| Liste | Rôle | Exemple |
|---|---|---|
| `INTERNAL_TOPOLOGY_NAMES` | Topologie du réseau Docker interne, fixée en dur dans `infra/compose.yaml`, jamais dans `.env.example` — même raisonnement déjà écrit dans `infra/env/README.md` pour `REDIS_URL`/`ODOO_INTERNAL_URL`, étendu ici à ce que L1-05/L3-12 ont ajouté depuis | `S3_ENDPOINT`, `S3_ACCESS_KEY` (renommage volontaire de `MINIO_ROOT_USER`, convention S3 côté Odoo), `REALTIME_INTERNAL_URL` |
| `SELF_SUFFICIENT_DEFAULTS` | Variables réellement consommées, mais avec un repli **réel** (jamais `undefined`/`''`) — leur absence ne casse rien. Réservée aux RÉGLAGES (seuil, délai, plafond) depuis D61 (`amoa/questions/REPONSES-2026-09-14.md` §3) — jamais une DESTINATION : `BABANA_API_URL`/`BABANA_REALTIME_WS_URL` en sont sorties ce soir-là, voir plus bas | les réglages de capture GPS de `apps/driver/config.ts` (L6-05, PROVISOIRES au sens de D21, `amoa/questions/L6-05.md`) |
| `EXCEPTIONS` | Un vrai maillon manquant, assumé et tracé — jamais silencieux. **Chaque entrée nomme la tâche qui la fermera** ; une exception sans tâche fait échouer la suite (`checkExceptionsManifest`) | voir table ci-dessous |

Le scan exclut aussi les répertoires `test/`, `tests/`, `__tests__/` : une suite de test lit
souvent des variables de **paramétrage de banc d'essai** (nombre d'itérations d'un test de
concurrence, adresse d'un mock choisie par le test — `GOOGLE_MOCK_IDENTITY_URL`,
`L3_13_ITERATIONS`) qui n'ont rien à voir avec la chaîne de configuration de production.

## Exceptions actuelles

| Variable | Pourquoi elle manque un maillon | Tâche de fermeture |
|---|---|---|
| `SMS_GATEWAY_API_KEY`, `SMS_GATEWAY_SENDER_ID` | Passerelle SMS non choisie ; L1-09 journalise l'OTP au lieu de l'envoyer (D19) | L1-09 |
| `GOOGLE_MAPS_API_KEY` | Clé du SDK natif de carte (rendu `<MapView>`, `AndroidManifest.xml`/`Info.plist`) — distincte de `BABANA_GOOGLE_MAPS_API_KEY` (appels REST, déjà suivie). Prérequis suivi hors code, à poser avant L6-06 (`amoa/05-prerequis-et-simulation.md` §5) | L6-06 |
| `BABANA_GOOGLE_IOS_CLIENT_ID` | Consommée (`apps/*/config.ts`) mais jamais livrée : aucun build iOS n'existe encore, Android est prioritaire (CDC §III.1) | iOS après le pilote (`amoa/03-decoupage-taches.md` §6) |

**Correction au passage** (vérifiée dans le dépôt, pas recopiée de la spécification de cette
tâche) : `FCM_PROJECT_ID`/`FCM_CLIENT_EMAIL`/`FCM_PRIVATE_KEY`, un temps pressenties comme
exception possible, sont en réalité déjà déclarées, livrées (`infra/compose.yaml`) **et**
consommées (`services/odoo/addons/babana/services/push.py`, `FcmPushProvider`) — les trois
moments tiennent, ce n'est pas un maillon manquant. Seule la vérification contre un vrai compte
Firebase reste à faire, au pilote — hors de ce que ce test mesure. Voir `amoa/questions/L0-10.md`.

## D61 — un repli plausible est pire qu'une absence

`BABANA_API_URL`/`BABANA_REALTIME_WS_URL` (adresse de l'API et du service temps réel pour les
apps natives Client/Chauffeur, `apps/*/config.ts`) ont vécu dans `SELF_SUFFICIENT_DEFAULTS`
jusqu'au 14 septembre 2026, au motif que leur repli était « une adresse de production réelle »
(`https://api.babana.cm` / `wss://api.babana.cm/rt/ws`). Le repli était bien réel, ce qui posait
justement problème : un binaire construit sans ces variables ne dégradait rien de visible, il
parlait silencieusement à la vraie production (`amoa/questions/REPONSES-2026-09-14.md` §3) — même
famille de défaut que celle que D43 a fermée pour `BABANA_MAPS_SEARCH_URL` (une adresse plausible
se croit, une adresse absente se voit).

Retournées au protocole des trois moments comme `BABANA_MAPS_SEARCH_URL` : déclarées vides dans
`infra/env/.env.example` (exception D43 déjà en tête du fichier), livrées en développement par
les cibles `make client` / `make driver` (`Makefile`, motif `NOM="$(NOM)"` reconnu par
`scanDeliveredByMakefile`), consommées par `apps/*/config.ts` qui lève désormais
(`requireServerAddress`) plutôt que de deviner un serveur en leur absence — même discipline que
`getSearchUrl()` du paquet `@babana/maps`.

`apps/client/config.web.ts` n'est pas concerné : son repli (`window.location.origin`, même
origine que le bundle, D46) n'est pas une adresse de production codée en dur — c'est l'origine
courante, une propriété du navigateur, pas une destination choisie par le code.

## Le défaut du 13 septembre, précisément

`infra/production/deploy.sh` faisait `. infra/env/.env` puis, plus bas, `npm run build:web -w
@babana/client` directement. Un `. fichier` en shell pose des variables de **shell** ; il ne les
transmet **pas** aux processus fils sans `export`. `npm` (et donc babel via
`transform-inline-environment-variables`) tournait donc avec `BABANA_MAPS_SEARCH_URL`,
`BABANA_GOOGLE_WEB_CLIENT_ID` et `BABANA_GOOGLE_MAPS_API_KEY` absentes de son environnement, quelle
que soit leur valeur dans `.env`. Preuve trouvée dans le dépôt ce matin-là,
`apps/client/dist-web/bundle.js` :

```js
var MAPS_SEARCH_URL = false||undefined;
var GOOGLE_WEB_CLIENT_ID = false||'';
```

Déployé tel quel, le Client web ne permet ni de se connecter (Google Sign-In) ni de chercher un
lieu — les deux premières choses qu'un client fait. Et rien n'échouait au déploiement :
`smoke-test.sh` vérifie que Caddy sert une page, et la page était bien servie.

**Correction, en deux garde-fous plutôt qu'un** :

1. `deploy.sh` exporte désormais tout ce que `infra/env/.env` déclare (`set -a` autour du
   sourcing, borné par `set +a` juste après) — un filet mécanique contre toute variable de build
   future qu'on oublierait d'exporter une par une.
2. `infra/production/lib/build-web-bundle.sh` (`build_web_bundle`), isolé de `deploy.sh` pour
   rester testable sans docker ni dépôt git réel, exporte explicitement les trois variables de
   build juste avant d'invoquer `npm`, **puis vérifie le fichier produit** — `grep` la valeur
   réelle de chacune dans `apps/client/dist-web/bundle.js` — plutôt que de se fier à ce qui a été
   transmis. C'est la distinction du critère d'acceptation 6 de L0-10 : le contrôle porte sur le
   bundle **produit**, pas sur les variables d'environnement — un bundle qui manque une adresse
   de recherche fait échouer le déploiement, vérifié sur le fichier de sortie.

`deploy.sh` **échoue** désormais si l'une des trois est vide ou pointe vers une valeur de
développement (`mock-maps`, `dev-client-id.apps.googleusercontent.com`) — il n'avertit plus (D43
appliqué à la chaîne de build, comme aux adresses de fournisseur externe déjà gardées plus haut
dans le même script).

`test/config/build-web-bundle.test.sh` (exécuté par `make test`) reproduit le défaut ci-dessus à
l'identique — variables posées comme variables de shell, jamais exportées, contre un faux `npm`
qui se comporte comme le plugin Babel réel (absente de son environnement → `undefined`) — et
vérifie que le bundle produit est cassé ; puis rejoue le même scénario à travers
`build_web_bundle` et vérifie que le bundle produit est correct. C'est la preuve, exigée par le
critère d'acceptation 7, que ce test échoue sur le `deploy.sh` d'avant cette tâche.

## D65 — « livrée » se vérifie par service, jamais globalement

Ajoutée le 17 septembre 2026 (`amoa/questions/REPONSES-2026-09-17.md` §2), après que ce contrôle
s'est révélé vert sur `BABANA_DOMAIN` alors que le conteneur `odoo` ne l'avait jamais reçue — seul
`caddy` la recevait. Le défaut de « livraison » du §2 ci-dessus (`isDelivered`) ne posait qu'une
question : la variable apparaît-elle *quelque part* dans un fichier compose ? Une variable livrée
au mauvais conteneur passait ce test aussi bien qu'une variable livrée au bon.

`scanDeliveredByCompose` rattache désormais chaque `${VAR}` de `infra/compose*.yaml` au service
dans lequel elle apparaît (parseur ligne à ligne : une clé à 2 espaces d'indentation directement
sous `services:` ouvre un nouveau service, jusqu'à la clé de même niveau suivante). Le critère 1
bis rapproche ce service du **répertoire du consommateur** — trois cas seulement, ceux que la
spécification nomme, jamais plus :

| Consommateur | Service exigé dans la livraison |
|---|---|
| `services/odoo/` | `odoo` (`infra/compose.yaml` / `infra/compose.dev.yaml`) |
| `services/realtime/` | `realtime` |
| `apps/` | `build` — Makefile (`scanDeliveredByMakefile`) ou export de shell (`scanDeliveredByShellExport`), jamais un conteneur compose |

Une variable consommée par deux groupes (`JWT_SECRET`, `REALTIME_SHARED_SECRET` : à la fois
`services/odoo/` et `services/realtime/`) doit apparaître dans les deux blocs — c'est déjà le cas
aujourd'hui, pas une exigence nouvelle. Tout consommateur hors de ces trois préfixes (simulateurs
de `services/mocks/`, scripts d'exploitation, `packages/`) garde l'ancien comportement non
différencié : une livraison n'importe où suffit encore, comme avant D65 — étendre la liste sans
qu'une spécification le nomme reproduirait, en sens inverse, l'excès que D65 corrige.

**Preuve sur le cas réel** : retirer `BABANA_DOMAIN: ${BABANA_DOMAIN}` du bloc `environment` du
service `odoo` dans `infra/compose.yaml` fait échouer `aucun maillon manquant parmi les variables
déclarées ou consommées` avec exactement le message `BABANA_DOMAIN : consommée par le service
\`odoo\`... mais rien ne l'y livre (D65)`. Remettre la ligne fait repasser la suite au vert.
Vérifié à blanc le 17 septembre, pas laissé dans le dépôt (une suite qui casse le compose de
production pour se prouver serait pire que l'absence de preuve).

**Trouvé en construisant ce critère, même famille que `BABANA_DOMAIN`** : `NODE_ENV`, consommée
par `apps/client/webpack.config.js` (mode `production`/`development` du bundle web), n'était
livrée qu'à des conteneurs compose (`realtime`, les simulateurs de développement) — jamais à
l'environnement du build. Un bundle de production construit sans `NODE_ENV=production`
retomberait silencieusement en mode développement. Corrigé par un `export NODE_ENV` explicite
dans `build_web_bundle()` (`infra/production/lib/build-web-bundle.sh`, hors du groupe de
variables vérifiées dans le fichier produit : webpack consomme `NODE_ENV` pour choisir un mode,
il ne l'inline pas littéralement) et par `deploy.sh`, qui **échoue** désormais si `NODE_ENV !=
production` au lieu d'avertir — même discipline D43 que le reste de ce document.

## Vérifier soi-même

```bash
cd code
npx tsx --test test/config/config-coherence.test.ts   # les trois moments + le rapprochement par service (D65), dépôt réel + preuves
sh test/config/build-web-bundle.test.sh                # le défaut du 13 septembre, reproduit et corrigé
```

Les deux tournent dans `make test`, sans docker ni secret.
