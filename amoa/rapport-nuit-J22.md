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
