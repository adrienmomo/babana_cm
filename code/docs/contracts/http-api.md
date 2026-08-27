# API mobile ↔ Odoo — HTTP v1

Documentation lisible du contrat C-01. La source de vérité est le code TypeScript de
`packages/contracts/src/http/` — ce document en est la projection humaine (D17). En cas de
divergence entre ce fichier et le code, le code a raison ; ouvrir une correction ici.

Schémas JSON pour les contrôleurs Odoo (Python) : générés par `npm run build` dans
`packages/contracts/dist/json-schema/`, un fichier `<endpoint>.request.json` et
`<endpoint>.response.json` par endpoint, plus `errors.json` pour le catalogue.

---

## Conventions générales

**Préfixe** : `/api/v1`, figé (voir « Versionnement » ci-dessous).

**Authentification** : en-tête `Authorization: Bearer <accessToken>` sur tous les endpoints
**sauf** `POST /auth/google`, `POST /auth/refresh` et `POST /auth/logout` — ces trois routes
s'authentifient par le jeton transmis dans le corps de la requête (`idToken` ou `refreshToken`
selon le cas), pas par l'en-tête. Un `accessToken` déjà expiré est précisément ce qui amène un
client à appeler `/auth/refresh` ; l'exiger valide sur cette route la rendrait inutilisable au
moment où elle sert (écart relevé en implémentant L1-02, `amoa/questions/L1-02.md`).

**Format** : JSON en requête et en réponse, `Content-Type: application/json` — sauf
`POST /driver/documents` (L1-05), en `multipart/form-data` (voir sa section).

