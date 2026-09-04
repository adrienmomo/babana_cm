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

---

## 3. Passe de clôture — état des lieux pour une reprise dans trois semaines

Les nuits s'arrêtent ici (`amoa/questions/REPONSES-2026-09-17.md` §5). Ce qui suit n'est pas une
documentation : c'est l'état du dépôt tel qu'une session qui reprend, ou la personne qui lance les
premières vraies courses, doit le trouver.

### Ce qui est rouge ou instable

**Mise à jour J42 (4 septembre) : rejoué en premier, comme demandé — les trois échecs
ci-dessous étaient bien environnementaux, confirmé, pas un défaut du dépôt.** Les containers
`mock-google-identity`/`mock-maps` étaient sortis en erreur (`make reset && make up` a suffi).
Une fois relevés, chaque fichier du périmètre `npm test` a tourné propre — Odoo compris (806
tests, 0 échec, la suite L8-09 ajoutée) — voir `amoa/rapport-nuit-J42.md` §1 pour le détail et
une découverte en cours de route : une vérification isolée que j'ai lancée s'est retrouvée à
tourner EN MÊME TEMPS qu'une tentative précédente non éteinte (`node --test` continue les
fichiers suivants après l'échec d'un test, il ne s'arrête pas), et la contention entre les deux
a produit exactement le symptôme des trois échecs de cette nuit (« chauffeur jamais apparu dans
`nearby.drivers` »). Un process en trop tué, tout repasse vert. Cette nuit-là n'avait donc
qu'à moitié tort de soupçonner une machine perturbée — la perturbation venait de l'agent, pas de
l'hôte. **Seule réserve restante** : l'environnement de session de l'agent a mis fin de force à
deux tentatives de `make test` en une seule traversée (au-delà d'une certaine durée, hors de
mon contrôle) — chaque morceau a donc été vérifié séparément plutôt qu'en un unique
`make test` ininterrompu ; voir le rapport J42 pour le détail pièce par pièce.

Trois tests instables rencontrés en cinq nuits, comme demandé :

1. **`test/realtime/reservation.test.ts`** (critère 5, D26 — course au TTL de 1 s). Diagnostiqué
   le 10 août (`d538e46`) : `accumulator.test.ts`, nouveau ce soir-là, écrivait beaucoup sur le
   même DB Redis 0 et faisait perdre la course au TTL environ une fois sur trois sous la suite
   complète. **Corrigé** — `accumulator.test.ts` isolé sur son propre DB Redis. Je le crois réglé
   (mécanisme de contention identifié, pas seulement contourné), mais je ne l'ai pas rejoué cent
   fois pour l'exclure définitivement — la charge d'une machine change, ce genre de course peut
   revenir sous une charge différente de la mienne.
