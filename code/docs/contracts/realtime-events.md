# Événements temps réel — WebSocket

Documentation lisible du contrat C-02. Source de vérité : le code TypeScript de
`packages/contracts/src/realtime/` (D16, D17) — importé à l'identique par `apps/client`,
`apps/driver` et `services/realtime`. Un message mal formé devient une erreur de compilation,
pas un bug d'intégration découvert en recette.

---

## Enveloppe commune

Tout message, dans les deux sens, a la forme :

```json
{
  "type": "position.update",
  "id": "3b2e6a3e-9f1a-4b7d-8c3e-1a2b3c4d5e6f",
  "emittedAt": "2026-08-10T07:00:00+01:00",
  "payload": { "...": "spécifique au type" }
}
```

- **`type`** — nom stable, discriminant du message (`z.discriminatedUnion`). Un seul émetteur
  possible par nom (voir plus bas).
- **`id`** — UUID, généré par l'émetteur. Sert à l'idempotence côté réception : un message
  rejoué après reconnexion (même `id`) ne doit produire ses effets qu'une seule fois. Le
  récepteur tient une fenêtre de déduplication par connexion (taille exacte laissée à
  l'implémentation de L3-*, pas figée par ce contrat).
- **`emittedAt`** — horodatage d'émission, ISO 8601 avec fuseau. Sert à la règle « position trop
  ancienne » ci-dessous.

`packages/contracts/src/realtime/envelope.ts` expose `envelopeSchema(type, payloadSchema)`, une
fabrique utilisée par chaque message plutôt que de redéclarer ces trois champs partout.

---

## Convention de fichiers

La spécification C-02 ne prévoit que deux fichiers directionnels (`client-to-server.ts`,
`server-to-client.ts`), pas quatre — alors que la spécification décrit quatre familles
(Chauffeur→serveur, Client→serveur, Serveur→chauffeur, Serveur→client). Choix d'implémentation
retenu (structure de fichiers, ne justifie pas un arrêt) : **« client » désigne l'application,
pas le rôle passager**. `client-to-server.ts` regroupe donc tout message reçu par le serveur, de
n'importe quelle application ; `server-to-client.ts` regroupe tout message émis par le serveur,
vers n'importe quelle application. Chaque message documente son émetteur ou son destinataire
réel en commentaire au-dessus de son schéma.

---

## Messages reçus par le serveur (`client-to-server.ts`)

| Message | Émetteur | Payload | Rôle |
|---|---|---|---|
| `position.update` | Chauffeur | `{ latitude, longitude, accuracyMeters, speedMetersPerSecond, headingDegrees }` | Position GPS courante |
| `availability.set` | Chauffeur | `{ online }` | Bascule en ligne / hors ligne (D7) |
| `proposal.accept` | Chauffeur | `{ rideId }` | Transition `proposed → assigned` |
| `proposal.reject` | Chauffeur | `{ rideId, reason? }` | Transition `proposed → rejected` |
| `nearby.subscribe` | Client | `{ position, radiusMeters, excludeDriverIds }` | S'abonne à `nearby.drivers` |
| `nearby.unsubscribe` | Client | `{}` | Se désabonne |
| `ride.track` | Client | `{ rideId }` | S'abonne au suivi d'une course affectée ou en cours |
| `session.resync` | Client ou chauffeur | `{ lastKnownRideId }` | Voir « Politique de reconnexion » |

`radiusMeters` de `nearby.subscribe` est borné à 50 km dans le schéma — un garde-fou anti-abus
au niveau du contrat, pas la valeur métier du rayon de recherche réel, qui reste configurable
côté service temps réel (invariant 5).

`excludeDriverIds` (défaut `[]`, L3-08, 24 août) porte les chauffeurs déjà refusés sur la course
en cours, au sens où le client les a déjà vus refuser via un `ride.rejected` précédent — pas une
décision de l'app, seulement le rappel d'un fait que le serveur lui a lui-même appris. Le serveur
les exclut de `nearby.drivers` et, si plus aucun candidat ne reste dans le rayon demandé, élargit
le rayon par paliers (`nearby/expand.ts`) jusqu'à un plafond configurable avant de renvoyer une
liste vide — que L6-08 traduit en `NO_DRIVER_AVAILABLE`.

## Messages émis par le serveur (`server-to-client.ts`)

| Message | Destinataire | Payload | Rôle |
|---|---|---|---|
| `proposal.new` | Chauffeur | `{ rideId, origin, destination, amount, distanceMeters, distanceToOriginMeters, expiresAt }` | Nouvelle proposition — `distanceToOriginMeters` = distance à vide jusqu'au client, Haversine, `null` si position illisible (D51) |
| `proposal.expired` | Chauffeur | `{ rideId }` | Délai d'acceptation dépassé |
| `proposal.accepted` | Chauffeur | `{ rideId }` | Son `proposal.accept` a été résolu en sa faveur (transition `proposed → assigned`) — symétrique de `ride.assigned` (D49) |
| `ride.cancelled` | Chauffeur et/ou client, selon `cancelledBy` (L4-12) | `{ rideId, cancelledBy, reason? }` | La course a été annulée |
| `nearby.drivers` | Client | `{ drivers: NearbyDriver[] }` (max 5) | Réponse à `nearby.subscribe`, puis mises à jour |
| `nearby.subscribe.ack` | Client | `{ accepted: true, broadcastIntervalMs }` ou `{ accepted: false, retryAfterMs }` | Accusé de réception de `nearby.subscribe` — `broadcastIntervalMs` = cadence réelle de `nearby.drivers` (D50) |
| `ride.track.ack` | Client | `{ broadcastIntervalMs }` | Accusé de réception de `ride.track` — cadence réelle de `driver.position` (D50) |
| `ride.proposed` | Client | `{ rideId, driverId, proposalExpiresAt }` | Le chauffeur choisi a été réservé (redondant pour l'appareil qui a fait la demande, gardé pour un second appareil du même client — `amoa/questions/REPONSES-2026-08-28.md` §1) |
| `ride.assigned` | Client | `{ rideId, driverId, firstName, photoUrl, motorcycleClass, licensePlate }` | Le chauffeur a accepté |
| `ride.rejected` | Client | `{ rideId, driverId, reason }` | Le chauffeur a refusé ou le délai a expiré |
| `driver.position` | Client | `{ rideId, position, etaSeconds }` | Suivi pendant une course affectée ou en cours |
| `ride.started` | Client | `{ rideId }` | Transition `→ in_progress` |
| `ride.completed` | Client | `{ rideId, distanceMeters, durationSeconds, measured, amount, breakdown }` | Transition `→ completed` — `distanceMeters` / `durationSeconds` à `null` quand `measured` est faux (course terminée sans accumulation temps réel, L3-10 / `amoa/questions/L6-13.md`) |
| `session.synced` | Client ou chauffeur | `{ activeRideId, activeRideState, serverTime }` | Voir « Politique de reconnexion » |

`ride.cancelled` a un seul émetteur (le serveur) mais deux destinataires possibles selon qui est
concerné par la course — le critère d'acceptation 1 de C-02 porte sur l'émetteur, pas sur le
nombre de destinataires ; il n'exige pas deux noms de message distincts pour un même événement
poussé à deux connexions différentes.

`cancelledBy` (L4-12, `amoa/questions/REPONSES-2026-08-28.md` §2) décide QUI reçoit le message,
jamais celui qui vient de décider (il le sait déjà) : un client qui annule prévient le chauffeur
affecté (s'il y en a un), un chauffeur prévient le client, un superviseur prévient les deux.
`babana_ride_state.py::action_cancel` connaît `actor_role` (son premier argument) et calcule ce
destinataire lui-même, avant d'appeler `realtime_client.notify_ride_cancelled` — le service temps
réel ne fait que pousser à qui on lui dit de pousser, il ne redérive pas cette règle.

`ride.rejected` porte `driverId` et `reason` (`'driver_rejected' | 'driver_timeout'`) depuis le
23 août (L6-08, `amoa/questions/L3-07.md`) — absents de la première rédaction, alors que L3-07
(critère 2) promettait déjà au client « un motif distinct de l'expiration » sans le lui donner.
`driverId` permet à L6-08 d'écarter précisément ce chauffeur de la liste réaffichée ; `reason`
permet de ne pas confondre un chauffeur qui refuse explicitement d'un chauffeur qui ne répond
pas, deux situations que le client ne vit pas de la même façon.

`ride.assigned` porte `firstName`, `photoUrl`, `motorcycleClass` et **`licensePlate`** depuis le
25 août (D41, `amoa/questions/REPONSES-2026-08-25.md` §2) — de quoi reconnaître la moto qui
arrive. `licensePlate` est délibérément absent de tout ce qui précède l'affectation
(`nearby.drivers` ci-dessus, schéma inchangé) : la flotte ne doit pas être balayable par un
client qui ne fait que regarder (C2b). C'est le choix qui fait basculer la sensibilité de la
même donnée — ce client-là a choisi ce chauffeur-là, et il attend au bord d'une route de Douala,
où une plaque se reconnaît mieux qu'un visage sous un casque. Les quatre champs sont nullables,
même raison que `NearbyDriver` (D30) : un profil qu'Odoo n'a pas fini de synchroniser ne doit
jamais retarder l'envoi de `ride.assigned` lui-même.

`ride.completed` porte `breakdown` (même `FareBreakdown` que `POST /quote`, C-01) depuis le
25 août — le résumé de fin est ce qu'un client relira en cas de litige, il doit être ce que le
serveur a écrit, pas seulement le montant total. `distanceMeters` / `durationSeconds` sont
**`null`** — jamais 0, jamais une valeur plausible — quand `measured` est faux : la course s'est
terminée sans que le service temps réel n'ait accumulé de trajet (L3-10 absente ou injoignable).
Une absence assumée plutôt qu'un chiffre faux (D30, D43, J24 — `amoa/questions/L6-13.md`) : le
résumé affiche alors « non relevé », et l'écart de distance de L4-04 n'est pas calculé.

`driver.position` (L3-09) diffuse `position` en **précision réelle** — l'arrondi de C2b
(`nearby.drivers`) ne s'applique qu'à la découverte, jamais au suivi d'une course affectée : le
client a le droit de savoir où est le chauffeur qui vient le chercher. `etaSeconds` est une
distance à vol d'oiseau jusqu'au point de prise en charge, convertie par une vitesse moyenne
configurable — pas un temps de trajet routier (aucun service de routage accessible depuis le
service temps réel, D3), même honnêteté que la distance affichée par `nearby.drivers`. Diffusé
tant que le client est réellement abonné à une course qui est la sienne — réévalué à **chaque**
diffusion, pas seulement à l'abonnement : un client jamais affecté, ou dont la course vient de se
terminer, ne reçoit rien.

`nearby.drivers` réutilise exactement le schéma `NearbyDriver`
(`packages/contracts/src/http/driver.ts`) : `.strict()`, mêmes champs, une seule définition pour
la règle « aucune donnée personnelle au-delà du prénom, de la photo, de la note et de la gamme de
moto » (critère d'acceptation 3). `GET /drivers/nearby` (C-01) en partageait la forme avant d'être
retiré du contrat, jamais implémenté — `nearby.drivers` est désormais le seul chemin de découverte
des chauffeurs proches (`amoa/questions/C-01R.md` §1). Position arrondie à 4 décimales (~11 m à
l'équateur), constante `NEARBY_POSITION_PRECISION_DECIMALS` dans
`packages/contracts/src/http/common.ts`.

`nearby.subscribe.ack` (23 août — amoa/questions/REPONSES-2026-08-23.md §2) répond à **chaque**
`nearby.subscribe`, accepté ou refusé pour limitation de débit. Avant ce message, un abonnement
refusé ne produisait rien : un client qui insistait sur « Réessayer » pouvait cesser d'être servi
sans qu'aucun élément ne le lui dise. Un refus porte toujours `retryAfterMs` — un refus sans délai
serait inexploitable côté client.

**Cadence portée par l'accusé (D50, 31 août — amoa/questions/REPONSES-2026-08-31.md §2).** Un
accusé accepté (`nearby.subscribe.ack` avec `accepted: true`, et `ride.track.ack` pour le suivi)
porte `broadcastIntervalMs` : la cadence réelle de la diffusion périodique qui va suivre. L'app
ne tient plus de copie locale de `NEARBY_BROADCAST_INTERVAL_SECONDS` /
`TRACKING_BROADCAST_INTERVAL_SECONDS` pour sa surveillance de silence (L3-20) — elle apprend du
serveur à partir de quand le silence est anormal. Deux copies d'une même valeur sans mécanisme
pour les tenir d'accord finissent par diverger en silence (D23). L'accusé est réémis à chaque
réabonnement, y compris après reconnexion : la cadence relue est toujours la valeur courante.

---

## Politique de reconnexion

**Reconnexion avec délai croissant et gigue aléatoire.** L'application ne retente pas
immédiatement après une coupure — un délai croissant (par exemple exponentiel, plafonné) évite
que toute la flotte se reconnecte à la même seconde après une coupure réseau généralisée ; une
gigue aléatoire ajoutée à ce délai désynchronise les tentatives entre appareils. Les valeurs
exactes (délai initial, facteur de croissance, plafond, amplitude de la gigue) sont un paramètre
d'implémentation de `apps/*` (L6-*), pas du contrat — elles ne changent pas la forme des
messages.

**Resynchronisation complète, jamais un différentiel.** À la reconnexion, le client (ou le
chauffeur) envoie `session.resync` avec `lastKnownRideId` — la dernière course qu'il croit
suivre, ou `null`. Le serveur répond par `session.synced`, un instantané complet de l'état
courant (`activeRideId`, `activeRideState`, `serverTime`), jamais une liste de changements
depuis la dernière position connue. Un différentiel suppose que le client sait exactement ce
qu'il a manqué ; après une coupure de durée inconnue, cette hypothèse est justement celle qui ne
tient pas.

**File locale et rejeu à l'identique.** Les actions émises hors connexion (`proposal.accept`,
`ride.track`, `position.update`, etc.) sont mises en file sur l'appareil et rejouées à la
reconnexion, dans l'ordre, **avec leur `id` d'origine** — pas un nouvel identifiant généré au
moment du rejeu. C'est ce qui permet au serveur de les traiter avec sa déduplication normale par
`id` plutôt que d'avoir besoin d'un protocole de rejeu séparé.

**Position trop ancienne : ignorée, pas rejouée.** Le serveur compare `emittedAt` à l'heure de
réception. Au-delà d'un seuil (valeur métier configurable côté service temps réel, invariant 5 —
non figée par ce contrat), un message `position.update` est silencieusement ignoré : rejouer une
position vieille de plusieurs minutes ferait apparaître un chauffeur à un endroit qu'il a
déjà quitté, ce qui est pire que ne pas savoir où il est. Les autres types de messages (actions
métier comme `proposal.accept`) n'ont pas cette règle — une acceptation vieille de trente
secondes reste une acceptation valable, sous réserve des préconditions habituelles de la
transition (proposition non expirée, etc., voir `ride-state-machine.md`).

---

## Vérifié par `test/realtime.test.ts`

- Critère d'acceptation 1 : aucun nom de message commun entre `ClientToServerMessageSchema` et
  `ServerToClientMessageSchema` ; aucun nom dupliqué au sein d'une même direction.
- Critère d'acceptation 2 : présent dans cette section (politique de reconnexion écrite,
  y compris le comportement de la file d'attente).
- Critère d'acceptation 3 : `nearby.drivers` rejette un champ en trop et plafonne à 5 chauffeurs.
- Critère d'acceptation 4 : `apps/client`, `apps/driver` et `services/realtime` n'existent pas
  encore ce soir (L0-03, L0-04, hors de ce lot pour les apps) — non vérifiable avant leur
  création. À couvrir par une règle de lint quand ces paquets existeront (L0-03/L0-04), pour
  qu'aucun de ces trois paquets ne redéclare ses propres types de message.
