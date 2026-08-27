# Rapport de nuit — J23

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini). `amoa/questions/REPONSES-2026-08-31.md` lu en entier avant d'ouvrir quoi que ce soit.
Périmètre confié : les trois correctifs de contrat (D49, D50, D51), puis L6-13 et L6-14 — avec
arrêt après L6-13 si le lot ne passe pas en entier.

Branches par tâche, comme la nuit précédente. `make reset` et la passe complète en fin de session.

---

## D49 — `proposal.accepted` entre au contrat, les 1500 ms devinées disparaissent

### Le motif, une fois de plus : là où l'application devinait, il manquait un message

`ProposalScreen` (L6-12) attendait `ACCEPT_CONFIRMATION_GRACE_MS` (1500 ms) après avoir envoyé
`proposal.accept`, puis basculait vers `ActiveRide` « en confiance » — parce que le contrat ne
portait que les issues négatives (`proposal.expired`). Un délai deviné est toujours trop court ou
trop long : sur un réseau de Douala, un aller-retour peut dépasser 1500 ms, et l'écran serait
parti vers une course en cours pendant qu'un `proposal.expired` était encore en chemin. Tant
qu'`ActiveRide` était un `PlaceholderScreen`, le risque était borné ; L6-13 (cette nuit) le rend
réel.

### Ce qui a été fait

- **Contrat** (`packages/contracts/src/realtime/server-to-client.ts`) : `proposal.accepted`
  (destinataire chauffeur, `{ rideId }`), ajouté au `ServerToClientMessageSchema`. Symétrique de
  `ride.assigned` côté client. `docs/contracts/realtime-events.md` et `realtime-message-map.json`
  mis à jour (statut `wired`, émetteur + consommateur réels).
- **Service** (`services/realtime/src/proposal/lifecycle.ts::accept`) : émet `proposal.accepted`
  au chauffeur **dès le succès de `resolveProposal`**, avant tout `await` sur Odoo ou le cache de
  profils, et **sans dépendre de `consumeRecord`** — la certitude du chauffeur ne doit pas tenir à
  un enregistrement Redis qui pourrait manquer. Même point de code que `ride.assigned`.
- **App** (`apps/driver/src/screens/ProposalScreen.tsx`) : plus aucun délai. `handleAccept` n'est
  plus `async`, il envoie `proposal.accept` et passe en `accepting`. La bascule vers `ActiveRide`
  n'a lieu que sur `proposal.accepted` (rideId correspondant, décision encore `accepting` ou
  `idle`). `proposal.expired` garde son rôle (expiration simple / acceptation tardive, critères 3
  et 4 de L6-12).

### Le filet, sans réintroduire de délai deviné

Si `proposal.accepted` se perd **sans** que la connexion tombe puis se rétablisse, rien sur le
fil ne le rattrape immédiatement. `ProposalScreen` écoute donc aussi `session.synced` : la
resynchronisation automatique (`@babana/api-client`, émise à chaque `connected`) rapporte
`activeRideId` / `activeRideState` ; si la course est la sienne et vaut `assigned` / `in_progress`,
bascule vers `ActiveRide`. C'est « demander au serveur » plutôt que « deviner d'un délai » — même
esprit que le reste de la nuit. Le cas résiduel (double perte `proposal.accept` **et**
`proposal.expired`, sans aucune reconnexion) reste borné par le battement de cœur ajouté en J22
(`ws/liveness.ts`), qui finit par fermer une connexion à moitié morte → reconnexion → resync.

### Tests

- `packages/contracts/test/realtime.test.ts` : `ProposalAcceptedMessageSchema` accepte l'exemple.
- `services/realtime/test/proposal.test.ts` : `accept()` pousse `['proposal.new',
  'proposal.accepted']` au chauffeur ; une double acceptation ne produit qu'**un** accusé (celui
  de l'acceptation qui a gagné la résolution atomique).
- `apps/driver/src/screens/__tests__/ProposalScreen.test.tsx` : accepter n'envoie que
  `proposal.accept` ; aucune bascule après 60 s sans accusé ; bascule sur `proposal.accepted` ;
  `proposal.accepted` d'une autre course ignoré ; filet `session.synced` (n'agit que sur la bonne
  course dans un état affecté) ; acceptation tardive inchangée.

