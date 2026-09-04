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

**Mise à jour J43 (4 septembre, D68) : `make reset` poussé jusqu'au bout cette fois — volume
Postgres réellement vidé, pas seulement les conteneurs relevés — et ça a changé la réponse à deux
questions ouvertes.** D'abord, une base ancienne (montée depuis plusieurs heures, jamais
réinitialisée) faisait échouer `TestRemittanceAccounting::
test_two_successive_partial_remittances_never_leave_the_receivable_in_a_credit_balance` de façon
parfaitement reproductible (45850,0 au lieu de 45000) — confirmé identique sur `master` avant tout
changement de la nuit. **Sur la base vraiment fraîche, ce test passe**, avec les 818 autres (0
échec, 0 erreur, `amoa/rapport-nuit-J43.md` §3) : encore un artefact de base accumulée, comme
`code/docs/odoo-pitfalls.md` le documente déjà dans l'autre sens (des tests verts qui cachent un
défaut). Ensuite, un volume Postgres vraiment vide fait réinstaller — et retester — tous les
modules Odoo dont `babana` dépend (`account`, `mail`, `hr`...) au premier `-i babana
--test-enable` : des milliers de tests amont, sans rapport avec ce dépôt, pour un temps
d'exécution que je ne crois pas que les nuits précédentes aient jamais payé (leurs comptes de
« 806 tests » ne collent qu'à la suite `babana` seule). Contourné en installant d'abord sans
`--test-enable`, puis en testant sur le module déjà installé — voir le rapport J43 pour le détail.
Aucune des deux découvertes n'est un défaut du dépôt ; les deux valent d'être sues avant le
prochain `make reset` complet.

