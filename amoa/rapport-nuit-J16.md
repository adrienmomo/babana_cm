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

## L6-09 — non commencée cette nuit, le lot s'arrête à L3-08

Prévenu en tête de nuit : « si le lot ne passe pas en entier, arrête-toi après L3-08 et dis-le. »
Je m'arrête ici, et voici précisément ce qui manque pour que L6-09 se fasse sans hypothèse posée
à côté d'une vérité qui n'existe pas encore.

**L3-09 (diffusion du suivi) n'existe pas du tout ce soir.** Vérifié par lecture de
`services/realtime/src/ws/dispatch.ts` : `ride.start`, `ride.complete` et `ride.track` sont dans
la liste des types encore ignorés silencieusement (commentaire de tête du fichier, jamais mis à
jour depuis). Aucun `tracking/broadcast.ts` n'existe, aucun message `driver.position` n'est jamais
émis en dehors de son schéma. Ce n'est pas un détail manquant à côté de L6-09 : c'est tout ce que
`TrackingScreen` afficherait qui n'a nulle part où le lire.

**Deux lacunes de contrat, trouvées en lisant avant d'écrire, qui dépassent le périmètre d'un
seul écran :**

1. **L'immatriculation et la gamme de la moto** (critère 1 de L6-09) ne sont nulle part
   accessibles au client une fois un chauffeur affecté. `ride.assigned` (C-02) ne porte que
   `{ rideId, driverId }`. La gamme existe déjà dans `DriverProfile` (L3-16) mais **la liste
   blanche de champs de l'endpoint interne exclut explicitement l'immatriculation** — c'est un
   champ qui n'a jamais été jugé sûr à exposer avant l'affectation (C2b, la flotte est
   publiquement observable avant qu'un client n'ait choisi). Une fois affecté, la règle change :
   le client A choisi ce chauffeur, l'immatriculation cesse d'être une donnée à protéger contre le
   balayage. Il faut donc soit enrichir `ride.assigned`, soit un nouvel endpoint/message dédié à
   l'affectation — une décision de contrat, pas un choix d'écran.
2. **Le détail décomposé et la notation** (critères 4 et 5) ne sont pas dans `ride.completed`
   (`{ rideId, distanceMeters, durationSeconds, amount }`, sans `breakdown`). Le résumé de fin
   « doit correspondre exactement à ce qui est écrit côté serveur » (consigne de ce soir) : cela
   suppose une lecture de la course consolidée depuis Odoo (comme `GET /rides/{id}` ou l'ajout du
   détail à `ride.completed`), pas encore spécifiée dans C-01/C-02.

**Ce qui manque encore, hors contrat :** L8-03 (partage de trajet) et L8-04 (bouton d'urgence)
n'existent pas non plus (`amoa/specs/L8-securite.md`) ; le critère 2 de L6-09 les suppose
atteignables « en un geste ». Sans eux, l'écran de suivi ne peut honnêtement offrir qu'un bouton
qui ne fait rien, ou son omission pure et simple — aucune des deux ne satisfait le critère tel
qu'écrit.

**Pourquoi je n'ai pas contourné avec une hypothèse.** Deviner la forme de `ride.assigned` enrichi,
inventer un endpoint de détail de course, ou stubber le partage/urgence par des boutons inertes
reproduirait exactement le défaut du 15 août (une forme inventée à côté d'une vérité qui aurait
pu être écrite proprement une nuit plus tard) — sauf qu'ici il n'y a même pas de vérité existante
à côté de laquelle se tromper, seulement une absence. Le protocole d'écart demande de signaler
avant de contourner ; je signale plutôt que d'improviser un contrat pour tenir un délai.

**Pour la prochaine session, avant même de reprendre l'ordre naturel : voir §« Vérification
navigateur » et surtout §« Le défaut le plus important de la nuit » ci-dessous.** La vérification
D38, faite ce soir sur ce qui existait déjà (L6-06/L6-07/L6-08), a trouvé quelque chose qui change
la priorité de la nuit suivante.

**Pour la prochaine session : l'ordre naturel.** (1) Décider et écrire l'extension de contrat
(immatriculation/gamme sur affectation, détail décomposé sur complétion) — une tâche de
spécification, courte, qui débloque le reste. (2) L3-09 : `ride.start`/`ride.complete` posent et
lèvent l'abonnement de suivi, `ride.track` l'ouvre côté client, `driver.position` diffuse à
fréquence découplée de l'ingestion, en précision réelle (pas l'arrondi de L3-05), avec l'ETA
recalculé (facteur de correction non calibré, É8/L10-03 — pas de fausse précision). Vérifier à
chaque diffusion, pas seulement à l'abonnement, qu'un client suit bien une course qui est la
sienne (spécification, critère 2). (3) `TrackingScreen`/`RideSummaryScreen`, avec l'état de
connexion explicite (horodatage de la dernière position connue) et le partage/urgence
conditionnés à l'existence de L8-03/L8-04 -- ou honnêtement absents si ces tâches ne sont pas
encore faites, jamais des boutons inertes.