`make test` complet et `tsc --noEmit` : voir la passe finale.

### Doute pour un chauffeur réel

Le cas résiduel ci-dessus (double perte sans reconnexion) laisse l'écran sur « Envoi de votre
acceptation… » jusqu'au prochain battement de cœur. C'est strictement mieux que l'ancienne bascule
optimiste (qui, avec un `ActiveRide` désormais réel, afficherait une course en cours qui n'existe
pas), mais un chauffeur pressé pourrait quitter l'app entre-temps. À observer au pilote.

`amoa/questions/L6-12.md` (premier écart) : **résolu** par D49.

---

## D50 — l'accusé d'abonnement porte la cadence réelle du flux

### Le même motif, appliqué plus largement que le cas trouvé

Deux copies locales de constantes serveur restaient côté app : `NEARBY_BROADCAST_EXPECTED_INTERVAL_MS`
(HomeScreen) et `TRACKING_BROADCAST_EXPECTED_INTERVAL_MS` (TrackingScreen), toutes deux recopiées
de `config.ts` du service, sans aucun mécanisme pour les tenir d'accord. Un opérateur qui change
`NEARBY_BROADCAST_INTERVAL_SECONDS` en base désynchronise silencieusement le seuil de silence de
la surveillance L3-20 — trop court : fausses alertes ; trop long : un vrai silence masqué. C'est
D23 sous un autre costume (« ça grandit avec chaque constante de ce genre », rapport J22).

### Ce qui a été fait

- **Contrat** : `nearby.subscribe.ack` (branche `accepted: true`) gagne `broadcastIntervalMs` ;
  **nouveau `ride.track.ack`** (`{ broadcastIntervalMs }`), le suivi n'avait aucun accusé jusqu'ici.
  Les deux au `ServerToClientMessageSchema`, `realtime-events.md` et `realtime-message-map.json`
  mis à jour.
- **Service** : `nearby/handler.ts` met `NEARBY_BROADCAST_INTERVAL_SECONDS * 1000` dans l'accusé
  accepté ; `tracking/broadcast.ts::TrackingManager.subscribe` émet `ride.track.ack`
  (`TRACKING_BROADCAST_INTERVAL_SECONDS * 1000`) avant toute diffusion, à **chaque** abonnement, y
  compris un réabonnement après reconnexion — l'app relit la cadence courante plutôt que de la
  supposer figée.
- **App** : les deux constantes supprimées. Le `StreamLivenessWatchdog` n'est plus créé dans le
  corps de l'effet mais **à la réception de l'accusé**, avec `expectedIntervalMs =
  message.payload.broadcastIntervalMs`. Un nouvel accusé (réabonnement) recrée le watchdog à la
  cadence à jour. `recordActivity()` est gardé (`watchdog?.`) tant que l'accusé n'est pas arrivé —
  ce qui, en pratique, précède toujours la première diffusion (le service envoie l'accusé en
  premier).

### Tests

- `packages/contracts/test/realtime.test.ts` : accusé accepté sans `broadcastIntervalMs` rejeté ;
  `ride.track.ack` validé.
- `services/realtime/test/nearby.test.ts` : l'accusé accepté porte
  `NEARBY_BROADCAST_INTERVAL_SECONDS * 1000`.
- `services/realtime/test/broadcast.test.ts` : `ride.track.ack` précède toute diffusion et porte
  la cadence ; assertions de contenu isolées via un filtre `positionMessages` (l'accusé n'est pas
  un `driver.position`). Aucun `driver.position` vers un client non affecté — inchangé.
- `apps/client/.../HomeScreen.test.tsx`, `TrackingScreen.test.tsx` : nouveau test « le seuil de
  silence suit la cadence annoncée » (accusé à 8 s → silence à 24 s, pas 15 ; accusé à 4 s →
  silence à 12 s, pas 30). Les tests L3-20 existants émettent désormais l'accusé d'abord.

### Doute pour un utilisateur réel

