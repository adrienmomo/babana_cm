# Rapport de nuit — J16

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-24.md` lu en entier avant d'ouvrir quoi que ce
soit. Périmètre : les trois correctifs (L6-07, C-02 lecture des trames, le flake), puis L3-08 et
L6-09.

---

## Le flake — sérialisation de `services/realtime`

Quatre fichiers touchés par le même défaut depuis J12 (`DisconnectGraceTimers`,
`availability.test.ts`), J14 (`proposal.test.ts` critère 1, `reservation.test.ts` critère 5) et
J15 (`nearby.test.ts`, timer de diffusion) : tous des tests qui mesurent du temps réellement
écoulé (délai d'acceptation, expiration de réservation, période de grâce, intervalle de
diffusion), et le test-runner de Node exécute les fichiers passés sur la ligne de commande en
parallèle par défaut. Sous charge combinée (toute la suite du paquet, plus les autres paquets en
tâche de fond), la concurrence entre processus retarde suffisamment un `setTimeout` pour que la
fenêtre temporelle du test ne corresponde plus à ce qu'il attend. Chaque fichier isolé était et
reste vert — c'est la concurrence *entre* fichiers qui fautait, jamais leur contenu.

**Corrigé par `--test-concurrency=1`** sur la commande de test de `services/realtime/package.json`,
plutôt que d'allonger les délais des quatre fichiers : allonger masquerait le symptôme sans
changer la cause, et le prochain fichier de minuteur ajouté au paquet referait le même flake avec
une marge simplement plus confortable. Sérialiser l'exécution des fichiers retire la cause
elle-même — les tests ne se disputent plus le processeur entre eux. Le coût est une suite un peu
plus longue (~16,6 s contre une exécution parallèle plus rapide mais instable) ; c'est le bon
compromis pour une suite qui doit rester bloquante en continu (CLAUDE.md, « un test instable est
traité comme un défaut, pas toléré »).

**Vérifié** : suite complète de `services/realtime` (119 tests) exécutée deux fois de suite contre
Redis réel, 0 échec les deux fois — la vérification demandée par le piège de L3-13 appliquée ici
par analogie (« à vérifier plusieurs fois, sinon ça ne prouve rien »).

**Fichier.** `services/realtime/package.json` (un seul : la cause était unique, la sérialisation du
paquet la couvre entièrement, pas seulement les quatre fichiers historiquement touchés).

---

## C-02 — vérification de la règle de lecture des trames

Recherche exhaustive de tout lecteur qui prendrait « la trame suivante » plutôt que de filtrer par
type, des deux côtés du protocole :

- **TypeScript** (`services/realtime/test/*.test.ts`, `packages/api-client/src`, `apps/client/src`,
  `apps/driver/src`) : tous les accès `messages[0]` restants sont précédés d'une assertion sur la
  longueur ou le contenu exact du tableau (`assert.equal(messages.length, 1)`,
  `assert.deepEqual(messageTypes, ['un-seul-type'])`) — ce n'est pas supposer que la position 0
  contient tel type, c'est avoir déjà prouvé que c'est tout ce que le tableau contient. Les listes
  de chauffeurs de `nearby.test.ts` passent par `driverListMessages`/`ackMessages`, qui filtrent
  par type. `packages/api-client` lit par `onmessage` et distribue par type de message (pas de
  lecture positionnelle). Rien à corriger.
- **Python** (`services/odoo/addons/babana/tests/`) : `_realtime_ws.py` est le seul fichier du
  dépôt qui parle WebSocket brut ; `make_driver_visible_to_client` a déjà été corrigé cette nuit-là
  (commit `26e97b8`) pour boucler jusqu'à `nearby.drivers` plutôt que de s'arrêter à la première
  trame. Aucun autre appelant Python de `nearby.subscribe`.
- **`test/concurrency/helpers/realtime.ts`** (racine du monorepo, utilisé par L3-17/L4-11) :
  `waitForDriverVisible` filtrait déjà par type avant cette nuit — jamais affecté, confirmé par
  lecture.

Aucune seconde occurrence trouvée. La règle C-02 (« un lecteur ne suppose jamais que la trame
suivante est celle qu'il attend ») est respectée partout où le protocole est consommé. Aucun
fichier de code modifié — entrée de vérification pure.

---

## L6-07R — l'abonnement `nearby.drivers` reste actif sur l'écran d'estimation

Arbitrage du 24 août (`amoa/questions/REPONSES-2026-08-24.md` §4) : `QuoteScreen` recevait un
cliché figé de chauffeurs proches depuis `HomeScreen`, par paramètre de navigation. Correct et sûr
— une sélection sur un chauffeur devenu indisponible produit `DRIVER_ALREADY_TAKEN`, le serveur
reste l'arbitre —, mais l'écran ne dit rien avant que le client touche une carte, précisément
l'écran où il prend son temps pour comparer.

**Corrigé en donnant à `QuoteScreen` son propre abonnement `nearby.subscribe`**, même mécanisme
que `HomeScreen` (L3-05) : `ensureRealtimeConnected()`, envoi de l'abonnement au montage sur le
point de départ, réémission à chaque reconnexion (coupure réseau, le cas courant), et
désabonnement au démontage. Le cliché transmis par `HomeScreen` sert uniquement de première
peinture (`useState(initialNearbyDrivers)`), remplacé par le premier message `nearby.drivers` reçu
et par chaque suivant. Un chauffeur retiré du pool (réservé par un autre client, passé hors ligne)
disparaît donc de la liste avant que quiconque ne le touche — pas de dérivation locale, l'app
affiche ce que le serveur diffuse (règle transverse du lot L6).

**Pourquoi ne pas partager l'abonnement de `HomeScreen`** plutôt que d'en ouvrir un second : les
deux écrans peuvent coexister montés (`native-stack` ne démonte pas l'écran précédent), et faire
dépendre `QuoteScreen` de la durée de vie de l'effet de `HomeScreen` couplerait deux écrans qui ne
se connaissent pas aujourd'hui. Les deux abonnements portent la même position (le départ choisi
avant l'estimation) : le serveur n'en retient qu'un par client (L3-05, critère 5, « un second
abonnement du même client remplace le premier »), sans changer le résultat reçu par l'un ou
l'autre — la diffusion est reçue par tous les auditeurs de la connexion partagée
(`onRealtimeMessage`), quel que soit celui qui a émis la dernière demande.

**Vérification.** `@babana/client` : 4 tests nouveaux (abonnement au montage sur le point de
départ, disparition d'un chauffeur pris pendant la comparaison avant toute sélection, réémission à
la reconnexion, désabonnement à la sortie de l'écran) plus les 11 déjà verts, tous passent (15/15,
`QuoteScreen.test.tsx`). Suite complète `@babana/client` : 68 tests, 0 échec. `tsc --noEmit` et
`eslint` propres.

**Fichiers.** `apps/client/src/screens/QuoteScreen.tsx`, son test.

---

## L3-08 — élargissement du rayon

**Déclenchement retenu : `excludeDriverIds` non vide, pas « rayon initial vide » à lui seul.**
Doute consigné dans `amoa/questions/L3-08.md` — la seconde branche du déclenchement de la
spécification (« ou aucun chauffeur n'est disponible dans le rayon initial ») entrerait en
conflit avec le garde-fou anti-balayage de L3-05 (C2b, critère 1, déjà testé) si elle s'appliquait
à un abonnement de simple découverte : un client se trouvant dans une zone sans chauffeur
obtiendrait alors un rayon effectif plus grand que celui configuré, exactement ce que le garde-fou
interdit. Constaté concrètement : la première implémentation faisait échouer immédiatement le
test déjà vert de L3-05 (« un rayon demandé supérieur au plafond est ramené au plafond »), pour
cette raison précise. `excludeDriverIds` non vide est le seul signal disponible dans la charge
utile qui distingue une découverte libre (`HomeScreen`, jamais de refusant) d'une resélection
après refus (`QuoteScreen`, après un `ride.rejected`) — c'est cette distinction que je retiens.

**Mécanique.** `nearby/expand.ts` (nouveau) : sur-échantillonne à chaque palier de la taille de
l'exclusion, essaie le rayon demandé puis des paliers croissants configurables
(`NEARBY_EXPAND_RADIUS_STEP_METERS`, défaut 2 km) jusqu'à un plafond
(`NEARBY_EXPAND_MAX_RADIUS_METERS`, défaut 15 km, vérifié strictement supérieur à
`NEARBY_MAX_RADIUS_METERS` par un `.refine` du schéma de configuration -- sinon l'élargissement
n'élargirait jamais rien). `nearby/handler.ts` route désormais chaque `push()` par cette fonction ;
le résultat vide après épuisement des paliers **est** le `NO_DRIVER_AVAILABLE` de la spécification
-- pas de message distinct : `nearby.drivers` avec une liste vide est déjà traité comme tel côté
app (L6-08, testID `no-driver-available`).

**Le contrat gagne un champ.** `NearbySubscribePayloadSchema` porte désormais
`excludeDriverIds` (défaut `[]`). Pas une règle métier ajoutée à l'app : le client rappelle
seulement les identifiants qu'un `ride.rejected` précédent lui a déjà appris (L6-08) ; c'est le
serveur qui décide de l'exclusion et de l'élargissement. `QuoteScreen` transmet
`excludedDriverIds` (route param) à chaque `nearby.subscribe` ; `HomeScreen` transmet toujours
`[]` (aucune course, jamais de refusant, jamais élargi).

**Métrique (critère 4).** `expansionMetrics` (même patron que `IngestMetrics`, L3-02) compte
élargissements et échecs, globalement et par repère zone/heure. « Zone » est approchée par une
maille de coordonnées grossière (~5 km) faute d'un canal de résolution point → `babana.zone`
depuis ce service (une seule zone existe pour le pilote, `babana_zone_default.xml` -- pas de vrai
découpage à interroger de toute façon ce soir) ; « tranche horaire » est l'heure UTC, faute de
fuseau configuré ailleurs dans le service. Choix d'implémentation non spécifiés, notés ici plutôt
que dans un fichier d'écart séparé -- aucun des deux ne change un comportement visible, seulement
la granularité d'un tableau de bord qui n'existe pas encore.

**Vérification.** `services/realtime` : `test/expand.test.ts` (nouveau, 5 tests -- exclusion sans
élargissement quand le rayon initial suffit, élargissement par palier jusqu'à un candidat, échec
au plafond, comptage par zone/heure, non-régression du garde-fou C2b sur une découverte libre) ;
`test/nearby.test.ts` complété (câblage bout en bout depuis `NearbyManager`, découverte libre vs
resélection à la même origine). Suite complète `services/realtime` : 125 tests, 0 échec, deux
exécutions consécutives. `@babana/client` : 2 tests nouveaux (transmission d'`excludeDriverIds`) ;
suite complète 69 tests, 0 échec. `tsc --noEmit` et `eslint` propres sur tous les paquets touchés
(`contracts`, `realtime`, `api-client`, `client`).

**Fichiers.** `packages/contracts/src/realtime/client-to-server.ts` (+test existant, compatible
via `.default([])`), `docs/contracts/realtime-events.md`, `services/realtime/src/config.ts`,
`services/realtime/src/nearby/expand.ts` (nouveau, +test), `services/realtime/src/nearby/handler.ts`
(+test), `apps/client/src/screens/HomeScreen.tsx`, `apps/client/src/screens/QuoteScreen.tsx`
(+test). `amoa/questions/L3-08.md` (doute sur le déclenchement, ci-dessus).

---
