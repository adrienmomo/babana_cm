# Services simulés (L0-08)

Deux services HTTP, développement uniquement (`infra/compose.dev.yaml`, jamais
`infra/compose.yaml`). Principe directeur (D19, `amoa/05-prerequis-et-simulation.md` §2) : **on
simule le fournisseur, jamais notre logique.** Le code qui vérifie un jeton ou qui appelle un
service de cartographie est identique en développement et en production ; seule l'adresse du
fournisseur change, via une variable d'environnement.

Les deux services refusent de démarrer si `NODE_ENV=production` — un service qui émettrait des
jetons signés ou des itinéraires inventés en production serait une faille de sécurité, pas une
commodité de développement.

---

## `mock-google-identity` (port 4000)

Émule Google Identity : un jeu de clés RSA publié en JWKS, et l'émission de jetons d'identité
signés dont **l'appelant contrôle tous les champs**. Le contrôleur d'authentification (L1-01,
hors du lot de cette nuit) devra vérifier une vraie signature RS256 contre ce jeu de clés,
exactement comme il le ferait contre le vrai Google — seule `GOOGLE_JWKS_URL` change.

### `GET /.well-known/jwks.json`

Jeu de clés publiques, généré au démarrage du conteneur (une nouvelle paire à chaque
redémarrage — les jetons émis avant un redémarrage ne sont plus vérifiables après, ce qui est
acceptable en développement).

### `POST /token`

Corps JSON, tous les champs optionnels (valeurs par défaut d'un jeton valide sinon) :

```json
{
  "sub": "identifiant du sujet",
  "email": "adresse email",
  "email_verified": true,
  "aud": "identifiant client OAuth attendu",
  "iss": "https://accounts.google.com",
  "exp": 1234567890,
  "invalid": "aud | exp | email_verified | signature | iss"
}
```

`invalid` est un raccourci vers l'une des cinq variantes d'invalidité exigées par le critère
d'acceptation 3 de L0-08 :

| Variante | Effet |
|---|---|
| `aud` | `aud` remplacé par un identifiant client différent |
| `exp` | jeton déjà expiré (`exp` dans le passé) |
| `email_verified` | `email_verified: false` |
| `signature` | signé par une seconde paire de clés, jamais publiée dans le JWKS |
| `iss` | `iss` remplacé par un émetteur inattendu |

Un champ explicite du corps (`aud`, `exp`, etc.) l'emporte toujours sur `invalid` — la
spécification demande que l'appelant contrôle chaque champ directement ; `invalid` n'est qu'une
commodité pour les cas les plus fréquents.

Réponse : `{ "id_token": "<jwt>", "claims": { ... } }`.

---

## `mock-maps` (port 4001)

### `GET /route?originLat=&originLng=&destLat=&destLng=`

Retourne `{ distanceMeters, durationSeconds, polyline }`. Toute paire de points — connue ou non
— reçoit une réponse **déterministe**, dérivée de la distance à vol d'oiseau (facteur route/vol
d'oiseau et vitesse moyenne, valeurs plausibles marquées provisoires, D21) : même entrée, même
sortie, toujours. `polyline` est encodée au format standard Google (précision 1e5), pour que
`packages/maps` (L6-01) puisse être développé contre un format réaliste dès maintenant.

Distance et durée sont calculées sur un modèle voiture (É8 : ni Google ni Mapbox ne calculent
d'itinéraire deux-roues au Cameroun) — ce mock reproduit cette contrainte, il ne la corrige pas.

### `GET /search?q=<texte>`

Recherche insensible à la casse et aux accents dans `fixtures/douala.json` (repères de quartiers
réels de Douala, coordonnées plausibles). `q` vide renvoie tous les repères.

### `POST /_control/fail`

`{ "enabled": true }` fait échouer `/route` et `/search` avec `503` jusqu'à
`{ "enabled": false }` — pour tester le comportement de L2-05 face à une indisponibilité de
l'API de cartographie (critère d'acceptation 4 de L0-08).

---

## Ce qui n'est pas dans ce lot

**SMS et notifications** (OTP, notifications push) sont spécifiés par L1-09 et L7-01, deux
tâches hors du lot autorisé cette nuit — non implémentés ici. Le critère d'acceptation 5 de
L0-08 (« les endpoints d'inspection permettent à un test de récupérer le dernier OTP et la
dernière notification ») ne peut donc pas être vérifié tant que ces deux tâches n'ont pas
tourné ; ce n'est pas un défaut de L0-08, seulement une dépendance qui n'existe pas encore.

Le critère d'acceptation 1 de L0-08 (scénario complet de L10-01 exécutable après `make up`) est
dans la même situation : L10-01 orchestre l'intégralité de la boucle de course, qui dépend de
dizaines de tâches non traitées cette nuit (authentification, machine à états implémentée,
service temps réel complet, applications mobiles). Ce que ce lot vérifie ce soir : les deux
services simulés fonctionnent, produisent des données plausibles et invalidables à la demande,
et refusent de démarrer en production.
