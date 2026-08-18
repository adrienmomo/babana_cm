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
| `ride.start` | Chauffeur | `{ rideId }` | Transition `assigned → in_progress` |
| `ride.complete` | Chauffeur | `{ rideId, distanceMeters, durationSeconds, polyline }` | Transition `in_progress → completed` |
| `nearby.subscribe` | Client | `{ position, radiusMeters }` | S'abonne à `nearby.drivers` |
| `nearby.unsubscribe` | Client | `{}` | Se désabonne |
| `ride.track` | Client | `{ rideId }` | S'abonne au suivi d'une course affectée ou en cours |
| `session.resync` | Client ou chauffeur | `{ lastKnownRideId }` | Voir « Politique de reconnexion » |

`radiusMeters` de `nearby.subscribe` est borné à 50 km dans le schéma — un garde-fou anti-abus
au niveau du contrat, pas la valeur métier du rayon de recherche réel, qui reste configurable
côté service temps réel (invariant 5).

## Messages émis par le serveur (`server-to-client.ts`)

| Message | Destinataire | Payload | Rôle |
|---|---|---|---|
| `proposal.new` | Chauffeur | `{ rideId, origin, destination, amount, distanceMeters, expiresAt }` | Nouvelle proposition |
| `proposal.expired` | Chauffeur | `{ rideId }` | Délai d'acceptation dépassé |
| `ride.cancelled` | Chauffeur et/ou client | `{ rideId, reason? }` | La course a été annulée |
| `cash.limit.warning` | Chauffeur | `{ balance, limit }` | Avertissement avant `CASH_LIMIT_REACHED` |
| `nearby.drivers` | Client | `{ drivers: NearbyDriver[] }` (max 5) | Réponse à `nearby.subscribe`, puis mises à jour |
| `nearby.subscribe.ack` | Client | `{ accepted: true }` ou `{ accepted: false, retryAfterMs }` | Accusé de réception de `nearby.subscribe` |
| `ride.proposed` | Client | `{ rideId, driverId, proposalExpiresAt }` | Le chauffeur choisi a été réservé |
| `ride.assigned` | Client | `{ rideId, driverId }` | Le chauffeur a accepté |
| `ride.rejected` | Client | `{ rideId, driverId, reason }` | Le chauffeur a refusé ou le délai a expiré |
| `driver.position` | Client | `{ rideId, position }` | Suivi pendant une course affectée ou en cours |
| `ride.started` | Client | `{ rideId }` | Transition `→ in_progress` |
| `ride.completed` | Client | `{ rideId, distanceMeters, durationSeconds, amount }` | Transition `→ completed` |
| `session.synced` | Client ou chauffeur | `{ activeRideId, activeRideState, serverTime }` | Voir « Politique de reconnexion » |

`ride.cancelled` a un seul émetteur (le serveur) mais deux destinataires possibles selon qui est
concerné par la course — le critère d'acceptation 1 de C-02 porte sur l'émetteur, pas sur le
nombre de destinataires ; il n'exige pas deux noms de message distincts pour un même événement
poussé à deux connexions différentes.

`ride.rejected` porte `driverId` et `reason` (`'driver_rejected' | 'driver_timeout'`) depuis le
23 août (L6-08, `amoa/questions/L3-07.md`) — absents de la première rédaction, alors que L3-07
(critère 2) promettait déjà au client « un motif distinct de l'expiration » sans le lui donner.
`driverId` permet à L6-08 d'écarter précisément ce chauffeur de la liste réaffichée ; `reason`
permet de ne pas confondre un chauffeur qui refuse explicitement d'un chauffeur qui ne répond
pas, deux situations que le client ne vit pas de la même façon.

`nearby.drivers` réutilise exactement le schéma `NearbyDriver` de C-01 (`GET /drivers/nearby`,
`packages/contracts/src/http/driver.ts`) : même `.strict()`, mêmes champs, une seule définition
pour la règle « aucune donnée personnelle au-delà du prénom, de la photo, de la note et de la
gamme de moto » (critère d'acceptation 3). Position arrondie à 4 décimales (~11 m à l'équateur),
constante partagée `NEARBY_POSITION_PRECISION_DECIMALS` dans `packages/contracts/src/http/common.ts`
— utilisée par le REST et le WebSocket, une seule source pour C2b.

`nearby.subscribe.ack` (23 août — amoa/questions/REPONSES-2026-08-23.md §2) répond à **chaque**
`nearby.subscribe`, accepté ou refusé pour limitation de débit. Avant ce message, un abonnement
refusé ne produisait rien : un client qui insistait sur « Réessayer » pouvait cesser d'être servi
sans qu'aucun élément ne le lui dise. Un refus porte toujours `retryAfterMs` — un refus sans délai
serait inexploitable côté client.

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
`ride.start`, `position.update`, etc.) sont mises en file sur l'appareil et rejouées à la
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
