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
**sauf** `POST /auth/google`, qui est le seul point d'entrée public de ce contrat.

**Format** : JSON en requête et en réponse, `Content-Type: application/json`.

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

- Requête : `{ idToken: string }`
- Réponse : `{ accessToken, refreshToken, expiresIn, user: { id, role, displayName, photoUrl, phoneVerified } }`
- Erreurs : `INVALID_GOOGLE_TOKEN`, `DRIVER_NOT_APPROVED`

### `POST /auth/refresh`

- Requête : `{ refreshToken: string }`
- Réponse : identique à `/auth/google`
- Erreurs : `TOKEN_EXPIRED`, `TOKEN_REVOKED`, `UNAUTHORIZED`

### `POST /auth/logout`

- Requête : `{ refreshToken: string }`
- Réponse : `{ revoked: true }`
- Erreurs : `UNAUTHORIZED`

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

| Endpoint | Transition | Erreurs spécifiques |
|---|---|---|
| `POST /rides` | `draft → requested` | `QUOTE_EXPIRED`, `QUOTE_NOT_FOUND` |
| `POST /rides/{id}/select-driver` | `requested → proposed` ou `rejected → proposed` | `RIDE_NOT_FOUND`, `RIDE_NOT_OWNED`, `RIDE_INVALID_TRANSITION`, `DRIVER_ALREADY_TAKEN` |
| `POST /rides/{id}/accept` | `proposed → assigned` | `RIDE_NOT_FOUND`, `RIDE_INVALID_TRANSITION`, `DRIVER_NOT_IN_PROPOSAL`, `PROPOSAL_EXPIRED` |
| `POST /rides/{id}/reject` | `proposed → rejected` | `RIDE_NOT_FOUND`, `RIDE_INVALID_TRANSITION`, `DRIVER_NOT_IN_PROPOSAL` |
| `POST /rides/{id}/start` | `assigned → in_progress` | `RIDE_NOT_FOUND`, `RIDE_INVALID_TRANSITION`, `DRIVER_NOT_IN_PROPOSAL` |
| `POST /rides/{id}/complete` | `in_progress → completed` | `RIDE_NOT_FOUND`, `RIDE_INVALID_TRANSITION`, `DRIVER_NOT_IN_PROPOSAL` |
| `POST /rides/{id}/cancel` | `{requested,proposed,assigned,rejected} → cancelled` | `RIDE_NOT_FOUND`, `RIDE_NOT_OWNED`, `RIDE_INVALID_TRANSITION` |
| `POST /rides/{id}/rate` | (aucune — ride déjà `settled`) | `RIDE_NOT_FOUND`, `RIDE_NOT_OWNED`, `RATING_NOT_ALLOWED`, `RATING_ALREADY_SUBMITTED` |

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

### `GET /drivers/nearby`

Les 5 chauffeurs les plus proches (D14). Garde-fous C2b : réponse plafonnée à 5, schéma
`.strict()` — un champ en trop (nom complet, téléphone, immatriculation) fait échouer la
validation plutôt que d'être silencieusement accepté.

- Requête (query) : `{ latitude, longitude }`
- Réponse : `{ drivers: NearbyDriver[] }` (max 5), chaque élément :
  `{ driverId, firstName, photoUrl, rating, motorcycleClass, position, distanceMeters }`
- Erreurs : `LOCATION_REQUIRED`, `RATE_LIMITED`

### `POST /drivers/me/availability`

- Requête : `{ online: boolean }`
- Réponse : `{ online: boolean }`
- Erreurs : `DRIVER_NOT_APPROVED`

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

`NO_DRIVER_AVAILABLE` figure au catalogue par exigence de la spécification C-01 mais n'est émis
par aucun endpoint de ce lot : le client compose lui-même sa sélection à partir de
`GET /drivers/nearby` (D10), qui renvoie une liste vide plutôt qu'une erreur s'il n'y a personne
à proximité. Il resterait utilisable si un endpoint de matching automatique était réintroduit
(hors périmètre v1, §6 de `03-decoupage-taches.md`).