Si l'accusé se perd (première diffusion arrivée sans lui, réseau très dégradé), la surveillance de
silence ne démarre pas du tout pour cet abonnement — dégradation silencieuse. C'est moins grave
qu'un seuil faux (le battement de cœur de connexion de J22 attrape toujours une connexion morte),
mais un flux qui se fige sur une connexion vivante ne serait alors pas détecté jusqu'au prochain
réabonnement. En pratique le service envoie l'accusé en synchrone, avant tout `await`, donc avant
la première diffusion — le cas ne devrait pas se produire sans perte de message pure.

---

## D51 — `proposal.new` porte la distance à parcourir à vide jusqu'au client

### Le manque

`proposal.new` portait `distanceMeters` = distance de la **course** (départ → arrivée, celle du
tarif). Rien ne disait au chauffeur combien il doit rouler **à vide** pour rejoindre le client —
or pour décider en trente secondes c'est souvent le chiffre le plus déterminant : une course à
500 FCFA qui demande trois kilomètres à vide n'est pas la même affaire. Sans lui, un refus par
précaution coûte trente secondes au client et un chauffeur à sa liste (écart
`amoa/questions/L6-11.md`, second point).

### Ce qui a été fait

- **Contrat** : `distanceToOriginMeters: number | null` ajouté à `ProposalNewPayloadSchema`.
  `null` — jamais absent — si la position du chauffeur n'est plus lisible au moment de la
  réservation (le pool et la clé de position ont des durées de vie distinctes) : même patron que
  D30 pour le profil chauffeur, la proposition part quand même.
- **Service** (`proposal/lifecycle.ts::propose`) : lit `getPosition(driverId)` (le même geo-index
  qui vient de faire apparaître ce chauffeur dans `nearby.drivers`) et calcule
  `haversineDistanceMeters(position, details.origin)`, arrondi à l'entier. Calculé **côté serveur**,
  pas recalculé côté app depuis une position GPS locale qui aurait pu bouger entre la sélection et
  l'affichage — et de toute façon L6-05 (capture GPS chauffeur) n'existe pas encore. Approximation
  à vol d'oiseau assumée (É8, aucun routage deux-roues au Cameroun), même honnêteté que la
  distance de `nearby.drivers` et l'ETA de `driver.position`.
- **App** : `DriverParamList['Proposal']` porte le champ ; `HomeScreen` le transmet ;
  `ProposalScreen` l'affiche — « ≈ 1.4 km pour rejoindre le client », ou « Distance jusqu'au
  client indisponible » quand `null`.

### Tests

- `packages/contracts/test/realtime.test.ts` : valeur, `null`, et champ absent (rejeté).
- `services/realtime/test/proposal.test.ts` : chauffeur repositionné à ~1,1 km → distance à vide
  plausible et entière ; position supprimée → `distanceToOriginMeters === null`, proposition émise
  quand même.
- `apps/driver/.../ProposalScreen.test.tsx` : affichage de la distance et de son indisponibilité ;
  `HomeScreen.test.tsx` : le champ traverse la navigation.

`amoa/questions/L6-11.md` (second écart) et `amoa/questions/L6-12.md` (second écart, qui y
renvoyait) : **résolus** par D51.

### Doute pour un chauffeur réel

La distance est à vol d'oiseau. À Douala, avec le trafic et les sens uniques, la distance routière
réelle peut être bien plus grande — un chauffeur qui prend l'habitude de s'y fier pourrait
sous-estimer son temps d'approche. Le préfixe « ≈ » et la cohérence avec l'ETA (déjà corrigé par
un facteur en L10-03 côté client) limitent le risque, mais c'est le genre d'approximation qui se
vérifie au pilote.

---

## L6-13 — course en cours côté chauffeur

### L'écran que le bouton d'urgence attendait

`ActiveRideScreen.tsx` remplace le `PlaceholderScreen` réservé depuis le 24 août. Deux phases —
approche vers le client, puis trajet — le passage de l'une à l'autre étant **une décision**
(bouton « Démarrer la course »), jamais déduite d'une position (invariant 1). Idem pour la fin.
`session.synced` (`activeRideState == in_progress`) sert de filet si l'app a été tuée puis
relancée en pleine course.