Quatre tests instables rencontrés en six nuits, comme demandé :

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
4. **`test/concurrency/ride-transitions.test.ts::scénario 1`** (acceptation concurrente, 20
   itérations x 8 appels). Échoué une fois le 4 septembre (nuit J44) dans la chaîne continue de
   `npm test` — « chauffeur jamais apparu dans nearby.drivers après 20000ms » — suivi d'un silence
   de seize minutes dans le journal, processus à 0 % CPU et sans connexion réseau ouverte au
   moment de l'observation (`amoa/rapport-nuit-J44.md` §3). Processus arrêté, chaque fichier
   suivant rejoué séparément sur l'environnement resté debout, sans `make reset` entre-temps :
   tous verts, y compris `ride-transitions.test.ts` rejoué seul, ses trois scénarios compris. Pas
   de contention entre deux exécutions de ma part cette fois (une seule instance de `node --test`,
   vérifiée par `ps` — contrairement au motif que J42 avait diagnostiqué le 3 septembre). Cause du
   silence de seize minutes non élucidée : fuite de connexion ou verrou orphelin côté Redis
   restent aussi plausibles qu'un artefact de mise en tampon du flux `tee`. Si ce figement revient
   un soir où il peut être observé en train de se produire, mesurer l'état Redis à ce moment-là,
   pas après coup.

   **Élucidé et corrigé la nuit J45 (D70, `amoa/01-architecture.md` §9 duodecies).** Le
   recoupement de cette occurrence avec celles du 15 et du 19 septembre (même message, même
   silence) a révélé un seul mécanisme, reproduit en direct deux fois le 4 septembre en rejouant
   `npm test` (les six fichiers ensemble, pas un fichier isolé — la condition qui manquait) :
   `concurrency/select-driver-replay.test.ts` appelait `waitForDriverVisible` — l'appel qui produit
   exactement ce message — AVANT le `try`/`finally` qui ferme les deux connexions WebSocket
   chauffeur ouvertes juste avant. Un rejet (le symptôme lui-même) sautait donc ce nettoyage : deux
   connexions `ESTABLISHED` restaient ouvertes, référencées par personne, et un `net.Socket` réf'd
   ne laisse jamais un processus Node sortir de lui-même — d'où le silence, mesuré 8 min 36 s durant
   pendant qu'il se produisait (0 % CPU, connexions toujours établies, aucune erreur côté service).
   Aucun défaut dans `services/realtime` : le figement vivait entièrement dans l'outillage de test.
   Corrigé en étendant le `try` existant pour englober l'appel qui pouvait le faire échouer ;
   vérifié à blanc (rejet forcé, sortie propre en 6,5 s contre un figement non résorbé sur le code
   d'avant). Voir `amoa/rapport-nuit-J45.md` pour le détail complet, y compris ce qui reste
   ouvert (un `fetch()` sans délai dans `services/realtime/src/odoo/client.ts::callOdoo`, repéré
   mais non corrigé faute de preuve qu'il se soit manifesté cette nuit).

   **Fermé la nuit J46 (D71, `amoa/01-architecture.md` §9 terdecies).** La revue de J45 a établi
   que cette dissymétrie n'était pas une précaution spéculative mais une inconsistance avec une
   hypothèse posée partout ailleurs dans le dépôt : tout appel sortant du service porte un délai,
   sauf les deux seuls qui transportent le travail réel (`callOdoo` ET `callOdooOnce`, ce dernier
   trouvé en creusant, pas nommé par J45 — voir `amoa/rapport-nuit-J46.md` §1). Sans délai, un Odoo
   qui se tait n'atteint jamais ni le réessai en mémoire de `callOdoo`, ni la file persistante
   (`odoo/outbox.ts`, L3-12) derrière `callOdooOnce` : le même motif que le défaut de test de J45,
   une couche plus bas, cette fois dans le service. Les deux portent maintenant
   `ODOO_CALL_TIMEOUT_MS` (5000 ms, paramétrable, même valeur que `REALTIME_TIMEOUT_SECONDS` côté
   Odoo pour le sens inverse de cet appel). Vérifié contre un faux Odoo qui accepte la connexion et
   ne répond jamais (pas un Odoo qui refuse vite, déjà couvert) : échec, entrée remise en file,
   rejeu qui aboutit tout seul au retour d'Odoo -- chemin jamais exercé avant cette nuit, L3-14
   ne prouvant que le redémarrage, jamais le silence.

   **Le dépassement lui-même (pas le silence qui suivait) s'est reproduit cette même nuit, deux
   fois, plus largement que par le passé** -- 1 échec dans `make test`, puis 4 dans un second
   passage de la même commande, tous avec le message exact catalogué, sur trois fichiers
   indépendants (`concurrency/select-driver-replay`, `e2e/full-ride`,
   `http-contract/endpoint-coverage`). Aucun figement dans les deux cas -- la correction de J45
   tient. D71 écarté comme cause en lisant le code, pas supposé : le seul chemin par lequel
   `ODOO_CALL_TIMEOUT_MS` touche `nearby.drivers` (le profil chauffeur en cache, `callOdoo`) dégrade
   sur échec (champs à `null`), il n'exclut jamais un chauffeur du résultat (D30,
   `nearby/projection.ts`). Élément nouveau, jamais relevé avant ce soir : cette machine fait
   tourner une pile Docker sans rapport avec ce dépôt (`n8n`) en plus de deux passages lourds
   consécutifs -- observation, pas cause prouvée. Toujours sans théorie sur ce que le dépassement
   mesure ; voir `amoa/rapport-nuit-J46.md` §4 pour le détail.

   **Cause racine trouvée et corrigée la nuit J47 (D73, `amoa/01-architecture.md` §9
   quindecies).** Reproduit du premier coup en rejouant `npm test` en boucle contre la pile
   réelle, puis mesuré PENDANT (pas après) par une instrumentation temporaire du service réel
   (`redis/geo-index.ts::findNearby`, `tracking/ingest.ts::ingestOne`, retirée une fois la cause
   confirmée) : le chauffeur visé était bien entré dans le pool, jamais expiré, présent dans
   chaque liste de candidats bruts pendant toute la fenêtre d'attente -- mais systématiquement en
   6e ou 7e position, jamais dans les 5 retenues (D14). Cause : quatre fichiers de test
   indépendants (`concurrency/ride-transitions`, `concurrency/select-driver-replay`,
   `http-contract/endpoint-coverage`, `e2e/full-ride`) amenaient chacun un chauffeur réel au même
   point exact (4.05, 9.70), sans coordination entre eux -- et `node --test` les exécute en
   processus concurrents (vérifié, pas supposé). À distance rigoureusement identique, Redis
   départage les scores égaux par ordre lexicographique de l'identifiant, jamais par ordre
   d'arrivée : jusqu'à 7 chauffeurs réellement en ligne au même point, mesuré, dont 2
   systématiquement exclus. Ni un défaut du géo-index ni de la diffusion -- les deux se comportent
   exactement comme spécifiés -- une collision de jeux de données entre suites conçues
   indépendamment, invisible tant qu'on isole un fichier pour vérifier. Corrigé en donnant à trois
   des quatre fichiers un point distinct, séparé de plus de 12 km (au-delà du rayon que ces
   fichiers utilisent) ; vérifié sans effet sur le tarif ou le trajet (mock de routage dérivé de
   la seule distance, zone tarifaire unique) avant de choisir les nouvelles coordonnées. Vérifié à
   blanc, deux fois, par la commande réelle : 54/54 tests verts les deux fois. Voir
   `amoa/rapport-nuit-J47.md` pour le détail complet.

   Cette clôture ferme la seule entrée encore ouverte des quatre tests instables listés ci-dessus
   -- les trois autres (1, 2, 3) restent corrigées et non revues depuis.

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
  **Mise à jour J46 (D71)** : le mécanisme de prise de relais lui-même -- Odoo silencieux plutôt
  qu'à l'arrêt -- est désormais exercé de bout en bout par un test dédié (`test/outbox.test.ts`,
  contre un faux Odoo qui ne répond jamais), une première ; la latence sous charge réelle avec de
  vrais volumes, elle, reste dans cette liste, inchangée.
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

**Fermé la nuit d'après (J43, D68) : le silence que composaient les critères 2 et 3 de L8-09 a
maintenant un signal, posé hors de `babana.audit.log` (`ir.config_parameter`), visible sur un
écran back-office dédié (« État du journal d'audit », à côté de « Journal d'audit », réservé aux
administrateurs) sans jamais ouvrir un fichier de logs. Voir `amoa/rapport-nuit-J43.md` §1 pour le
détail.

**Et en le construisant, un vrai trou du L8-09 de la veille est apparu, pas seulement un trou
hypothétique** : `GET /api/v1/driver/documents/<id>/url` (`_signed_url`, le seul événement de la
spécification sans transition) écrivait dans le journal d'audit depuis une route restée
`readonly=True` — une écriture qui échouait donc silencieusement à **chaque appel réel** depuis sa
création, absorbée par le savepoint censé protéger l'opération métier (critère 3, exactement ce
qui rend ce genre de silence possible). Corrigé (`readonly=False`), prouvé par un test qui passe
par la vraie route HTTP plutôt que par le chemin back-office que le test de critère 1 exerçait
jusqu'ici. Voir `amoa/rapport-nuit-J43.md` §2. **La leçon vaut d'être généralisée** : toute future
tâche qui ajoute une écriture dans le corps d'une route `auth='none'` existante doit relire son
`readonly` déclaré — la règle de `code/docs/odoo-pitfalls.md` protège une route écrite dès le
départ, pas une route dont le corps change plus tard.

