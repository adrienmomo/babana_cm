# Écart — `/api/v1/quote` refuse le préflight CORS depuis l'export web (23 août 2026)

Trouvé en vérifiant le parcours complet dans un navigateur (`verify.localhost`, D43 corrigé ce
soir), pas dans le périmètre de cette nuit (correctifs D43/D44, nettoyage du contrat, L4-12) —
consigné plutôt que corrigé à la volée sur du code hors périmètre, conformément au protocole.

## Constaté

Sur l'export web (`apps/client`, `npm run build:web`, servi par le montage jetable de vérification
à `https://verify.localhost`), une fois la recherche de lieu réparée (D43) : session client réelle
restaurée, chauffeur réel en ligne visible sur `HomeScreen` (`nearby.drivers`), point de départ et
d'arrivée réels sélectionnés par `PlacePicker` — **la correction de ce soir en train de fonctionner
dans un vrai navigateur**. Le blocage suivant, jamais atteint les nuits précédentes (D43 bloquait
avant) :

`QuoteScreen` affiche « L'estimation a échoué. Réessayez. ». Réseau (`read_network_requests`) :
`OPTIONS https://api.localhost/api/v1/quote` → **401**, avant même que la vraie requête `POST` ne
parte. Chrome bloque alors l'appel réel côté client (échec de préflight CORS), sans que le
contrôleur `POST /api/v1/quote` (`controllers/quote.py`) ne soit jamais atteint.

## Cause identifiée, pas corrigée

Aucun fichier de `services/odoo/addons/babana` ne déclare de gestion CORS (`grep -ri cors` : aucun
résultat). `controllers/quote.py::_ROUTE` ne porte que `"methods": ["POST"]`, aucune route
`OPTIONS` associée. La requête `OPTIONS` de préflight, sans le futur en-tête `Authorization`
(les navigateurs ne l'envoient jamais au préflight lui-même, seulement dans
`Access-Control-Request-Headers`), échoue avec 401 — cohérent avec une pile d'authentification qui
s'applique avant toute résolution de méthode, plutôt qu'une réponse `405 Method Not Allowed`
werkzeug ordinaire.

Ce défaut touche vraisemblablement tout `/api/v1/*` et `/api/internal/*` de la même façon (aucune
route de `controllers/` ne déclare de gestion CORS) — pas seulement `/quote`, simplement le premier
appel POST authentifié atteint par le parcours réel.

## Pas allé plus loin

**Hors du périmètre de cette nuit** (D43/D44/nettoyage du contrat/L4-12), et surtout hors de la
portée naturelle de ces tâches : en production, l'app Client est React Native, jamais un
navigateur — CORS n'y a aucun sens, il n'existe que pour l'export web (D22), dont le déploiement
réel est explicitement porté par **L6-18** (« hors de ce soir », `apps/client/webpack.config.js`,
plusieurs commentaires de ce dépôt le nomment déjà comme le porteur naturel de ce genre de point).

Construire une réponse CORS ce soir aurait été improviser, en fin de nuit, une décision qui a de
vraies implications de sécurité sur l'API authentifiée de production (quelles origines autoriser,
`Access-Control-Allow-Credentials` avec un jeton porteur, si `/api/internal/*` doit rester
totalement hors de portée d'un navigateur) — exactement le genre de raccourci que le protocole
d'écart demande de signaler plutôt que de trancher seul.

## Ce que ça n'empêche pas de conclure

**D43 est bien corrigé** : la preuve en a été faite en direct, dans un vrai navigateur, jusqu'à la
sélection du point d'arrivée inclus — plus loin qu'aucune nuit précédente (J19 bloquait avant même
d'atteindre `HomeScreen` de façon exploitable). Le nouveau blocage est un défaut différent,
préexistant, jamais rencontré avant parce que jamais atteint avant ce soir.

## Proposition

Une tâche dédiée (candidat naturel : un lot préparatoire de **L6-18**, avant le déploiement web
réel) qui pose une politique CORS explicite et réfléchie sur `/api/v1/*` — probablement pas
`/api/internal/*`, qui ne doit jamais être exposé à un navigateur (`REALTIME_SHARED_SECRET` n'a de
sens qu'entre serveurs, invariant 5). À trancher : liste blanche d'origines (le domaine web de
production, `verify.*`/`localhost` en développement) plutôt qu'un `Access-Control-Allow-Origin: *`
qui n'a pas de sens sur une API à jeton porteur.
