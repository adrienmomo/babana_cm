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

## L4-04 — Consolidation de fin de course

**Fait.** `models/babana_ride.py` uniquement, comme prévu par le lot : `action_complete`
(L4-02, `babana_ride_state.py`) reste inchangé — il écrivait déjà distance, durée, tracé et
montant en une seule opération (`_babana_write_transition`), ce qui couvre déjà le critère 1
(« le tracé est écrit en une seule opération »).

Ajouté : `babana.ride._babana_compute_final_amount()` — le montant final est **reporté** depuis
`estimated_amount` (déjà calculé sur la distance de référence à la cotation, L2-04/L2-05), pas
recalculé. C'est délibéré et documenté dans la méthode : comme aucune promotion ne peut encore
devenir invalide entre l'estimation et la fin de course (L2-06 hors de ce lot), le montant final
est aujourd'hui toujours égal à l'estimé — le point d'accroche existe pour que L2-06 n'ait qu'à
brancher sa résolution, pas à créer ce mécanisme. Le critère 5 (« toute différence entre estimé
et final est explicitée ») est donc vérifié par construction plutôt que par un scénario vivant
cette nuit : documenté comme tel dans `tests/test_ride_completion.py`, pas laissé implicite.

Ajouté aussi : `distance_deviation_flagged` (champ calculé, stocké), vrai quand `state` est
`completed`/`settled` et que `|distance_deviation_km|` dépasse un seuil configurable
(`babana.distance_deviation_threshold_km`, défaut 2 km, provisoire D21, à confirmer par L10-05).
Un signalement, jamais une correction automatique (critère 3) — le flag est la trace durable, un
`_logger.warning` la trace immédiate pour le suivi opérationnel.

