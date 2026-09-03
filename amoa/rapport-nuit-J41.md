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

---

## 2. L10-01 — le filet qui protège tout le reste

`test/e2e/full-ride.test.ts` (nouveau, avec `test/e2e/helpers/actors.ts` et
`test/e2e/fixtures/geo.ts`) : le scénario nominal (les neuf étapes de la spécification) plus les
quatre variantes réellement testables aujourd'hui, contre l'environnement complet (`make up`), par
le VRAI chemin — jamais un raccourci RPC pour une transition qu'un vrai client déclencherait. Les
seuls appels RPC directs préparent un fixture (approbation de dossier, plafond de test) ou LISENT
un état pour vérification.

**Refus, annulation, plafond d'encaisse + remise de caisse, notifications désactivées.** Le refus
passe par le vrai `proposal.reject` (WebSocket, symétrique de `acceptProposalOverWs` que
`test/concurrency` avait déjà — je n'ai ajouté que son pendant refus). Le plafond se pose sous le
montant réellement dû par la course (`ir.config_parameter`, paramétrable — invariant 5), franchi
par un seul encaissement quelle que soit la grille tarifaire du jour ; la remise valide par
`babana.cash.remittance::button_validate` — le seul chemin RPC-sûr, `action_validate` exigeant un
recordset `supervisor` qu'un appel RPC ne peut jamais fournir.

**Une découverte en construisant le scénario du plafond, réparée dans les fixtures de test, pas
dans le code de production.** `_babana_apply_cash_limit` ne détecte un franchissement que si
`babana.driver.is_online` est vrai côté Odoo — un champ que `bringDriverOnline`
(`test/concurrency/helpers/realtime.ts`, réutilisé ici) ne pose jamais : il ne fait passer en
ligne que le pool du service temps réel (WebSocket), jamais ce champ Odoo, qui se pose par
`POST /drivers/me/availability`. Les deux sont délibérément découplés (commentaire de
`cash-guard.ts`), et aucun scénario existant n'avait eu besoin des deux à la fois avant celui-ci —
ni `test/concurrency` (ne lit jamais `is_online`), ni `test/http-contract::setAvailability`
(n'a jamais eu besoin du pool en même temps). `setUpRideActors` appelle désormais les deux, dans
l'ordre qu'un vrai chauffeur suit.

**Deux points ne sont pas vérifiables tels que la spécification les nomme** —
`amoa/questions/L10-01.md` : le « journal d'audit complet » de l'étape 9 (`babana.audit.log`,
L8-09, jamais faite — `_babana_journalize` le dit lui-même : « point d'accroche unique pour L8-09,
pour l'instant journal applicatif standard ») et un réglage « notifications désactivées » nommé
L7-06 (jamais programmée, aucun `controllers/state.py` ni `resync.ts` sous ces noms). Pour la
première, l'étape 9 vérifie ce qui existe réellement (facture liée, solde incrémenté), pas
davantage. Pour la seconde, j'ai trouvé que le mécanisme dont L7-06 a besoin existe déjà sous un
autre nom — `session.resync`/`session.synced` (L3-11), déjà exercé par le test de résilience
(L3-14) — et je l'exerce directement : les deux acteurs n'enregistrent jamais de jeton d'appareil
(aucun canal de notification n'existe donc pour eux), le chauffeur ferme puis rouvre sa connexion
après l'acceptation, `session.resync` retrouve la course depuis Odoo, la boucle continue et
aboutit — tous des appels HTTP purs après ce point, indépendants de tout message WebSocket.

**Vérifié à blanc** (même discipline que L3-13/L3-14/D64) : `ProposalLifecycle.accept()`
(`services/realtime/src/proposal/lifecycle.ts`) rendue `return false` immédiate, service
redémarré pour charger le changement (`tsx watch` ne l'a pas détecté seul sur ce volume — redémarrage
manuel du conteneur). Les cinq scénarios échouent alors exactement à l'acceptation, avec un message
distinct et clair par scénario (`état 'proposed' au lieu de 'assigned'`, ou l'erreur
`RIDE_INVALID_TRANSITION` du scénario qui tente de démarrer une course jamais affectée). Restauré,
redémarré : les cinq repassent au vert, deux fois de suite (stabilité).

Fichiers : `test/e2e/full-ride.test.ts`, `test/e2e/helpers/actors.ts`, `test/e2e/fixtures/geo.ts`,
`test/package.json` (glob `e2e/*.test.ts`), `test/tsconfig.json` (inclusion `e2e/**/*.ts`),
`amoa/questions/L10-01.md`.

`npx tsx --test test/e2e/full-ride.test.ts` : 5/5, deux exécutions consécutives. `tsc --noEmit`
(espace `test/`) : propre.
