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
| `SELF_SUFFICIENT_DEFAULTS` | Variables réellement consommées, mais avec un repli **réel** (jamais `undefined`/`''`) — leur absence ne casse rien | `BABANA_API_URL` (repli `https://api.babana.cm`), les réglages de capture GPS de `apps/driver/config.ts` (L6-05, PROVISOIRES au sens de D21, `amoa/questions/L6-05.md`) |
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

## Vérifier soi-même

```bash
cd code
npx tsx --test test/config/config-coherence.test.ts   # les trois moments, dépôt réel + preuves
sh test/config/build-web-bundle.test.sh                # le défaut du 13 septembre, reproduit et corrigé
```

Les deux tournent dans `make test`, sans docker ni secret.