**Idempotence** (L4-03, critère d'acceptation 6) : en-tête `Idempotency-Key`, optionnel, sur
tout endpoint mutant. Un appel rejoué avec la même clé renvoie la réponse du premier appel sans
réappliquer la transition — seules les transitions réellement appliquées sont mises en cache
côté serveur (`babana.idempotency.record`) : un échec métier n'a rien appliqué, le rejouer est
sans risque. Convention choisie faute d'une existante dans ce contrat pour HTTP — voir
`amoa/questions/L4-03.md`.

**Erreurs** : toute réponse non-2xx a la forme

```json
{ "error": { "code": "QUOTE_EXPIRED", "message": "…", "details": null } }
```

`code` vient du catalogue de la section [Catalogue d'erreurs](#catalogue-derreurs) — jamais un
message brut ou un code HTTP nu. Deux codes sont possibles sur **tout** endpoint sans être
répétés dans chaque section : `VALIDATION_ERROR` (corps de requête invalide) et
`INTERNAL_ERROR`. `UNAUTHORIZED` est possible sur tout endpoint authentifié (tous, sauf
`/auth/google`).

### Versionnement

`/v1` est figé. Toute rupture de compatibilité (suppression de champ, changement de type,
changement de sémantique d'un champ existant) crée `/v2` sans toucher `/v1`. Une app installée
sur le téléphone d'un chauffeur ne se met pas à jour à la demande — elle peut rester des mois sur
`/v1` pendant que le back-office évolue. Ajouter un champ optionnel à une réponse n'est pas une
rupture ; le rendre obligatoire l'est.

### Durée de validité d'une estimation

`POST /quote` renvoie `expiresAt`. Passé ce délai, `POST /rides` refuse la création avec
`QUOTE_EXPIRED` — sans quoi un client pourrait estimer à 6h du matin (tarif creux) et commander
à 18h (heure de pointe) au tarif du matin.

---

## Authentification — `auth.ts`

### `POST /auth/google`

Échange l'ID token Google contre un jeton applicatif (D4). Seul endpoint public de ce contrat.

- Requête : `{ idToken: string, role: 'client' | 'driver' }` — `role` détermine, au premier appel
  seulement, s'il faut créer un `babana.driver` ou rattacher un `res.partner` (rien d'autre dans
  le jeton Google ne le permet ; champ ajouté par L1-01, écart documenté dans
  `amoa/questions/L1-01.md`)
- Réponse : `{ accessToken, refreshToken, expiresIn, user: { id, role, displayName, photoUrl, phoneVerified } }`
- Erreurs : `INVALID_GOOGLE_TOKEN` (jamais `DRIVER_NOT_APPROVED` — un chauffeur non approuvé
  reçoit tout de même un jeton, avec un statut `pending` explicite ; ce sont les endpoints
  métier qui refusent ses actions, pas l'authentification, L1-01 critère 8)

### `POST /auth/refresh`

- Requête : `{ refreshToken: string }`
- Réponse : identique à `/auth/google`
- Erreurs : `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHORIZED`

### `POST /auth/logout`

- Requête : `{ refreshToken: string }`
- Réponse : `{ revoked: true }`
- Erreurs : `UNAUTHORIZED`

### `GET /me`

Profil de l'utilisateur courant (D35, 22 août). N'existait pas avant D35 : le profil figurait
dans la liste des « lectures secondaires » réservées au JSON-RPC natif d'Odoo (§5 de
`01-architecture.md`), qui n'accepte pas le jeton applicatif — Odoo y authentifie par session de
cookie ou par identifiants explicites. Toutes les lectures mobiles passent désormais par des
contrôleurs `/api/v1` explicites, celle-ci comprise.

- Requête : aucune
- Réponse : `{ id, role, displayName, photoUrl, phoneVerified, driverStatus? }` — le même objet
  que le champ `user` d'une session (`AuthenticatedUserSchema`, une seule définition)
- Erreurs : aucune au-delà des erreurs implicites (`UNAUTHORIZED`, `TOKEN_EXPIRED`)

---

## Numéro de téléphone — `phone.ts`

Un seul OTP dans la vie du compte, au rattachement (01-architecture.md §5) — pas à chaque
connexion.

### `POST /phone/verify/start`

- Requête : `{ phoneNumber: string }` (E.164, Cameroun : `+237[6-9]XXXXXXXX`)
- Réponse : `{ verificationId, expiresIn }`
- Erreurs : `PHONE_ALREADY_VERIFIED`, `RATE_LIMITED`

### `POST /phone/verify/confirm`

- Requête : `{ verificationId, code }` (code à 6 chiffres)
- Réponse : `{ phoneVerified: true }`
- Erreurs : `OTP_INVALID`, `OTP_EXPIRED`, `PHONE_ALREADY_VERIFIED`

---

## Estimation — `quote.ts`

### `POST /quote`

- Requête : `{ origin: LatLng, destination: LatLng, promoCode?: string }`
- Réponse : `{ quoteId, amount, currency: "XAF", distanceMeters, etaSeconds, expiresAt }`
- Erreurs : `PROMO_CODE_INVALID`

`distanceMeters` et `etaSeconds` sont calculés sur un modèle voiture (É8) — l'ETA affiché à
l'utilisateur passe par un facteur de correction côté application (L10-03), pas par ce contrat.

---

## Cycle de vie de la course — `ride.ts`

Chaque endpoint ci-dessous correspond à une transition de
[`ride-state-machine.md`](./ride-state-machine.md) (C-03). Les préconditions détaillées et les
écritures Odoo associées y sont décrites ; elles ne sont pas redupliquées ici.

**D31 (amoa/questions/REPONSES-2026-08-18.md §3) : acceptation et refus n'ont plus de route HTTP
publique.** Seul chemin d'écriture désormais : `proposal.accept` / `proposal.reject` en temps réel
(C-02), résolus atomiquement côté service temps réel, puis écrits dans Odoo par le canal interne
(`/api/internal/rides/{id}/driver-accepted` / `driver-rejected`, jamais exposé publiquement). Le
reste de ce tableau a dérivé de l'avancement réel depuis sa rédaction initiale (L4-03) — en cas de
doute, le code (`packages/contracts/src/http/`) a raison, pas cette colonne.

| Endpoint | Transition | Erreurs spécifiques | Implémenté |
|---|---|---|---|
| `POST /rides` | `draft → requested` | `QUOTE_EXPIRED`, `QUOTE_NOT_FOUND` | Oui |
| `POST /rides/{id}/select-driver` | `requested → proposed` ou `rejected → proposed` | `RIDE_NOT_FOUND`, `RIDE_NOT_OWNED`, `RIDE_INVALID_TRANSITION`, `DRIVER_ALREADY_TAKEN`, `DRIVER_NOT_APPROVED` | Oui |
| `POST /rides/{id}/start` | `assigned → in_progress` | `RIDE_NOT_FOUND`, `RIDE_INVALID_TRANSITION`, `DRIVER_NOT_IN_PROPOSAL` | Oui |
| `POST /rides/{id}/complete` | `in_progress → completed` | `RIDE_NOT_FOUND`, `RIDE_INVALID_TRANSITION`, `DRIVER_NOT_IN_PROPOSAL` | Oui |

`POST /rides/{id}/complete` ne porte **que la décision** (J24, `amoa/questions/L6-13.md`) : le
corps est vide, l'app dit « terminée » et rien d'autre. Le relevé du trajet (distance parcourue,
durée, tracé) vient du service temps réel qui l'a accumulé pendant la course (L3-10), jamais de
l'app. La réponse porte `{ ..., distanceMeters, durationSeconds, measured }` : `distanceMeters` /
`durationSeconds` sont **`null`** quand `measured` est faux — course terminée sans accumulation
disponible, aucune distance ni tracé enregistrés, écart de distance de L4-04 non calculé
(D30, D43).
| `POST /rides/{id}/cancel` | `{requested,proposed,assigned,rejected} → cancelled` | `RIDE_NOT_FOUND`, `RIDE_NOT_OWNED`, `RIDE_INVALID_TRANSITION` | Oui |
| `POST /rides/{id}/rate` | (aucune — ride déjà `settled`) | `RIDE_NOT_FOUND`, `RIDE_NOT_OWNED`, `RATING_NOT_ALLOWED`, `RATING_ALREADY_SUBMITTED` | Non — attend L4-09 |

Exemple — `POST /rides/{id}/select-driver` :

Requête :
```json
{ "driverId": "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b" }
```

Réponse (`201`) :
```json
{
  "id": "11111111-2222-4333-8444-555555555555",
  "state": "proposed",
  "origin": { "latitude": 4.0511, "longitude": 9.7679 },
  "destination": { "latitude": 4.0611, "longitude": 9.7861 },
  "amount": 1200,
  "currency": "XAF",
  "createdAt": "2026-08-10T07:00:00+01:00",
  "assignedDriverId": "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
  "proposalExpiresAt": "2026-08-10T07:00:30+01:00"
}
```

Les exemples complets de chaque endpoint (requête et réponse) sont dans le code source, à côté
de chaque schéma — c'est la version qui ne peut pas diverger de l'implémentation, puisqu'un
test (`test/http.test.ts`) valide chaque exemple contre son schéma à chaque exécution.

---

## Caisse — `settlement.ts`

### `POST /rides/{id}/settle`

Transition `completed → settled`. Espèces uniquement (D9).

- Requête : `{ amountCollected: MoneyAmount }`
- Réponse : `{ rideId, state: "settled", amountCollected, driverCashBalance }`
- Erreurs : `RIDE_NOT_FOUND`, `RIDE_INVALID_TRANSITION`, `DRIVER_NOT_IN_PROPOSAL`, `SETTLEMENT_AMOUNT_MISMATCH`, `CASH_LIMIT_REACHED`

### `GET /drivers/me/cash`

- Réponse : `{ balance, limit, collectedToday }`
- Erreurs : `DRIVER_NOT_APPROVED`

`limit` est une valeur métier en base (D21, invariant 5) — jamais codée en dur dans le service.

---

## Remise de caisse — `remittance.ts`

### `POST /remittances`

- Requête : `{ amount: MoneyAmount }`
- Réponse : `{ id, amount, status: "pending" | "validated" | "rejected", driverCashBalance }`
- Erreurs : `DRIVER_NOT_APPROVED`

La validation par un superviseur est un flux back-office Odoo natif, hors de ce contrat mobile.

---

## Chauffeurs — `driver.ts`

`GET /drivers/nearby` a figuré ici au premier jet de C-01 (les 5 chauffeurs les plus proches,
D14) puis a été retiré du contrat, jamais implémenté : la découverte des chauffeurs proches se
fait entièrement par `nearby.subscribe` / `nearby.drivers` (C-02, `realtime-events.md`), un flux
WebSocket qui tient la liste à jour pendant que le client compare, ce qu'un `GET` ne ferait
jamais. Voir `amoa/questions/C-01R.md` §1. La forme partagée (`NearbyDriver`, garde-fous C2b :
réponse plafonnée à 5, schéma `.strict()`) reste définie dans `driver.ts` et sert désormais
uniquement `nearby.drivers`.

### `POST /drivers/me/availability`

- Requête : `{ online: boolean }`
- Réponse : `{ online: boolean }`
- Erreurs : `DRIVER_NOT_APPROVED`

---

## Documents chauffeur — `documents.ts`

Permis et pièce d'identité (L1-05, É2 -- la carte grise appartient à la flotte, pas au
chauffeur). Aucun objet n'est jamais public : toute lecture passe par une URL signée à durée
limitée.

### `POST /driver/documents`

Seul endpoint du contrat dont le corps n'est pas JSON : `multipart/form-data`, pas
`application/json` (`Content-Type` à ajuster côté app). C'est pourquoi il n'a pas de schéma de
requête généré comme les autres — voir `UploadDriverDocumentFieldsSchema` dans `documents.ts`
pour la forme des champs.

- Requête (multipart) : champ `file` (le document), plus les champs `documentType` (`'license'`
  ou `'id_card'`), `contentType` (type MIME déclaré par l'app), `expiresOn` (date ISO,
  **obligatoire si `documentType` vaut `'license'`**, critère d'acceptation 5)
- Réponse : `{ id, documentType, verificationStatus }`
- Erreurs : `VALIDATION_ERROR` (champ manquant, `expiresOn` absent pour un permis, fichier trop
  volumineux), `DOCUMENT_TYPE_MISMATCH` (le type MIME réel du fichier, détecté par signature,
  ne correspond pas à `contentType` — critère d'acceptation 4)

### `GET /driver/documents/{id}/url`

Le chauffeur pour ses propres documents, un gestionnaire pour tous les documents (L1-05) — pas
d'autre combinaison.

- Réponse : `{ url, expiresIn }` — URL signée, valide `expiresIn` secondes (critères
  d'acceptation 1 et 2 : rien n'est accessible sans cette URL, et elle expire)
- Erreurs : `DOCUMENT_NOT_FOUND`, `DOCUMENT_NOT_OWNED` (critère d'acceptation 3 : un chauffeur
  qui demande le document d'un autre chauffeur)

---

## Bouton d'urgence — `incident.ts`

L8-04 (CDC §II.6). Déclenchable par le client ou le chauffeur — l'acteur se déduit du jeton
d'authentification, jamais transmis dans le corps. Réservé aux courses `assigned`/`in_progress`
(`TOGETHER_STATES`, `babana_ride.py`) : ni avant l'affectation, ni après un état terminal.
N'interrompt jamais la course elle-même.

### `POST /rides/{id}/incidents`

- Requête : `{ latitude, longitude, triggeredAt }` — `triggeredAt` est l'horodatage d'origine posé
  côté appareil, pas celui de réception serveur (peut différer si mis en file hors connexion puis
  rejoué)
- Réponse (`201`) : `{ id, status: "open", position, triggeredAt }`
- Erreurs : `RIDE_NOT_FOUND`, `RIDE_NOT_OWNED`, `RIDE_NOT_ACTIVE`

Idempotent (en-tête `Idempotency-Key`) — c'est ce qui rend le rejeu hors connexion sûr : un
déclenchement mis en file localement, puis rejoué une fois le réseau revenu, ne crée jamais deux
incidents pour le même appui.

---

## Partage de trajet — `share.ts`

L8-03 (CDC §II.6). Réservé au client de la course. La page publique qu'un proche ouvre
(`https://babana.cm/s/{token}`) **n'est pas un endpoint de ce contrat** : elle est servie
directement par le service temps réel (`services/realtime/src/share/handler.ts` et `page.ts`),
sans authentification — c'est le jeton lui-même, opaque et non devinable, qui tient lieu
d'autorisation. Sa liste blanche de champs (position, ETA, destination, prénom du chauffeur,
gamme) est appliquée côté Odoo (`controllers/internal.py::resolve_share`), jamais par ce service.

### `POST /rides/{id}/share`

Crée un jeton de partage, ou reprend celui déjà actif pour cette course (un client qui rouvre
l'écran ne doit pas invalider un lien déjà envoyé par SMS).

- Réponse (`201`) : `{ token, url, expiresAt }` — `url` est l'adresse complète, apex jamais
  sous-domaine ; `expiresAt` est `null` tant que la course est active
- Erreurs : `RIDE_NOT_FOUND`, `RIDE_NOT_OWNED`, `RIDE_NOT_ACTIVE`

### `POST /rides/{id}/share/revoke`

Révocation immédiate. Idempotent : révoquer un jeton déjà révoqué, ou en l'absence de tout jeton
actif, réussit sans effet.

- Réponse : `{ revoked: true }`
- Erreurs : `RIDE_NOT_FOUND`, `RIDE_NOT_OWNED`

---

## Catalogue d'erreurs

Généré depuis `errors.ts` dans `dist/json-schema/errors.json`. Reproduit ici pour lecture rapide.

| Code | Statut HTTP | Description |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Corps de requête hors schéma |
| `INTERNAL_ERROR` | 500 | Erreur inattendue côté serveur |
| `RATE_LIMITED` | 429 | Trop de requêtes |
| `INVALID_GOOGLE_TOKEN` | 401 | ID token Google invalide |
| `TOKEN_EXPIRED` | 401 | Jeton applicatif expiré |
| `TOKEN_REVOKED` | 401 | Jeton applicatif révoqué |
| `UNAUTHORIZED` | 401 | En-tête Authorization manquant ou malformé |
| `DRIVER_NOT_APPROVED` | 403 | Compte chauffeur non validé |
| `PHONE_ALREADY_VERIFIED` | 409 | Numéro déjà rattaché et vérifié |
| `PHONE_NOT_VERIFIED` | 403 | Action nécessitant un numéro vérifié |
| `OTP_INVALID` | 400 | Code OTP incorrect |
| `OTP_EXPIRED` | 410 | Code OTP expiré |
| `QUOTE_EXPIRED` | 410 | Estimation expirée |
| `QUOTE_NOT_FOUND` | 404 | Estimation inconnue |
| `PROMO_CODE_INVALID` | 400 | Code promo invalide |
| `RIDE_NOT_FOUND` | 404 | Course inconnue |
| `RIDE_INVALID_TRANSITION` | 409 | Transition interdite depuis l'état courant |
| `RIDE_NOT_OWNED` | 403 | Course n'appartenant pas à l'appelant |
| `NO_DRIVER_AVAILABLE` | 404 | Aucun chauffeur disponible dans le rayon |
| `DRIVER_ALREADY_TAKEN` | 409 | Chauffeur réservé entre-temps (réservation atomique) |
| `DRIVER_NOT_IN_PROPOSAL` | 403 | Chauffeur ne correspond pas à la proposition active |
| `PROPOSAL_EXPIRED` | 410 | Délai d'acceptation dépassé |
| `RATING_ALREADY_SUBMITTED` | 409 | Course déjà notée |
| `RATING_NOT_ALLOWED` | 403 | Notation impossible avant `settled` |
| `CASH_LIMIT_REACHED` | 409 | Plafond d'encaisse dépassé |
| `SETTLEMENT_AMOUNT_MISMATCH` | 400 | Montant déclaré ≠ montant dû |
| `LOCATION_REQUIRED` | 400 | Position requise et absente |
| `DOCUMENT_NOT_FOUND` | 404 | Document chauffeur inconnu |
| `DOCUMENT_NOT_OWNED` | 403 | Document n'appartenant ni à l'appelant ni consultable par lui |
| `DOCUMENT_TYPE_MISMATCH` | 400 | Type MIME réel du fichier différent du type déclaré |

`NO_DRIVER_AVAILABLE` figure au catalogue par exigence de la spécification C-01 mais n'est émis
par aucun endpoint de ce lot : le client compose lui-même sa sélection à partir de
`nearby.drivers` (D10, C-02, `realtime-events.md`), qui diffuse une liste vide plutôt qu'une
erreur s'il n'y a personne à proximité. Il resterait utilisable si un endpoint de matching
automatique était réintroduit (hors périmètre v1, §6 de `03-decoupage-taches.md`).