2. **`test_realtime_commit_hook.py`** (Odoo, deux tests suspendus à `time.sleep(1.0)`). Signalé le
   13 septembre, **corrigé** le 14 (`a95adfa`) : remplacé par un fait déterministe (`rollback()`
   vide la file des points d'accroche sans exécuter ses fonctions) plutôt que d'allonger l'attente
   — la bonne réparation, pas un pansement.
3. **`services/realtime/test/nearby.test.ts`** (L3-20, compteur de minuteurs après
   `unsubscribe()`). Vu une fois le 15 septembre, rejoué vert trois fois de suite,
   **jamais reproduit depuis, jamais corrigé**. C'est le seul des trois qui reste un doute ouvert
   — je n'ai pas de théorie sur sa cause, seulement l'observation qu'il n'a plus jamais échoué.
   La détection automatique d'instabilité (L0-09) a été placée hors périmètre pilote le
   15 septembre ; ce choix suppose qu'une seule session travaille sur ce dépôt à la fois, et
   devient faux le jour où ce n'est plus vrai.

### Ce qui est vert mais que personne n'a jamais exercé pour de vrai

- **`bootstrap.sh`** — jamais lancé : il durcit un hôte réel (installe `age`, `rclone`, un
  utilisateur non privilégié) et n'a de sens que sur un VPS, jamais dans ce bac à sable. C'est le
  script qui tourne une fois, au tout premier soir d'un hôte neuf — et c'est justement le moment
  où une surprise reste possible (constaté le 16 septembre : il refusait de tourner avant d'avoir
  ses deux dépendances, jamais vu tant qu'on ne l'exécute pas).
- **`rollback.sh`** — même famille : il annule un déploiement précédent réel, qu'aucune nuit n'a
  jamais produit.
- **FCM** — jamais confronté à un vrai compte Firebase. `PUSH_PROVIDER=fcm` est câblé, déclaré,
  testé contre un mock ; `console` (le journal) est le seul chemin réellement emprunté à ce jour.
- **`probe.sh` / `probe-host.sh`** — jamais surveillé un hôte hébergé ailleurs que sur cette
  machine ; leur seul défaut connu (domaine en dur) a été trouvé en LISANT le script, pas en le
  faisant tourner en conditions réelles.
- **La latence du fil de fond** (file persistante Odoo → temps réel, L3-12) — jamais mesurée sous
  charge réelle. Le test de résilience (L3-14) prouve qu'elle rejoue après un redémarrage ; rien
  ne dit combien de temps elle met à rattraper un vrai retard, avec de vrais volumes.
- **Le relais SMTP réel** — `mailpit` reçoit tout ce que ce dépôt a jamais envoyé. Aucun email n'a
  atteint une vraie boîte, ni traversé un vrai relais avec ses propres limites de débit.
- **`rateRide`, `phoneVerifyStart`/`phoneVerifyConfirm`** — dans le contrat, jamais implémentés
  (`NOT_YET_IMPLEMENTED`, `test/http-contract/endpoint-coverage.test.ts`) — vérifiés vides
  (404), jamais construits.
- **Le test de bout en bout de cette nuit lui-même, sur quatre de ses cinq mécanismes.** La
  vérification à blanc n'a cassé qu'un seul maillon (`ProposalLifecycle.accept()`). Le refus,
  l'annulation, le franchissement du plafond, la remise de caisse et `session.resync` n'ont
  jamais été vus échouer délibérément — seulement vus réussir. Le filet tient sur la confiance
  dans un mécanisme partagé (le dispatcher WebSocket, éprouvé par l'unique cassure), pas sur cinq
  preuves indépendantes.

### Ce que j'ai supposé et qui n'a jamais été vérifié

- Que les cadences de diffusion (5 s pour `nearby.drivers`, la même chose pour `driver.position`)
  tiennent sous la charge d'un vrai pilote — N chauffeurs simultanés, positions à haute fréquence
  — pas seulement contre un ou deux acteurs de test à la fois.
- Que `session.resync`, exercé ce soir sur une coupure de quelques secondes, se comporte pareil
  après une vraie coupure réseau de plusieurs minutes — le cas courant sur le terrain
  (`CLAUDE.md`, « le réseau mobile est intermittent »), jamais reproduit en test.
- Que le découplage volontaire entre deux signaux d'un même état (trouvé ce soir entre
  `is_online` côté Odoo et le pool géo-indexé du service temps réel, pour le chauffeur) n'a pas
  d'autre occurrence ailleurs dans le dépôt, avec le même angle mort qu'aucun test n'aurait
  jamais couvert avant qu'un scénario n'en ait explicitement besoin des deux à la fois.

### Champs-pont encore vivants

D'après `code/docs/bridge-fields.md` — deux, inchangés depuis leur création :

| Champ | Modèle | Remplacé par | Depuis |
|---|---|---|---|
| `rating_avg`, `rating_count` | `babana.driver` | L4-09 | 10 août 2026 |
| `promotion_code` | `babana.ride` | L2-06 | 10 août 2026 |

Ni L4-09 ni L2-06 n'ont été programmées à ce jour — cohérent avec `rateRide` toujours dans
`NOT_YET_IMPLEMENTED` ci-dessus.

### Si je devais prévenir d'une seule chose la personne qui lance les premières vraies courses

**Résolu la nuit suivante (J42, D67) : `babana.audit.log` existe, journalise les huit
transitions de course, chaque mouvement de compte courant, la déclaration et la validation
d'une remise, chaque changement d'état chauffeur et chaque accès à un document chauffeur —
immuable au niveau du modèle (une tentative de modification échoue même pour un administrateur
en `sudo()`), et consultable filtré depuis un écran back-office réservé aux administrateurs. Voir
`amoa/rapport-nuit-J42.md` §2 pour le détail.**

Ce qui reste à prévenir à sa place, du même ordre — quelque chose qui existe en code et en test
mais qu'aucun humain n'a encore vu en situation réelle : la durée de rétention du journal
(`babana.audit_log_retention_days`, repli à 730 jours) est une valeur provisoire, jamais discutée
avec vous, en attendant que L8-10 (hors périmètre pilote) l'affine par catégorie de donnée — et la
vue back-office elle-même n'a été ouverte et filtrée que par moi, sur le jeu de démonstration,
jamais par un vrai superviseur en train d'arbitrer un vrai litige. Le mécanisme est prouvé ; l'outil
n'a pas encore rencontré la main qui doit s'en servir.
