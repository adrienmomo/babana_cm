# Rapport de nuit — J5 (nuit du 14 au 15 août 2026)

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (nouveau point 8 de la
définition de fini, `CLAUDE.md`). Périmètre : `amoa/PROMPT-NUIT-J5.md` — L2-04, L2-05, L4-04,
L4-03R, L3-01, dans cet ordre, chacune débloquant la suivante.

**État de départ vérifié** : `master` propre au lancement (le débrief J4 était déjà commité,
`21f1ae1`). Pas de branche dédiée pour les tâches de cette nuit, comme J4
(`amoa/questions/L4-03.md`).

---

## L2-04 — Endpoint de cotation, `POST /quote`

**Fait.** `models/babana_quote.py` (nouveau modèle `babana.quote`), `controllers/quote.py`,
`tests/test_quote_controller.py`. `babana.ride.quote_reference` (champ-pont) supprimé et
remplacé par `quote_id` (`Many2one` vers `babana.quote`) ; `pickup_zone_id`/`dropoff_zone_id`
ajoutés à `babana.ride`, résolus par le contrôleur à la cotation. `code/docs/bridge-fields.md`
mis à jour (les deux entrées disparaissent du tableau).

Le contrôleur résout les deux zones (`babana.zone.resolve_point`), sélectionne la règle
applicable sur la zone de **départ** (`babana.fare.rule._find_applicable_rule`), obtient la
distance de référence (L2-05), calcule (`services/pricing.py`, inchangé), applique un facteur de
correction d'ETA, et persiste l'estimation avec son détail décomposé gelé par valeur
(`fare_rule_snapshot`, JSON) — même principe que `babana.ride` (L4-01).

**Écart déposé : `amoa/questions/L2-04.md`.** Le contrat C-01 (`quote.ts`, déjà arrêté) ne
portait aucun des champs que sa propre spécification exige : ni `vehicleClass` en requête, ni
détail décomposé (`breakdown`) ou indicateur de remise (`promoApplied`) en réponse, ni code
d'erreur pour l'indisponibilité de l'API de routage. Étendu plutôt qu'arrêté (extension
strictement additive, précédent L4-03 pour `public_id`/`DRIVER_NOT_APPROVED`) : `vehicleClass`
optionnel sur `QuoteRequestSchema`, `breakdown`/`promoApplied` sur `QuoteResponseSchema`,
`ROUTE_UNAVAILABLE` (503) au catalogue. Le même fichier documente aussi deux points d'accroche
provisoires, paramétrables (invariant 5), jamais codés en dur :

- **Facteur de correction d'ETA** (`babana.eta_correction_factor`, défaut `1.0`) en attendant
  L10-03, qui calibrera sa vraie valeur sur données de pilote.
- **Code promo toujours sans effet** (`promo_applied` toujours faux) faute de `babana.promotion`
  (L2-06, hors de ce lot) — satisfait littéralement le critère 5 (jamais d'échec de cotation sur
  un code invalide) sans la vraie logique de validation.

Le détail décomposé arrondi à l'entier pour le fil JSON (XAF n'a pas de sous-unité) est calculé
de façon à ce que la somme des composantes affichées égale exactement le montant affiché —
`roundingAmount` absorbe à la fois l'arrondi au pas configuré (son rôle d'origine côté pur,
`services/pricing.py`) et l'arrondi entier d'affichage, documenté dans `controllers/quote.py`.

Le critère d'acceptation 6 (« la course créée depuis une estimation porte ses zones et sa règle
tarifaire ») ne pouvait pas être vérifié avant `POST /rides` : déféré et couvert par
`test_ride_controller.py` une fois L4-03R fait (voir plus bas), pas oublié.

**Accès (`ir.model.access.csv`)** ajoutés pour `babana.quote` et `babana.route.cache`
(manager/admin), même schéma que les autres modèles.

---

## L2-05 — Distance de référence et cache

**Fait.** `services/routing.py`, `models/babana_route_cache.py`, `tests/test_routing.py`.
`GOOGLE_ROUTING_URL` ajouté (`infra/compose.yaml`, `infra/env/.env.example`) — même mécanisme
que `GOOGLE_JWKS_URL` pour `mock-google-identity` : `mock-maps` (L0-08) en développement, une
vraie API de routage en production, aucune branche conditionnelle dans le code.

Le commentaire É8 (distance et durée sur un modèle voiture, assumé et délibéré) est au point de
calcul (`services/routing.py`, en tête de fichier). Clé de cache : coordonnées arrondies à 3
décimales (~111 m à l'équateur), gamme, heure de la journée. Durée de vie configurable
(`babana.route_cache_ttl_seconds`, défaut 3 h). Indisponibilité de l'API → `RouteUnavailable`,
traduite en `ROUTE_UNAVAILABLE` (503) par `controllers/quote.py` — jamais de distance à vol
d'oiseau silencieuse. Quota journalier suivi via `ir.config_parameter` (volume du pilote trop
faible pour justifier un modèle dédié), avec alerte loggée à l'approche du plafond
(`babana.routing_daily_quota` / `babana.routing_quota_alert_ratio`).

Tests entièrement simulés (critère 5) : `requests.get` patché directement dans
`services/routing.py` (même technique que `test_google_identity.py` pour le cache JWKS), pas
d'aller-retour réseau vers le conteneur `mock-maps` pour ces tests-là — `test_quote_controller.py`,
lui, passe par le vrai `mock-maps` en HTTP (D19 : « on simule le fournisseur, jamais notre
logique »).

---

