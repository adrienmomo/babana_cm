# Rapport — nuit J41 (3 septembre 2026), dernière nuit du périmètre pilote

Périmètre : D65 (livraison vérifiée par service), L10-01 (scénarios de bout en bout), passe de
clôture.

---

## 1. D65 — la livraison se vérifie par service

`tools/config-coherence/scan.ts::scanDeliveredByCompose` traitait « livrée » comme un booléen :
une variable apparaissant n'importe où dans `infra/compose*.yaml` était livrée, point. C'est ce
qui a laissé passer `BABANA_DOMAIN` livrée à `caddy` et lue par `odoo` — le défaut trouvé hier.

**Ce qui change.** Le scan compose est maintenant un petit parseur ligne à ligne (pas de
dépendance YAML : une clé à 2 espaces d'indentation directement sous `services:` ouvre un
service, jusqu'à la clé de même niveau suivante — la mise en forme du dépôt est stable) qui
rattache chaque `${VAR}` au service dans lequel elle apparaît. Le critère 1 bis rapproche ce
service du répertoire du consommateur, seulement pour les trois cas que la spécification nomme :
`services/odoo/` → service `odoo`, `services/realtime/` → service `realtime`, `apps/` →
l'environnement du build (Makefile ou export de shell, jamais un conteneur). Tout le reste
(simulateurs, scripts d'exploitation, `packages/`) garde l'ancien comportement non différencié —
étendre la règle sans qu'une spécification le nomme aurait été le même excès que le défaut,
inversé.

**Preuve sur le cas réel, à blanc.** `BABANA_DOMAIN: ${BABANA_DOMAIN}` retirée du bloc `odoo` de
`infra/compose.yaml` → la suite échoue avec le message exact attendu (`consommée par le service
\`odoo\`... mais rien ne l'y livre (D65)`). Remise en place → verte. Pas laissé dans le dépôt entre
les deux : casser le compose de production pour se prouver serait pire que l'absence de preuve.
Quatre tests synthétiques ajoutés à `test/config/config-coherence.test.ts` couvrent le mécanisme
sans dépendre de l'état du vrai dépôt (mauvais service, bon service, groupe `build`, variable
consommée par deux services à la fois — `JWT_SECRET`/`REALTIME_SHARED_SECRET`, qui doivent
apparaître dans les deux blocs et l'ont déjà).

**Un deuxième cas trouvé en construisant le critère, même famille.** `NODE_ENV`, consommée par
`apps/client/webpack.config.js` pour choisir le mode du bundle (`production`/`development`),
n'était livrée qu'à des conteneurs compose — jamais à l'environnement du build. Un bundle de
production construit sans `NODE_ENV=production` retombe silencieusement en mode développement :
plus volumineux, avertissements React non retirés — pas un incident de la gravité de
`BABANA_DOMAIN` (aucune donnée n'atterrit au mauvais endroit), mais la même forme de trou. Corrigé
par un `export NODE_ENV` explicite dans `build_web_bundle()` (en dehors du groupe de variables
vérifiées dans le fichier produit : webpack consomme `NODE_ENV` pour un mode, il ne l'inline pas
littéralement, contrairement à `BABANA_MAPS_SEARCH_URL` et consorts) et `deploy.sh` qui **échoue**
désormais si `NODE_ENV != production`, au lieu d'avertir — la ligne existait déjà, elle n'avait
simplement pas reçu la discipline D43 appliquée au reste du script.

**Deux fixtures du critère 2 corrigées au passage** (`test/config/config-coherence.test.ts`) :
elles consommaient depuis `apps/fixture/config.ts` et ne livraient que par compose — cohérent
avant D65, plus après (le nouveau critère 1 bis les aurait fait échouer pour la mauvaise raison).
Déplacées vers `services/fixture/`, hors des trois préfixes suivis, pour rester des tests du
protocole général, indépendants du rapprochement par service qui a maintenant sa propre section.

Fichiers : `tools/config-coherence/scan.ts`, `test/config/config-coherence.test.ts`,
`infra/production/deploy.sh`, `infra/production/lib/build-web-bundle.sh`,
`docs/operations/configuration.md`.

`npx tsx --test test/config/config-coherence.test.ts` : 10/10. `tsc --noEmit` (espace `test/`) :
propre.
