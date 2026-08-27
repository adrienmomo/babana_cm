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