**Corrigé une deuxième fois cette même nuit-là (toujours J43) : la première vérification visuelle
s'était trompée.** Une tentative initiale, écran blanc, avait conclu à un accident d'environnement
sans rapport avec le dépôt et laissé le point 9 ouvert — conclusion écrite trop tôt. En insistant :
l'écran était en réalité bloqué par une vraie `AccessError`, restée invisible un moment, révélant
que **`base.user_admin` n'a jamais été ajouté à `babana.group_babana_admin` nulle part dans ce
module** — sur une base réellement vidée par `make reset` (une première dans ce projet, semble-t-il :
les nuits précédentes n'avaient probablement jamais traversé un volume Postgres vraiment vide en
une seule séquence), le compte administrateur standard ne voit donc AUCUN écran Babana tant que
personne ne l'ajoute à la main à un groupe — un geste que ni le module ni la documentation de
passation n'ont jamais mentionné. `_post_init_admin_password` (D43, `__init__.py`) pose maintenant
ce groupe en plus du mot de passe. Une fois l'accès rétabli, un second défaut est apparu, plus
ancien : les boutons du `<footer>` de `babana_audit_log_health_view_form` ne s'affichaient nulle
part — un `<footer>` n'est rendu par le client Odoo 18 qu'en `target="new"` (boîte de dialogue),
jamais en `target="current"` (plein écran). **`babana_cash_dashboard_view_form` (L9-05) porte
exactement le même défaut**, plus ancien, jamais remarqué malgré plusieurs rapports le décrivant
comme « ouvert et vérifié » — nommé, corrigé seulement pour l'écran de cette nuit (boutons déplacés
en `<header>`), laissé pour une tâche dédiée. Les trois états de l'écran (vert, rouge après une
vraie panne provoquée, retour au vert après « Marquer comme vu ») ont ensuite été vérifiés pour de
vrai, dans le navigateur. Voir `amoa/rapport-nuit-J43.md` §4 et §5 — §5 nomme explicitement la
leçon : une page blanche sans message d'erreur visible n'est pas la preuve d'un accident
d'environnement, seulement la preuve qu'on n'a pas encore trouvé où regarder.

**Les deux points laissés par J43 fermés la nuit suivante (J44).** D69 : les deux tests comptables
du lot L5 qui sommaient tout le compte de créance au lieu de leur propre scénario
(`amoa/01-architecture.md` §9 undecies) sont corrigés, et vérifiés capables d'échouer si la règle
casse — pas seulement de passer. Balayage des quatre lots sensibles : rien d'autre trouvé du même
motif. Et `babana_cash_dashboard_view_form` (L9-05), nommé par J43 comme portant exactement le même
défaut de `<footer>` que l'écran corrigé cette nuit-là, a reçu le même correctif — ouvert et cliqué
pour de vrai, avant et après un `make reset` complet, sur des valeurs réelles. Voir
`amoa/rapport-nuit-J44.md`. **Aucun des deux écrans du module ne porte plus ce défaut** : les
quatre autres vues n'ont pas de `<footer>` (le simulateur tarifaire et le formulaire de décision
chauffeur s'ouvrent en boîte de dialogue, où le patron reste correct).

**Nouveauté de cette nuit-là, sans rapport avec D69 ni L9-05** : une quatrième occurrence du motif
« test instable, jamais retrouvé », cette fois sur `test/concurrency/ride-transitions.test.ts`,
avec un symptôme plus inquiétant que les trois précédents — un silence de seize minutes dans le
journal après l'échec, processus apparemment figé. Rejoué isolément, tout repasse au vert, cause du
figement non élucidée. Voir §3 de `amoa/rapport-nuit-J44.md` et l'entrée 4 de la liste des tests
instables ci-dessus.
