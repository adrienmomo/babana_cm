# L6-09 — la vérification navigateur bute sur un émetteur qui n'existe nulle part

Trouvé en essayant de suivre l'instruction de ce soir à la lettre : « suivre son approche, lire le
résumé », dans un navigateur, contre la vraie pile, sans contournement manuel.

## Ce qui a été vérifié en direct, et ce qui ne pouvait pas l'être

Le parcours a été suivi jusqu'à `ride.assigned` inclus, contre la vraie pile, dans un vrai
navigateur (montage jetable identique à celui de C-01R, retiré avant ce commit — voir le rapport) :
recherche de lieu (Akwa, Bonapriso — la correction 1 de ce soir, en action), estimation réelle (550
FCFA, détail décomposé cohérent), cinq chauffeurs réels via `nearby.subscribe`, sélection, refus
réel par un chauffeur scripté (`proposal.reject`), retour à la sélection avec ce chauffeur exclu
et cinq autres affichés, seconde sélection, acceptation réelle (`proposal.accept`) — `TrackingScreen`
affiche alors l'immatriculation, la gamme, l'ETA et une position qui se rapproche réellement du
point de prise en charge, avec « Position mise à jour il y a N s » qui avance seconde par seconde.
Tout cela est du vrai : vraie authentification, vrai WebSocket, vraies transitions Redis/Odoo.

Ce qui n'a **pas** pu être vérifié en direct : le passage en course (`ride.started`) et le résumé
de fin (`ride.completed`). Pas parce que `TrackingScreen`/`RideSummaryScreen` seraient en cause —
parce que **rien, nulle part dans `services/realtime/src`, n'émet ces deux messages.**

## Constaté dans le code, pas supposé

`services/realtime/src/ws/dispatch.ts` le documente lui-même : « Les types non encore traités par
ce lot (`ride.start`, `ride.complete`, ...) sont ignorés silencieusement -- ce n'est pas une
erreur, seulement une fonctionnalité que les tâches suivantes ajoutent au fil de l'eau. » Un
chauffeur scripté ce soir qui envoie `ride.start` / `ride.complete` (les messages WebSocket que le
contrat définit, `packages/contracts/src/realtime/client-to-server.ts`) ne produit donc
strictement aucun effet.

Le vrai chemin de production, lui, passe par HTTP : `POST /rides/{id}/start` et
`POST /rides/{id}/complete` (`services/odoo/addons/babana/controllers/ride.py`, exercés avec succès
par `test/http-contract/endpoint-coverage.test.ts`). Mais `services/realtime/src/http/internal.ts`
n'a de route que pour l'affectation (`/driver-accepted`, D31) — aucune pour le démarrage ni la fin
de course. Autrement dit : Odoo transitionne bien `babana.ride` vers `in_progress` puis
`completed`, mais **rien ne le répercute vers le service temps réel**, donc rien ne pousse
`ride.started` / `ride.completed` au client. Les deux chemins possibles (WebSocket direct, ou point
d'accroche interne HTTP au commit comme D31) mènent au même constat : aucun des deux n'existe.

**Ce n'est pas nouveau, et déjà noté** : `amoa/rapport-nuit-J17.md` (§L3-09, « Fichiers ») le
disait déjà : « `ride.completed`/`ride.started` ne sont émis nulle part encore dans
`services/realtime/src`... cette partie du contrat attend son émetteur, une tâche encore non
assignée, distincte de L3-09 ». Ce soir en apporte la première conséquence concrète et visible :
tant que cet émetteur n'existe pas, `TrackingScreen` reste bloqué en phase d'approche pour
toujours, et `RideSummaryScreen` est purement et simplement inatteignable par le parcours réel —
côté client comme côté chauffeur, aucune app ne peut aujourd'hui terminer une course de bout en
bout.

## Pourquoi ce soir ne l'a pas construit

Deux raisons, pas une hésitation :

1. **Hors du périmètre confié** — la consigne de ce soir nommait D19, l'endpoint fantôme, et L6-09
   (avec L6-10/L4-09 à lire en dépendance). Aucune mention de cet émetteur, qui n'a même pas
   d'identifiant de tâche.
2. **Sensible** — il touche exactement les points D31/D32/D33 que ce dépôt traite avec le plus de
   précaution (point d'accroche au commit, jamais depuis un savepoint, jamais un second chemin
   d'écriture). L'improviser en fin de nuit, sans le lire dans une spécification dédiée ni le
   soumettre à la revue que ce genre de code appelle, serait exactement le contournement que la
   consigne de ce soir demandait d'éviter.

## Ce qui reste à trancher

Une tâche à part entière, qui manque au découpage (`03-decoupage-taches.md`) : un point
d'accroche au commit sur `action_start` et `action_complete` (même patron que D31 pour
`action_accept`), qui notifie le service temps réel, qui pousse `ride.started` / `ride.completed`
au client déjà abonné (`ride.track`, L3-09, déjà en place et déjà vérifié ce soir). Sans elle,
L6-09 reste correct mais **inatteignable** par le parcours réel au-delà de l'affectation — et
l'application Chauffeur (pas commencée) en aura besoin symétriquement pour ses propres écrans de
course en cours.

**Doute pour un client réel, le plus important de la nuit** : ce n'est pas une chose que
l'affichage peut compenser. Sans cet émetteur, une course commandée ce soir en pilote resterait
« affectée » pour toujours aux yeux du client, quoi que fasse réellement le chauffeur.