### Le GPS de l'urgence : rappelé à l'instant

`EmergencyButton` (écrit et testé le 24 août, `getPosition` injecté « pour que cette tâche
décide ») reçoit `() => getCurrentPosition()` de `apps/driver/src/location.ts` — **nouveau**, une
lecture unique du GPS. Décision : **rappeler le GPS maintenant**, pas réutiliser une dernière
position, parce qu'il n'existe aujourd'hui aucune « dernière position en vol » (L6-05 non
construite, l'app n'émet encore aucun `position.update`), et parce qu'au moment d'une urgence la
position la plus fraîche vaut mieux qu'une position d'il y a quelques minutes issue d'une cadence
ralentie pour la batterie. La capture **continue** (fréquence adaptative, arrière-plan) reste
L6-05 : `location.ts` ne fait qu'un relevé ponctuel, c'est écrit dans son en-tête.

Dépendance nouvelle signalée : `@react-native-community/geolocation` (`^3.4.0`) — la même que
`apps/client` utilise déjà, hoistée à la racine, `__mocks__` copié depuis le client.

### Le lien profond, l'app vivante derrière (D12)

`navigation/launch.ts::launchRideNavigation(phase, points, onReturn)` choisit le point visé selon
la phase et appelle `openNavigation` de `@babana/maps` (L6-01) — jamais un SDK de carte en direct,
signature identique à la v2 embarquée. Google Maps s'ouvre par-dessus ; React Navigation ne
démonte pas l'écran, `phase`/`startedAt` sont préservés, le retour retrouve la course.
`gestureEnabled: false` sur la route : on ne « swipe » pas hors d'une course en cours.

### Le bouton de fin, difficile à toucher par accident

Pas un dialogue à lire (spécification) : **maintien prolongé** (`onLongPress`, 900 ms, aucun
`onPress` qui termine), et placé tout en bas de l'écran, séparé du bouton de guidage qu'on touche
en roulant. Garde anti-double-navigation entre la réponse HTTP de `completeRide` et le message
`ride.completed` (L3-19, poussé aussi au chauffeur) — un seul navigue vers `Settlement`.

### Écart déposé — `amoa/questions/L6-13.md` (sur master)

