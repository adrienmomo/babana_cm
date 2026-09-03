# Rapport de nuit — J37

Tenu au fil de l'eau, une entrée par tâche finie. Lu en entier : `CLAUDE.md`,
`amoa/questions/REPONSES-2026-09-13.md`, `amoa/01-architecture.md` §9 sexies,
`amoa/specs/L0-socle.md` (L0-10), `amoa/specs/L4-course.md` (L4-05/L4-06, D57/D58),
`infra/production/deploy.sh`, `infra/env/.env.example`, `infra/env/README.md`,
`services/odoo/addons/babana/models/babana_ride_invoice.py`,
`services/odoo/addons/babana/models/babana_ride_state.py`,
`services/odoo/addons/babana/services/push.py`,
`services/odoo/addons/babana/tests/test_realtime_commit_hook.py`.

Périmètre confié : L0-10 (cohérence de la chaîne de configuration), D57 (facture automatique et
visibilité de l'échec), le test instable de `test_realtime_commit_hook.py`.

---

## 1. L0-10 — la cohérence des trois moments, mécanique plutôt que relue

### Le mécanisme

`code/tools/config-coherence/` recense, pour chaque variable rencontrée (déclarée dans
`infra/env/.env.example`, ou simplement trouvée dans le code), ses trois moments — déclarée,
livrée, consommée — et signale tout maillon manquant, dans les deux sens. `test/config/
config-coherence.test.ts` l'exécute contre le vrai dépôt (doit rester vide) et, séparément,
contre des mini-dépôts synthétiques (`mkdtemp`) qui prouvent chaque famille de défaut sans
modifier puis annuler le vrai dépôt à chaque passage — critères d'acceptation 2, 3 et 4 de
L0-10, chacun avec sa preuve.

**Portée délibérément restreinte.** Un scan qui suivrait toute variable lue par ce dépôt aurait
fait échouer la suite sur des dizaines de réglages métier légitimes (`services/realtime/src/
config.ts` en porte plus de trente, `apps/driver/config.ts` une douzaine) qui ont un repli réel
et dont l'absence ne casse rien — ce n'est pas le défaut du 13 septembre. `tools/config-
coherence/variables.ts` documente explicitement ce qui est hors du protocole
(`INTERNAL_TOPOLOGY_NAMES`, `SELF_SUFFICIENT_DEFAULTS`) et ce qui est un vrai maillon manquant
assumé (`EXCEPTIONS`, chacune avec sa tâche de fermeture).

**Une exception de la spécification s'est révélée fausse en la vérifiant.** `amoa/specs/
L0-socle.md` donnait « FCM_* sans fournisseur » comme exemple d'exception attendue. Vérifié dans
le dépôt avant de la recopier dans `variables.ts` (CLAUDE.md : une dépendance supposée absente se
vérifie dans le dépôt) : `FCM_PROJECT_ID`/`FCM_CLIENT_EMAIL`/`FCM_PRIVATE_KEY` sont déjà
déclarées, livrées (`infra/compose.yaml`) et consommées (`services/push.py::FcmPushProvider`,
avec ses tests) — les trois moments tiennent, aucune exception à poser. Écart consigné dans
`amoa/questions/L0-10.md`, sur `master`.

### Le défaut du 13 septembre, fermé

`infra/production/deploy.sh` faisait `. infra/env/.env` puis `npm run build:web -w
@babana/client` directement : un `. fichier` en shell pose des variables de SHELL, jamais
transmises à un processus fils sans `export`. Preuve dans le dépôt ce matin-là,
`apps/client/dist-web/bundle.js` : `MAPS_SEARCH_URL = false||undefined`.

Deux garde-fous, pas un seul :

1. `deploy.sh` exporte désormais tout ce que `.env` déclare (`set -a`/`set +a` autour du
   sourcing) — un filet mécanique contre toute variable de build future qu'on oublierait
   d'exporter une par une.
2. `infra/production/lib/build-web-bundle.sh` (`build_web_bundle`), isolé pour rester testable
   sans docker ni dépôt git réel, exporte explicitement les trois variables de build juste avant
   `npm`, **puis grep le fichier produit** (`apps/client/dist-web/bundle.js`) pour la valeur
   réelle de chacune — le contrôle porte sur le bundle produit (critère 6), pas sur les variables
   d'environnement.

`deploy.sh` échoue désormais si l'une des trois (`BABANA_MAPS_SEARCH_URL`,
`BABANA_GOOGLE_WEB_CLIENT_ID`, `BABANA_GOOGLE_MAPS_API_KEY`) est vide ou pointe vers une valeur
de développement — il n'avertit plus (D43 étendu à la chaîne de build).

**Critère 7** : `test/config/build-web-bundle.test.sh` reproduit le défaut à l'identique — les
trois variables posées comme variables de shell, jamais exportées, contre un faux `npm` qui se
comporte comme le vrai plugin Babel (absente de son environnement → `undefined`) — vérifie que le
bundle produit est cassé, puis rejoue le même scénario à travers `build_web_bundle` et vérifie
qu'il est correct. C'est la preuve que ce test échoue sur le `deploy.sh` d'avant cette tâche.

**Corrigé au passage** : `infra/env/README.md` affirmait que `.env` « n'a pas d'équivalent en
production » et que le déploiement injecte les variables directement dans le conteneur — faux
depuis L0-07, `deploy.sh` lit bien `infra/env/.env` sur le serveur. Corrigé, avec renvoi vers
`docs/operations/configuration.md`.

### Tests

`test/config/config-coherence.test.ts` (6, dépôt réel + preuves synthétiques des critères 2/3/4).
`test/config/build-web-bundle.test.sh` (3 scénarios, exécuté par `make test`) : le défaut
reproduit et corrigé, l'échec avant tout appel npm si une variable est vide.