---

## Vérification navigateur (D38) — sur ce qui existait déjà, home → estimation → sélection

Demandée explicitement pour ce soir, sur le parcours complet. Faite contre la vraie pile
(`make up`, base fraîche après la passe finale ci-dessous), avec un vrai chauffeur approuvé et mis
en ligne par le chemin réel (WebSocket, `availability.set` puis `position.update`), un vrai jeton
via `mock-google-identity` + `/auth/google`, et un petit serveur de vérification jetable (pas dans
le dépôt) servant `dist-web` et relayant `/api`/`/auth`/`/rt/ws` vers Odoo et le service temps réel
sur la même origine -- exactement le montage que Caddy fournira en vrai (L6-18), pour ne pas buter
sur le mur CORS déjà rencontré et documenté la nuit dernière (rapport J15, L6-00R).

**Deux défauts trouvés en ouvrant `QuoteScreen`, un troisième plus grave derrière.**

### 1. `QuoteScreen` ne s'affichait pas, alors que tout son contenu existait dans le DOM

**Corrigé, commité.** `public/index.html` ne donne aucune hauteur à `html`/`body`/`#root`. Sans
effet visible sur `HomeScreen` (son contenu s'empile sans avoir besoin d'une hauteur d'ancêtre),
mais `QuoteScreen` utilise un `ScrollView` -- react-native-web l'implémente par un conteneur
`overflow-y: auto; flex: 1`, qui hérite 0% de hauteur en cascade jusqu'à `#root`. Résultat : le
texte existait bel et bien dans le DOM (`get_page_text` le lisait, `getBoundingClientRect` donnait
des tailles cohérentes plus bas dans l'arbre), **mais rien n'était peint à l'écran** -- une capture
d'écran montrait une page blanche. Même famille de défaut que L6-00R (« un bundle qui compile mais
n'affiche jamais rien »), ici circonscrit à un seul écran plutôt qu'à l'app entière, et découvert
pour la même raison : personne n'avait ouvert *cet* écran précis dans un vrai navigateur avant ce
soir, l'ancien correctif de L6-00R n'ayant vérifié que `HomeScreen`.

Corrigé par une hauteur explicite (`100vh`, pas `100%` -- `100%` cascade depuis un ancêtre déjà à
zéro, `100vh` ancre directement sur le viewport) et un chaînage flex explicite jusqu'au premier
conteneur applicatif. Vérifié : `QuoteScreen` s'affiche intégralement (montant, détail décomposé,
carte chauffeur) après correctif ; `HomeScreen` inchangé.

**Fichier.** `apps/client/public/index.html`. Aucun test automatisé -- même raison que L6-00R,
`webpack.config.js`/`public/index.html` n'en ont pas et l'écran est déjà couvert par les suites
Jest de L6-07 pour son contenu ; la preuve ici est le navigateur lui-même.

### 2. Le vrai défaut : le contrat de date rejette les dates qu'Odoo produit réellement

**Non corrigé -- consigné, c'est le plus important à traiter demain.**
`amoa/questions/C-01.md` documente la reproduction complète et l'analyse ; résumé ici.

En sélectionnant le chauffeur (le vrai geste de commande), l'estimation avait bien réussi
(`POST /quote`, 200) et la création de la course aussi (`POST /rides`, 201, une vraie
`babana.ride` en base) -- **mais l'app affichait « Une erreur inattendue s'est produite »**,
jamais l'écran d'attente. Un chauffeur reste alors bloqué hors du pool par une réservation qui
n'aura jamais lieu que le client ne verra jamais confirmée.

**Cause.** `IsoDateTimeSchema` (`packages/contracts/src/http/common.ts`) est
`z.string().datetime({ offset: true })` -- exige un suffixe `Z` ou un décalage horaire. Odoo
sérialise ses `fields.Datetime` en ISO **sans aucun fuseau** (`"2026-08-22T06:38:44.673009"`,
vérifié avec le vrai `zod` du dépôt : `datetime({offset:true}).safeParse(...)` échoue sur cette
chaîne précise). **Chaque réponse qui porte un champ date -- `createdAt` sur `POST /rides`, et
par construction `expiresAt`/`proposalExpiresAt` ailleurs -- échoue donc sa propre validation de
schéma côté client**, alors que l'appel HTTP a réussi et que l'écriture a eu lieu.

**Pourquoi aucune suite existante ne l'a vu.** Vérifié par lecture, pas supposé : les tests Jest
des écrans (`QuoteScreen.test.tsx`, etc.) simulent `apiClient.request` entièrement --
`jest.mock('../../auth', ...)` -- et ne passent donc jamais par `createHttpClient` ni par
`endpoint.responseSchema.parse`. Les scénarios de bout en bout (`test/concurrency/*`,
`odoo-session.ts`) parlent en `fetch` brut, pas par `@babana/api-client`, et ne valident donc
aucun schéma de réponse non plus. **Aucune suite du dépôt n'a jamais exercé le chemin réel --
vrai Odoo, vrai `@babana/api-client`, vraie validation de schéma -- en même temps**, jusqu'à ce
qu'un vrai navigateur, ce soir, le fasse. C'est exactement le défaut que le critère 5 de C-01
existe pour attraper (« un test de bout en bout... aucune suite propre à un service ne peut le
remplacer ») -- sauf que ce critère couvre l'authentification WebSocket, pas les écritures REST.

**Un second défaut amplifie le premier, découvert en creusant la même trace.**
`packages/api-client/src/http/client.ts::request()` classe comme réessayable **toute** erreur qui
n'est pas une `ApiError` (`error instanceof ApiError ? isRetryableStatus(...) : true`) -- un choix
correct pour une vraie erreur réseau (`fetch` qui lève avant toute réponse), mais une `ZodError`
levée par `responseSchema.parse(payload)` **après un succès HTTP réel** tombe dans la même
branche. Le client rejoue alors un `POST /rides` déjà réussi, avec la **même**
`Idempotency-Key` (correct, l'intention y est) -- mais le rejeu échoue côté Odoo avec un 500
plutôt que de renvoyer la réponse mise en cache : signe d'un défaut de rejeu par idempotence côté
Odoo lui-même, jamais exercé jusqu'ici pour la même raison (aucune suite ne rejoue une écriture
déjà réussie par ce chemin précis). Observé en direct : 1 création réussie (`201`), puis plusieurs
rejeux identiques en échec (`500`), jusqu'à épuisement des tentatives -- le client final ne voit
que l'échec.

**Pourquoi je ne corrige pas cette nuit.** Trois défauts empilés, chacun dans un fichier différent
(`packages/contracts`, `packages/api-client`, un contrôleur Odoo à identifier), touchant un
mécanisme partagé par **tous** les endpoints d'écriture -- exactement le genre de correctif qui
mérite une tête reposée et une revue, pas une réparation hâtive à l'heure qu'il est sur un chemin
qui touche l'idempotence des écritures (liste de validation humaine, `CLAUDE.md`). Écrit dans
`amoa/questions/C-01.md` avec la reproduction exacte, pour que la prochaine session commence par
là plutôt que par L6-09.

**Ce que ça change pour demain matin.** La commande décrite dans les attentes de ce soir
(« commander, être refusé... ») **échoue aujourd'hui dès le premier geste de commande**, sur la
vraie pile, pas seulement dans l'export web -- ce chemin (`POST /rides` avec un token réel) est le
même pour l'app native. Je n'ai pas pu vérifier plus loin ce soir (refus, réaffichage, sélection
suivante) : le blocage est en amont de tout ce que L3-08 ajoute. **Priorité absolue de la
prochaine session, avant L6-09 et avant tout le reste.**

---

