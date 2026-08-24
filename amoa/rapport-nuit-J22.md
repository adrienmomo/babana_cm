# Rapport de nuit — J22

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-30.md` lu en entier avant d'ouvrir quoi que ce
soit. Périmètre confié : L3-20 (le diagnostic d'abord, puis la détection de silence par flux),
puis le lot Chauffeur — L6-11 (bascule en ligne/hors ligne) et L6-12 (réception de proposition).

---

## L3-20 — le diagnostic avant le mécanisme

### L'hypothèse de la nuit précédente était plausible, et fausse

L'écart (`amoa/questions/L3-05-nearby-list-goes-silently-empty.md`) proposait : une exception
avalée dans le rappel périodique, qui l'empêcherait de se réarmer. Vérifié avant d'écrire quoi que
ce soit — et ça ne tient pas. `nearby/handler.ts` utilise `setInterval`, pas un `setTimeout`
récursif : il n'y a rien à réarmer, il continue de sonner tant que personne ne l'annule. Le
callback est en plus protégé par un `.catch()` explicite ; même une exception synchrone dans
`push()` (fonction `async`, donc transformée en rejet de promesse) ne l'aurait jamais arrêté.
L'hypothèse reposait sur un patron (boucle `setTimeout` récursive) que ce code n'a pas.

### La cause réelle : une déclaration d'intérêt périmée, rejouée en course avec la fraîche

`packages/api-client/src/realtime/connection.ts::send()` mettait en file d'attente hors connexion
**tout** message qui n'est pas `position.update` — y compris `nearby.subscribe`,
`nearby.unsubscribe` et `ride.track`, qui ne sont pourtant pas des actions métier mais de simples
déclarations d'intérêt courant, déjà réémises par l'écran lui-même à chaque `connected`
(`onRealtimeConnectionStateChange`, `HomeScreen`/`TrackingScreen`).

Au montage de l'app, `HomeScreen` appelle `subscribe()` **avant** que le socket ne soit ouvert
(`ensureRealtimeConnected()` vient de déclencher `connect()`, encore en vol) : ce premier
`nearby.subscribe`, avec les coordonnées de l'instant (souvent `DOUALA_DEFAULT_CENTER`, `departure`
n'étant pas encore connu), est donc mis en file. Quand `ws.onopen` se déclenche enfin, deux choses
se produisent presque simultanément :

1. `setState('connected')` — synchrone — prévient `HomeScreen`, qui réémet **immédiatement** un
   `nearby.subscribe` **à jour**, envoyé directement sur le socket tout juste ouvert ;
2. `void replayQueue()` — asynchrone — rejoue la file, dont le `nearby.subscribe` **périmé** posé
   à l'étape précédente.

Les deux abonnements atteignent `NearbyManager` pour le même `userId`. Côté serveur,
`this.subscriptions.set(userId, {timer})` n'était posé qu'**après** la résolution de `push()`, sans
aucune notion d'ordre d'appel : **celui qui finissait de répondre en dernier gagnait**, pas
nécessairement celui appelé en dernier. Si la réponse Redis de l'abonnement périmé revenait après
celle de l'abonnement frais, elle écrasait la bonne diffusion en cours d'installation, sans
erreur, sans fermeture, sans rejet — exactement le silence observé le 30 août, quelques secondes
après un abonnement par ailleurs réussi.

Root-causé, pas seulement corrigé à l'aveugle : `services/realtime/test/nearby.test.ts`, nouveau
test "un abonnement plus ancien dont la réponse Redis revient après un plus récent" — engineered
pour forcer cet ordre (l'abonnement "périmé" porte des refusants, empruntant `nearby/expand.ts` et
ses cinq paliers séquentiels, garantis plus lents qu'une découverte libre à un seul aller-retour).
**Rouge sur le code d'avant-correctif** (vérifié en isolant la partie serveur du correctif via
`git stash`), **vert avec le correctif**.

### Le mécanisme, en deux parties

**1. À la source (le déclencheur).** `nearby.subscribe`, `nearby.unsubscribe`, `ride.track` ne
sont plus jamais mis en file (`connection.ts::NEVER_QUEUED_MESSAGE_TYPES`, `queue.ts` — même
principe que `position.update`, critère 4 de L3-11 : « une position obsolète est pire que pas de
position », étendu ici aux déclarations d'intérêt).

**2. Dans le mécanisme lui-même (la classe de défaut).** Même sans la file, deux abonnements pour
le même client peuvent en théorie encore arriver rapprochés (reconnexion + effet React qui
re-déclenche, notamment). `NearbyManager` et `TrackingManager` posent donc chacun un jeton de
fraîcheur **synchrone**, avant tout `await` : l'ORDRE D'APPEL décide qui gagne, jamais l'ordre de
résolution. Une réponse dépassée n'installe plus jamais son propre minuteur — elle se contente de
disparaître, au lieu de rester orpheline pour toujours (aucun code n'aurait pu l'arrêter, faute
d'y avoir encore une référence). `unsubscribe()` invalide symétriquement toute demande encore en
vol. Testé séparément pour `TrackingManager` (dont les deux appels Redis, à coût égal, répondent
toujours en FIFO strict sur la même connexion — l'ordre d'appel = l'ordre de résolution, donc la
course ne peut pas se reproduire par ce biais ; le scénario déterministe retenu est une
désinscription reçue pendant qu'un `subscribe()` est encore en vol, rouge sans le correctif, vert
avec).

**Et le risque nommé dans l'écart était réel** : `TrackingManager::subscribe` portait exactement
le même défaut. `driver.position` n'a jamais été observé se figer ce soir, mais rien ne garantit
qu'il ne l'aurait jamais fait sur un vrai réseau intermittent — corrigé avant d'attendre la preuve
en production.

### La surveillance par abonnement, D47

Une fois la cause corrigée, la détection ajoutée par-dessus — pas à la place. Deux volets, comme
demandé :

**Côté serveur** (`services/realtime/src/ws/liveness.ts`) : un battement de cœur WebSocket
(ping/pong du protocole, `WS_HEARTBEAT_INTERVAL_SECONDS`, défaut 30 s) détecte une connexion à
moitié fermée — le cas courant sur un réseau mobile — et la termine, ce qui déclenche le nettoyage
déjà existant (`registry.remove`, `nearby.unsubscribe`, `tracking.unsubscribe`,
`disconnectGrace.schedule`). Sans ça, un registre grossirait indéfiniment vers des connexions
mortes que personne ne referme.

**Côté application** (`packages/api-client/src/realtime/liveness.ts`,
`StreamLivenessWatchdog`) : générique à n'importe quel flux périodique, branché sur `nearby.drivers`
(`HomeScreen`) et `driver.position` (`TrackingScreen`). Passé un multiple configurable de la
cadence attendue sans rien recevoir (3 par défaut), l'écran :

- l'affiche (« Liste des chauffeurs non mise à jour depuis N s » / « Position non mise à jour
  depuis N s »), jamais un silence ni un marqueur figé — la liste ou la dernière position connue
  reste affichée, seul un bandeau s'ajoute ;
- se réabonne aussitôt, sur la connexion existante (pas une reconnexion — la cause racine du 30
  août était un abonnement mort sur une connexion par ailleurs vivante) ;
- si le silence persiste, réessaie à délai croissant (`computeReconnectDelayMs`, déjà écrit pour
  L3-11, réutilisé tel quel plutôt qu'une seconde politique) — jamais une tentative à chaque
  vérification, qui heurterait `NEARBY_RATE_LIMIT_MAX_SUBSCRIPTIONS` (10/60 s).

**Correction consciente à la proposition de la nuit précédente** : pas de battement de cœur sur la
connexion côté client — il aurait répondu normalement pendant que la diffusion applicative était
morte, confirmant que « tout va bien » au pire moment.

### Tests

`services/realtime/test/nearby.test.ts` (+1), `test/broadcast.test.ts` (+1),
`test/liveness.test.ts` (nouveau, 4) ; `packages/api-client/test/realtime/connection.test.ts`
(1 réécrite, +1), `test/realtime/liveness.test.ts` (nouveau, 7) ;
`apps/client/src/screens/__tests__/HomeScreen.test.tsx` (+2),
`__tests__/TrackingScreen.test.tsx` (+2).

**Effet de bord trouvé en passant, corrigé avant de continuer** : trois fichiers de test du
service temps réel (`test/auth.test.ts`, `test/health.test.ts`, `test/ws.test.ts`) construisent un
`Config` littéral, jamais passé par `parseConfig()` — `tsconfig.json` n'inclut que `src/**/*.ts`
(point 4 de la définition de fini, `tsc --noEmit`, ne les couvre donc pas). L'ajout de
`WS_HEARTBEAT_INTERVAL_SECONDS` comme champ obligatoire y était silencieusement `undefined` à
l'exécution — `npm test` seul l'a révélé (`setInterval(cb, NaN)`, un test cassé de façon indirecte,
sans lien apparent avec L3-20). Corrigé (`WS_HEARTBEAT_INTERVAL_SECONDS: 3600` dans les trois,
volontairement hors de portée de leurs propres échéances). **Ce qui n'aurait servi à rien de
sauter** : c'est exactement le genre de régression que "rejouer la suite entière, pas seulement les
tests de la tâche" existe pour attraper.

**Effet de bord distinct, trouvé de la même façon** : ni `HomeScreen.test.tsx` ni
`TrackingScreen.test.tsx` ne démontaient leurs instances React entre les tests (`renderHome()`
n'appelait jamais `.unmount()`) — sans conséquence tant qu'aucun écran ne portait de minuteur réel,
mais `StreamLivenessWatchdog` en pose un. Le process de test plantait (`window.dispatchEvent is not
a function`) une fois la suite assez longue pour dépasser la cadence de vérification. Corrigé côté
`HomeScreen.test.tsx` (accumulation des racines rendues + démontage systématique en `afterEach`,
`TrackingScreen.test.tsx` le faisait déjà) — un gap préexistant, révélé, pas introduit, par cette
tâche.

### Fichiers

`packages/api-client/src/realtime/{connection,queue,liveness,index}.ts`,
`services/realtime/src/{config,ws/connection,ws/liveness,nearby/handler,tracking/broadcast}.ts`,
`apps/client/src/screens/{HomeScreen,TrackingScreen}.tsx`, tests associés listés ci-dessus.

### Doute pour un client réel

**Les deux constantes de cadence côté app** (`NEARBY_BROADCAST_EXPECTED_INTERVAL_MS`,
`TRACKING_BROADCAST_EXPECTED_INTERVAL_MS`) sont des copies locales des valeurs par défaut du
service (`NEARBY_BROADCAST_INTERVAL_SECONDS`, `TRACKING_BROADCAST_INTERVAL_SECONDS`,
`config.ts`), pas une lecture de la vraie valeur — L3-15 (canal de configuration Odoo → temps
réel) ne couvre que Odoo vers le service, rien ne transmet cette cadence jusqu'à l'app. Si
quelqu'un change `NEARBY_BROADCAST_INTERVAL_SECONDS` en base sans toucher au code de l'app, le
seuil de silence côté client se désynchronise silencieusement de la vraie cadence serveur — un
seuil trop court déclencherait des fausses alertes, un seuil trop long masquerait un vrai silence
plus longtemps que nécessaire. Pas un défaut de cette nuit (le même statut que
`NEARBY_SUBSCRIBE_RADIUS_METERS`, déjà provisoire avant ce soir), mais qui grandit avec chaque
constante de ce genre.

---

## L6-11 — Bascule en ligne / hors ligne

Premier écran métier réel de l'app Chauffeur — comme `HomeScreen.tsx` l'a été côté Client (L6-06),
il pose l'infrastructure que L6-12 (cette nuit) puis L6-13/L6-14 réutiliseront telle quelle :
`apps/driver/src/realtime.ts`, calqué sur son équivalent Client (même patron, un seul WebSocket
par session, `onRealtimeMessage`/`onRealtimeConnectionStateChange` diffusés).

### L'interrupteur n'invente jamais l'éligibilité, il l'affiche (invariant 3)

`AvailabilityToggle.tsx` n'a aucune règle métier : `POST /drivers/me/availability` reste seul juge
(L3-04, Odoo). Chaque refus (`DRIVER_NOT_APPROVED`, `MOTORCYCLE_NOT_ASSIGNED`,
`INSURANCE_EXPIRED`, `LICENSE_EXPIRED`, `CASH_LIMIT_REACHED`, `DRIVER_HAS_ACTIVE_RIDE`) passe par
`translateApiError` (catalogue C-01, déjà écrit — rien à ajouter côté message). Le motif plafond
propose un accès direct à L5-07 via une route `Remittance` réservée par `PlaceholderScreen`, même
discipline que `ActiveRide`/`Settlement` déjà en place pour L6-13/L6-14 — écart détaillé
(`amoa/questions/L6-11.md`) : l'écran réel n'existe pas encore, la route si.

### « En course » : lu depuis le serveur, jamais deviné

Critère 2 (« un chauffeur en course ne peut pas se mettre hors ligne ») exigeait un signal
proactif, pas seulement une erreur après coup. Rien ne le portait encore côté app — mais
`session.synced` (C-02, `activeRideState`) l'a toujours fait côté fil : envoyé automatiquement à
chaque connexion établie (`session.resync`, déjà câblé dans `connection.ts` avant ce soir, jamais
consommé par aucun écran jusqu'ici). `HomeScreen.tsx` s'y abonne et désactive l'interrupteur
quand `activeRideState` vaut `assigned` ou `in_progress` — aucune supposition locale, uniquement
ce que le serveur a déjà dit.

### Le point d'entrée de L6-12, posé ici plutôt que laissé en suspens

`Home` est l'écran permanent que les événements interrompent (`navigation/types.ts`) : rien
d'autre ne pouvait écouter `proposal.new` et naviguer vers `Proposal`. Laisser ce câblage à L6-12
aurait reproduit le manque de découpage déjà nommé trois fois ce mois-ci (L6-00, L3-18, L3-19) --
posé ici, avec sa garde contre une seconde proposition affichée par-dessus la première (critère 5
de L6-12, vérifié via `navigation.getState()` plutôt qu'une référence de navigation globale, pour
éviter la dépendance circulaire `navigation/index.tsx` <-> `HomeScreen.tsx`).

### Effet de bord trouvé et corrigé, même famille que la nuit du 21 août côté Client

`apps/driver/jest.config.js` ne listait pas encore `@react-native-async-storage/async-storage`
dans `transformIgnorePatterns` — `createRealtimeClient` le requiert dès sa construction (avant
même toute connexion), et jusqu'à cette tâche, aucun écran chauffeur n'appelait
`createRealtimeClient`. Corrigé par le même patch que `apps/client/jest.config.js` porte déjà.

### Tests

`apps/driver/src/components/__tests__/AvailabilityToggle.test.tsx` (6, dont les 6 codes de refus
distincts, la proposition de remise, la désactivation en course, la panne réseau générique) ;
`apps/driver/src/screens/__tests__/HomeScreen.test.tsx` (5, dont la distinction connexion/en
ligne, `session.synced` → désactivation, `proposal.new` → navigation, garde anti-double-proposition).
`apps/driver/src/navigation/__tests__/AppNavigator.test.tsx` mis à jour (`HomeScreen` mocké, même
patron que côté Client) pour ne pas ouvrir de vraie connexion temps réel dans ce fichier.

### Fichiers

`apps/driver/src/realtime.ts` (nouveau), `apps/driver/src/screens/HomeScreen.tsx` (nouveau),
`apps/driver/src/components/AvailabilityToggle.tsx` (nouveau), `apps/driver/src/navigation/
{index.tsx,types.ts}`, `apps/driver/jest.config.js`, tests associés.

### Doute pour un chauffeur réel

**Le défaut-refus sur l'état de connexion.** `HomeScreen` initialise `connectionState` à
`realtimeClient.getState()`, qui vaut `'offline'` avant tout `connect()` — un chauffeur qui ouvre
l'app voit donc « Hors connexion » pendant la fraction de seconde où `ensureRealtimeConnected()`
établit la connexion. C'est honnête (l'app n'est effectivement pas encore connectée), mais un
chauffeur pressé pourrait taper l'interrupteur avant que la connexion ne soit prête -- ce n'est
pas un problème (l'appel HTTP `setAvailability` ne dépend pas du WebSocket, seul le passage dans
le pool en dépend, via L3-04), mais rien à l'écran ne le distingue d'un vrai problème de réseau.
À observer au pilote plutôt qu'à deviner ce soir.

---

## L6-12 — Réception de proposition

### Réveille l'appareil, joue un son, vibre — une dépendance nouvelle, signalée avant d'être ajoutée

Aucune bibliothèque de ce genre n'existait dans `apps/driver` (vérifié). Signalé avant d'ajouter
quoi que ce soit (CLAUDE.md, « dépendance lourde »). Choix retenu (soumis, tranché) :
`react-native-push-notification` -- une notification **locale** (déclenchée par l'app à la
réception de `proposal.new` sur la connexion déjà ouverte, pas une notification distante) réveille
l'écran, joue le son et vibre par un seul mécanisme (canal Android à importance haute), plutôt que
trois. `L7-04` (notification push hors connexion, distante celle-là) reste une tâche distincte,
non touchée ce soir.

`android/app/src/main/AndroidManifest.xml` ne porte que ce qui est strictement nécessaire au
local : permission `VIBRATE`, la meta-donnée de couleur, et les deux `<receiver>` d'actions/de
publication -- ni le récepteur de redémarrage (aucune notification programmée à l'avance) ni le
service Firebase (aucun envoi distant). **Non vérifiable ce soir** : un build Android/iOS réel
(reprend la liste déjà ouverte, « la vérification développeur Android »).

### « Acceptation tardive » : le seul signal que le fil porte réellement

Écart déposé (`amoa/questions/L6-12.md`) : aucun message serveur ne confirme au **chauffeur**
qu'une acceptation a réussi (`ride.assigned` ne part que vers le client). Le seul signal négatif
disponible est `proposal.expired`, déjà prévu pour l'expiration -- et c'est exactement le cas que
L3-07 nomme comme le plus probable (« le chauffeur appuie à temps, le message arrive en retard »).
`ProposalScreen.tsx` s'appuie dessus : un délai de grâce fixe après l'envoi de `proposal.accept`,
pendant lequel un `proposal.expired` reçu bascule vers le message « cette course a été attribuée »
(critère 3) plutôt que vers `ActiveRide`. Passé ce délai sans rien recevoir, la bascule a lieu --
un pari raisonnable ce soir puisque `ActiveRide` n'est encore qu'un `PlaceholderScreen` (L6-13),
mais qui devra être remplacé par un vrai accusé de réception avant que cet écran ne fasse quelque
chose de réel.

### `proposal.new` transmis en entier à la navigation, jamais relu

`DriverParamList['Proposal']` porte désormais tout le contenu du message, pas seulement `rideId`
(`navigation/types.ts`) : `proposal.new` est diffusé une seule fois aux abonnés déjà en écoute au
moment de sa réception (`onRealtimeMessage`) -- un abonnement posé au montage de `ProposalScreen`
ne le recevrait jamais une seconde fois. Departure/arrivée sont reverse-géocodés côté écran
(`@babana/maps`), même honnêteté d'affichage que `HomeScreen.tsx` côté Client.

### Tests

`apps/driver/src/screens/__tests__/ProposalScreen.test.tsx` (9), couvrant les 5 critères
numérotés : réveil au montage (1, via un double `proposalAlert.ts` mocké -- le déclenchement réel
ne peut pas être vérifié en test unitaire, seulement l'appel), taille tactile (2, mesurée sur le
style réel des deux boutons), acceptation tardive avec message distinct (3), expiration simple ET
tardive ramenant automatiquement à l'accueil (4), et la garde contre une double proposition
(5, déjà testée côté `HomeScreen.test.tsx`, L6-11).

Effet de bord trouvé et corrigé, même famille que celui de L6-11 (async-storage) : le module réel
de `react-native-push-notification` construit un `NativeEventEmitter` dès son chargement --
`apps/driver/__mocks__/react-native-push-notification.js`, même patron que
`__mocks__/react-native-maps.tsx` déjà dans ce dossier (double automatique, sans `jest.mock()`
explicite dans chaque fichier).

### Fichiers

`apps/driver/src/screens/ProposalScreen.tsx`, `apps/driver/src/components/CountdownRing.tsx`,
`apps/driver/src/proposalAlert.ts`, `apps/driver/src/format.ts` (nouveaux),
`apps/driver/src/bootstrap.ts`, `apps/driver/src/navigation/{index.tsx,types.ts}`,
`apps/driver/android/app/src/main/AndroidManifest.xml`, `apps/driver/package.json`,
`apps/driver/__mocks__/react-native-push-notification.js`, tests associés.

### Doute pour un chauffeur réel

**Le délai de grâce de 1500 ms est deviné, pas mesuré.** Sur un réseau réellement dégradé (le cas
courant à Douala, CLAUDE.md), un aller-retour peut dépasser cette valeur -- l'écran basculerait
alors vers `ActiveRide` alors qu'un `proposal.expired` est encore en chemin. Sans conséquence
visible ce soir (l'écran de destination est vide), mais c'est exactement le genre d'hypothèse
temporelle que ce dépôt a appris à se méfier de lui-même (L3-20, cette même nuit). Le seul
correctif propre est celui déjà proposé dans l'écart : un accusé de réception dédié, qui retire le
besoin de deviner un délai.