`POST /rides/{id}/complete` exige `{ distanceMeters, durationSeconds, polyline }` : un relevé du
trajet réel. L'app Chauffeur n'en a aucune source (L6-05 et L3-10 non construites ; L4-04 dit que
c'est au service temps réel de fournir ces valeurs). Stopgap assumé et testé
(`apps/driver/src/ride/completion.ts`) : `durationSeconds` mesuré à l'horloge depuis le démarrage
observé ; `distanceMeters` = distance de référence (le montant se calcule de toute façon sur elle,
`actual ≈ référence` n'arme pas l'alerte d'écart L4-04) ; `polyline` = ligne droite départ →
arrivée. **Le montant encaissé et le compte courant ne sont pas affectés.** Proposition dans
l'écart : `complete` ne devrait pas exiger ce relevé de l'app.

Second écart, connexe : **aucun bouton d'appel du client** — aucun message du contrat ne porte son
numéro (symétrique de `amoa/questions/L6-09.md`). Absent, jamais inerte.

### Tests

- `apps/driver/src/navigation/__tests__/launch.test.ts` (3) : cible selon la phase, toujours via
  `@babana/maps`.
- `apps/driver/src/ride/__tests__/completion.test.ts` (6) : encodeur polyline (exemple canonique
  Google), `durationSeconds` à l'horloge, `distanceMeters` = référence, durée négative → 0.
- `apps/driver/src/screens/__tests__/ActiveRideScreen.test.tsx` (13) : les 5 critères numérotés
  (lien profond selon la phase ; état préservé après guidage ; fin par maintien prolongé →
  `completeRide` → `Settlement` ; pas de bouton d'appel client), plus `start`/`ride.started`/
  `ride.completed`/`ride.cancelled`/`session.synced`, message pour une autre course ignoré, échec
  de démarrage affiché.
- `transitions.test.ts`, `types.test.ts`, `ProposalScreen.test.tsx` mis à jour (params
  `ActiveRide`/`Settlement` élargis, `replaceWithActiveRide` transmet origine/arrivée/montant).

### Non vérifiable ce soir

Critère 2 (« la capture GPS continue quand l'app est en arrière-plan ») : c'est L6-05, non
construite — l'app n'émet encore aucune position, en avant-plan comme en arrière-plan. La
structure (l'app reste vivante, l'état de course est préservé, le retour retrouve l'écran) est en
place et testée ; la capture elle-même reprend la liste des tâches ouvertes.

### Doute pour un chauffeur réel

Le stopgap de `completeRide`. Un chauffeur qui prend un vrai raccourci verra le client facturé (à
juste titre, D15/L4-04) sur la distance de référence, mais le `actual_distance_km` enregistré sera
lui aussi la référence — donc aucune détection de détour abusif possible tant que L3-10 n'existe
pas. Ce n'est pas un risque financier, c'est un angle mort de contrôle, et il est nommé dans
l'écart.

---

## L6-14 — confirmation d'encaissement espèces

### Le chauffeur confirme, il ne saisit pas (L4-05)

`SettlementScreen.tsx` affiche le montant dû (transmis par la navigation depuis la course
terminée) et **aucun champ de saisie** — vérifié par un test qui compte les `TextInput` (0).
« Confirmer l'encaissement » envoie `POST /rides/{id}/settle` avec `amountCollected` = le montant
affiché, jamais autre chose. Un écart réel (le client n'a pas l'appoint) se traite en remise de
caisse (L5-06), pas ici — rappelé sous le montant.

### Après confirmation : solde et marge, lus du serveur

La réponse de `settle` donne le nouveau `driverCashBalance`. La marge avant plafond demande le
plafond, absent de cette réponse → second appel `GET /drivers/me/cash` (`driverCash`, déjà au
contrat). Marge = `plafond - solde`, affichage de deux valeurs serveur (L5-07 : le solde n'est
jamais dérivé localement). Si `driverCash` échoue, le solde reste affiché, pas la marge.

### Plafond franchi → la remise, tout de suite

Si `solde >= plafond`, bannière explicite « vous êtes passé hors ligne » + bouton « Déclarer une
remise » → route `Remittance` (réservée depuis L6-11, `PlaceholderScreen` jusqu'à L5-07). C'est le
scénario du contexte terrain : la flotte se vide et personne ne comprend — ici le chauffeur sait
pourquoi et quoi faire, dans le même écran.

### Hors connexion

Sur échec réseau : état « en attente », **même clé d'idempotence** conservée
(`generateIdempotencyKey`, une fois par montage), bouton « Réessayer maintenant ». Un renvoi ne
produit jamais de double encaissement (clé stable + `babana.idempotency.record` côté Odoo). La
file persistante qui survit à un redémarrage de l'app est L6-16 (non construite) — voir l'écart.

### Écart déposé — `amoa/questions/L6-14.md` (sur master)

Trois points : (1) « passé hors ligne » est **inféré** en comparant le solde au plafond —
`action_settle` connaît `cash_limit_crossed` mais ne le renvoie pas ; proposition : un
`wentOffline` dans `SettleRideResponse`. (2) le plafond/la marge ne sont pas dans la réponse de
`settle` → second `GET /drivers/me/cash` ; proposition : `cashLimit` dans la réponse. (3) la file
hors connexion persistante est L6-16.

### Tests

`apps/driver/src/screens/__tests__/SettlementScreen.test.tsx` (9) : les 5 critères numérotés
(aucun champ de saisie ; solde + marge après confirmation ; franchissement du plafond annoncé avec
accès remise ; mise en attente puis renvoi hors connexion ; renvoi à clé d'idempotence identique),
plus l'erreur métier non rejouée, `driverCash` en échec, le chemin « sous le plafond → Terminé ».

### Doute pour un chauffeur réel

Le point (1) de l'écart : tant que la réponse de `settle` ne dit pas explicitement « tu es passé
hors ligne », l'app le déduit d'une comparaison. Si le plafond change en base entre le `settle` et
le `GET /drivers/me/cash` (fenêtre de quelques ms), ou si le `GET` échoue, l'écran peut afficher
« sous le plafond » alors que le serveur a mis le chauffeur hors ligne — il découvrirait alors le
blocage sur `HomeScreen` (L6-11 affiche le motif `CASH_LIMIT_REACHED`), pas ici. Rare, sans risque
financier, mais c'est une inférence de plus à retirer.

---

## Passe finale — `make reset`, suite complète, vérification navigateur des deux côtés

### `make reset` + `make up` + `make test`

Base jetée et reconstruite. **`npm test` (hôte) : vert en entier sur base fraîche** —
`@babana/contracts` 71, `@babana/realtime` 175, `@babana/api-client` 66, `@babana/maps` 19,
`@babana/navigation` 4, `@babana/client` 102, `@babana/driver` 76, `@babana/concurrency-tests` 28
(dont la boucle e2e contre la vraie pile), plus `verify-realtime-message-map.js` et
`verify-ride-state-machine.js`. `make lint`, `tsc --noEmit` (tous les paquets), `make secrets-scan`
(seul le faux positif préexistant `react-native-keychain.web.js`, aucun nouveau) : verts.

**Un test Odoo rouge, hors périmètre, à signaler.** Sous `-i babana --test-enable` avec la suite
Odoo entière (2255 tests), `TestRealtimeCommitHook.test_clear_engagement_does_nothing_if_the_
transaction_rolls_back` échoue **une fois**. Le même test, isolé (`--test-tags=/babana:TestRealtimeCommitHook`,
10/10) et dans la suite `babana` seule (`--test-tags=/babana`, 455/455), passe. C'est une
**pollution inter-modules** (un autre module laisse de l'état de transaction/registre), sur le
point d'accroche au commit D32/D33 — **aucun fichier de cette nuit ne touche cette zone**
(`babana_ride_state.py`, `realtime_client.py`, la plomberie commit-hook, tous inchangés depuis
J22). Instabilité préexistante révélée par la première passe `make reset` de la semaine (J22 ne
l'avait pas faite), pas une régression. À traiter comme le demande `CLAUDE.md` (« un test instable
est un défaut ») — mais c'est un défaut d'isolation de test dans du code non modifié ce soir, pas
un blocage de ce lot.

### Vérification navigateur — les deux côtés, jusqu'au bout

Banc jetable en **même origine** (D46, méthode J21/J22) : `dist-web` construit pointé sur
`http://verify.localhost:8888`, un Caddy `docker run` séparé (jamais commité, retiré en fin de
session) sert le bundle et relaie `/api/*` → Odoo, `/rt/*` → temps réel, `/maps/*` → mock-maps.
Session client réelle injectée (jeton par vrai `POST /auth/google`).

**Client, dans le navigateur (vrai bundle web) :**

- `SignIn` s'affiche, puis `Home` après restauration de session — **aucune page blanche, aucune
  erreur console** malgré les ajouts au contrat (D49/D50/D51).
- `Home` : la carte, le rappel « le point sur la carte fait foi », et **un chauffeur réel dans la
  liste, mis à jour en direct** — la restructuration D50 du `StreamLivenessWatchdog` (créé à la
  réception de `nearby.subscribe.ack`, recréé à chaque réabonnement) fonctionne : liste qui se
  vide proprement quand le départ passe hors rayon, qui revient quand un chauffeur rentre dans le
  rayon, jamais de bandeau de silence parasite.
- Recherche de lieu (Akwa, Bonapriso via le proxy `/maps`), `Suivant` → `Quote` : **estimation
  réelle 550 FCFA, détail décomposé 200 / 344 / 6, 3.4 km · ≈ 8 min**, la liste des chauffeurs
  reste vivante pendant la comparaison (L6-07).
- Sélection du chauffeur → `Waiting` → `Tracking` → **`RideSummary` atteint avec exactement les
  données du serveur** (550 FCFA, même détail décomposé, 3.4 km · 8 min, notation proposée).

**Chauffeur, contre la même pile (sonde fidèle : vrai WebSocket, vrai jeton, vrais endpoints HTTP
— l'app Chauffeur est React Native, pas de build web, L6-18) :**

- `proposal.new` reçu **avec `distanceToOriginMeters`** (D51, valeur réelle plausible — 175 m puis
  0 m selon la position).
- `proposal.accept` → **`proposal.accepted` reçu** (D49, plus aucun délai deviné).
- `POST /rides/{id}/start` → 200, `ride.started` poussé **au client ET au chauffeur** (L3-19) — le
  navigateur passe en phase « Course en cours ».
- `POST /rides/{id}/complete` → 200, `ride.completed` avec le détail décomposé → le navigateur
  atteint `RideSummary`.
- `POST /rides/{id}/settle` → 200 (`settled`, nouveau solde), **renvoi à clé d'idempotence
  identique : solde inchangé** (L6-14 critère 5), `GET /drivers/me/cash` renvoie solde / plafond /
  marge.
- `nearby.subscribe.ack` **et** `ride.track.ack` portent `broadcastIntervalMs` (D50), vérifié sur
  le fil réel.

Une course a donc été menée de bout en bout par les deux côtés, contre la vraie pile, **jusqu'à
l'encaissement** — et il ne reste plus une seule constante de cadence recopiée du serveur.

Rien de ce banc n'est commité : `infra/` jamais touché (conteneur séparé), `dist-web/`, les
scripts sondes et le conteneur de vérification supprimés, `git status` propre.

---

## Qu'est-ce qui me laisse un doute pour quelqu'un de réel

**Le corps de `POST /rides/{id}/complete` (écart L6-13), et la même famille d'inférence que cette
nuit visait.** Les trois correctifs de contrat ont retiré trois endroits où une app devinait —
mais L6-13 en a révélé un quatrième, plus profond : l'app Chauffeur doit envoyer un *relevé de
trajet* (distance, tracé) qu'elle n'a aucun moyen de mesurer (L6-05 et L3-10 absentes). Le
stopgap ne corrompt pas l'argent (le montant se calcule sur la distance de référence, vérifié),
mais il envoie une distance « réelle » qui est en fait la référence — donc **aucune détection de
détour abusif n'est possible** tant que L3-10 n'existe pas. Un chauffeur qui allonge
systématiquement le trajet ne serait pas repéré. C'est un angle mort de contrôle, pas un bug, et
il est nommé dans l'écart avec sa proposition de résolution.

**Deuxième doute, plus concret pour un pilote proche :** L6-13 câble le bouton d'urgence à une
lecture GPS ponctuelle (`apps/driver/src/location.ts`), mais **son comportement natif réel**
(permission Android au bon moment, délai de 10 s tenu sur un terminal d'entrée de gamme, retour
`null` propre si le GPS est froid) n'a pas pu être vérifié — pas de build mobile dans cet
environnement. Le jour où le bouton d'urgence doit servir, c'est ce chemin qui doit fonctionner du
premier coup.

---

## Ce qui reste ouvert

- **`amoa/questions/L6-13.md`** (nouveau) — `complete` exige un relevé de trajet que l'app n'a
  pas ; pas de numéro client au contrat → pas de bouton d'appel côté chauffeur.
- **`amoa/questions/L6-14.md`** (nouveau) — « passé hors ligne » inféré ; marge via un second
  appel ; file hors connexion persistante = L6-16.
- **`TestRealtimeCommitHook.test_clear_engagement_does_nothing_if_the_transaction_rolls_back`** —
  instable sous la suite Odoo complète, vert isolé. Défaut d'isolation, hors périmètre.
- **L6-05** (capture GPS chauffeur) — la plus sensible du lot restant ; L6-13 en a posé le besoin
  minimal (lecture ponctuelle) sans la construire.
- **L3-10** (accumulation distance/durée/tracé côté service) + son point d'accroche fin-de-course
  vers Odoo — ce qui débloquerait proprement le corps de `complete`.
- **L6-15** (inscription chauffeur), **L3-12** (file persistante), **L4-06** (facture), la
  passerelle SMS, la validation du plan comptable, la vérification développeur Android — inchangés.