`tests/test_ride_completion.py` : cinq tests couvrant les cinq critères d'acceptation
directement sur le modèle (`action_complete` appelé à la main, comme `test_ride_state_machine.py` —
L4-03R, plus bas, le fait de nouveau via l'API HTTP).

---

## L4-03R — `POST /rides` et `POST /rides/{id}/complete`

**Fait.** `controllers/ride.py` étendu (pas de nouveau fichier) : sept endpoints sur neuf du
contrat ce soir, cinq restants — voir `amoa/questions/L4-03.md`, toujours à jour pour
`settleRide`/`rateRide` (compte courant chauffeur et notation, tous deux hors de ce lot).

`POST /rides` (`createRide`) : résout l'estimation par son `quoteId`, vérifie qu'elle appartient
à l'appelant et n'a pas expiré (`QUOTE_EXPIRED`/`QUOTE_NOT_FOUND` — une estimation d'un autre
client est traitée comme introuvable, pas comme un défaut d'appartenance distinct, le contrat ne
prévoyant pas ce troisième code), puis appelle `action_request` avec les valeurs de l'estimation
copiées telles quelles — rien n'est recalculé, c'est tout l'intérêt du gel par valeur de L2-04.

`POST /rides/{id}/complete` (`completeRide`) : réservé au chauffeur affecté
(`DRIVER_NOT_IN_PROPOSAL`, même garde que accept/reject/start), valide le corps, appelle
`babana.ride._babana_compute_final_amount()` (L4-04) puis `action_complete`.

**`_summary()` corrigé au passage** : renvoyait `0` pour `amount` tant que la course n'était pas
`completed`, avec un commentaire qui datait d'avant L2-04/L2-05 (« amount estimé vient de
L2-04/L2-05, hors de ce lot »). Renvoie désormais le montant estimé gelé avant la fin de course,
le montant final après — conforme à `createRideResponseExample` du contrat C-01 lui-même
(`amount: 1200` sur une course à l'état `requested`), qui le montrait déjà sans qu'aucun code ne
le produise.

**La traduction de la violation d'index unique en `DRIVER_ALREADY_TAKEN`** (demandée
explicitement par le prompt de ce soir) s'est révélée appartenir à `babana_ride_state.py`
(`action_propose`, L4-02), pas au contrôleur : le précédent déjà posé par `_lock_for_update()`
pour `SerializationFailure` (L4-11) traduit les erreurs PostgreSQL au niveau du modèle, dans un
savepoint, et le contrôleur connaît déjà `UserError("DRIVER_ALREADY_TAKEN")` depuis L4-03
(`_map_user_error`). Suivi ce même patron plutôt que d'en inventer un nouveau au niveau HTTP —
léger écart au découpage indicatif des fichiers de la spécification (`babana_ride_state.py`
n'était pas listé pour L4-03R), documenté ici plutôt qu'en silence. Une vraie fenêtre de course a
besoin de deux connexions réellement concurrentes pour se manifester (même limite que L4-11,
`TransactionCase` ne le permet pas) ; le mécanisme de traduction lui-même est prouvé directement
dans `test_ride_state_machine.py` en contournant le chemin rapide Python pour forcer l'écriture à
heurter l'index en base pour de vrai, sans simuler l'exception.

**Le critère 6 de L2-04, déféré, est maintenant vérifié** :
`test_create_ride_from_quote_carries_zones_and_fare_rule` (`test_ride_controller.py`) confirme
que la course créée depuis une estimation porte `pickup_zone_id`, `dropoff_zone_id`,
`fare_rule_id` et `quote_id`.

Une course est désormais menable de `requested` à `completed` par l'API mobile —
`test_full_happy_path_up_to_completed` le parcourt en entier.

---

## L3-01 — Authentification des connexions WebSocket

**Non commencée cette nuit.** Le lot des quatre premières tâches (L2-04, L2-05, L4-04, L4-03R)
a représenté davantage de lecture et de vérification que prévu — en particulier la vérification
sur base fraîche (voir plus bas), qui a coûté plus de temps que les nuits précédentes parce
qu'une réinstallation complète depuis un volume vide réinstalle **toutes** les dépendances
d'Odoo (`base`, `mail`, `hr`, `account`), pas seulement `babana` : plusieurs minutes contre
quelques secondes sur une base déjà initialisée. Conforme à la consigne du soir (« si tu sens
que le lot ne passera pas en entier, dis-le plutôt que d'accélérer ») : cinq tâches finies et
bâclées valent moins que quatre finies et vérifiées.

**Ce qui reste à faire pour L3-01** : lire `amoa/specs/L3-temps-reel.md` (L3-01, L3-02, L3-04
déjà lus cette nuit pour préparer le lot), lire `services/realtime/src/ws/connection.ts` et
`services/realtime/src/ws/token.ts` (squelette déjà posé par L0-04) pour voir ce qui existe déjà
avant d'écrire `services/realtime/src/ws/auth.ts`. Le point d'attention du prompt de ce soir
reste entier pour la prochaine session : le contexte de connexion (identité, rôle) doit être
immuable, et aucun message entrant ne peut redéfinir l'identité de son émetteur.

---

## Vérification sur base fraîche (définition de fini, point de la nuit dernière)

`make reset` puis `make up` puis suite complète, deux fois :

1. **Suite Odoo, base fraîche** (première installation, toutes les dépendances Odoo comprises) :
   **0 échec, 0 erreur, 265 tests** (`babana` seul, contre 250 sur une base déjà installée la
   veille — 15 tests de plus, ceux ajoutés cette nuit). Un défaut préexistant et non lié à cette
   nuit (`TestBabanaToken.test_rotate_produces_new_pair_and_invalidates_old`) était apparu sur
   l'ancienne base (15 h d'accumulation) et **a disparu sur la base fraîche** — confirmation
   directe de l'avertissement du 12 août dans `CLAUDE.md` : une base accumulée masque ou invente
   des défauts qu'une base fraîche ne reproduit pas. Pas d'investigation plus loin puisqu'il ne
   s'est pas reproduit et qu'il est hors du périmètre de cette nuit.
2. **`npm test`** (paquets JS/TS, y compris `test/concurrency` de L4-11 contre la pile réelle) :
   **0 échec** — scénarios 1 et 2 passent, scénario 3 toujours volontairement ignoré
   (`POST /rides/{id}/settle`, L4-05/L5-01).
3. **`npm run typecheck --workspaces`** et **`npm run lint --workspaces`** : verts sur tout
   l'arbre.

---

## Ce que je ferais ensuite

- **L3-01**, en tête de la prochaine session — tout le travail de lecture préalable est fait
  cette nuit, il ne reste qu'à écrire.
- **Arbitrer `amoa/questions/L2-04.md`** : les extensions de `quote.ts` (vehicleClass, breakdown,
  promoApplied, ROUTE_UNAVAILABLE) méritent d'être relues et, si acceptées, consignées comme
  décision dans `amoa/01-architecture.md` plutôt que de rester une question ouverte.
- **L2-06 (promotions)** devient plus visible qu'avant : deux points d'accroche l'attendent
  maintenant (`babana.quote.promo_applied`, `babana.ride._babana_compute_final_amount`), tous
  deux déjà en place et prêts à être branchés.
- Le reste du lot L3 (géo-index, réservation atomique, suivi) et L4-05/L5-01 (encaissement, sous
  revue humaine) restent le gros du travail avant une course démontrable de bout en bout côté
  temps réel.
