# Rapport de nuit — J24

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini). `amoa/questions/REPONSES-2026-09-01.md` lu en entier avant d'ouvrir quoi que ce soit.
Périmètre confié : deux correctifs de contrat (fin de course ; réponse d'encaissement), puis
**L3-10** (accumulation distance/durée/tracé), puis **L6-05** (capture GPS chauffeur) — avec arrêt
après L3-10 si le lot ne passe pas en entier.

Branches par tâche. `make reset` et la passe complète en fin de session.

---

## Correctif de contrat 1 — la fin de course ne porte que la décision

### L'écart de L6-13, tranché

`POST /rides/{id}/complete` exigeait `{ distanceMeters, durationSeconds, polyline }` — un relevé de
trajet que l'app Chauffeur n'a aucun moyen de mesurer honnêtement (L6-05 et L3-10 absentes), alors
que L4-04 disait déjà, noir sur blanc, que ce relevé vient du service temps réel. Deux documents en
désaccord sur qui possède la donnée.

**Arbitrage appliqué.** Le corps de `complete` est **vide** (`CompleteRideRequestSchema =
z.object({})`). L'app dit « terminée », rien d'autre — c'est une décision humaine (invariant 1), et
c'est tout ce qu'elle possède honnêtement. Le stopgap `apps/driver/src/ride/completion.ts` (ligne
droite départ → arrivée, `durationSeconds` à l'horloge) **a disparu**, ainsi que son test.

### Quand rien n'a été mesuré : aucun tracé, explicitement

- **Contrat** : `CompleteRideResponseSchema` et `RideCompletedPayloadSchema` (C-02) portent
  `distanceMeters` / `durationSeconds` **nullables** + un booléen `measured`. `null` — jamais 0,
  jamais la distance de référence déguisée : une absence assumée (D30, D43).
- **Odoo** : nouveau champ `babana.ride.trip_measured` (défaut faux, figé après `completed`).
  `action_complete(*, by_driver, final_amount, measurement=None)` — `measurement` est le dict
  `{distance_meters, duration_seconds, polyline}` fourni par L3-10, ou `None`. Sans mesure, rien
  n'est écrit sur `actual_distance_km` / `actual_duration_minutes` / `track_polyline`.
- **L'écart de distance de L4-04 est désarmé sans mesure** : `_compute_distance_deviation` et
  `_compute_distance_deviation_flagged` court-circuitent quand `trip_measured` est faux — sinon
  `0 − reference_km` armait l'alerte sur *chaque* course non mesurée.
- **App Client** : `RideSummaryScreen` affiche « Trajet non relevé » quand `distanceMeters` est
  `null` — le montant, lui, reste affiché (la décision financière existe toujours, distance de
  référence). `TrackingScreen` transmet les `null` tels quels au résumé.
- Le contrôleur `_complete_ride` passe `measurement = None` explicitement, avec le commentaire qui
  nomme L3-10 comme la tâche qui branchera la lecture synchrone de l'accumulation ici.

### Tests

- `packages/contracts/test/realtime.test.ts` : `ride.completed` mesurée / non mesurée (`null` +
  `measured: false`) ; le champ `measured` absent est rejeté.
- `services/realtime/test/internal.test.ts` : `/internal/rides/completed` non mesurée → `null`,
  `measured` faux, aux abonnés.
- Odoo : `test_ride_completion.py` (fin sans mesure → aucun tracé, aucun écart armé ; montant
  toujours calculé) ; `test_ride_state_machine.py` (`action_complete` sans `measurement` ;
  `notify_ride_completed` reçoit `measured=`) ; `test_realtime_commit_hook.py` (payload nullable) ;
  `test_ride_controller.py` (corps vide → `measured: false`, `distanceMeters: null` ; un corps
  hérité est ignoré, jamais honoré).
- Apps : `ActiveRideScreen.test.tsx` (`completeRide` avec `body: {}`), `RideSummaryScreen.test.tsx`
  (« Trajet non relevé »), `TrackingScreen.test.tsx` (`null` transmis au résumé).
- e2e : `endpoint-coverage.test.ts`, `test/concurrency/ride-transitions.test.ts` — corps vide.

`amoa/questions/L6-13.md` : **premier point résolu** (arbitrage ci-dessus). Le second (pas de
bouton d'appel du client faute d'un numéro au contrat) reste ouvert — même écart symétrique que
`amoa/questions/L6-09.md`, hors périmètre de cette nuit.

### Doute pour quelqu'un de réel

Tant que L3-10 n'est pas branché dans `_complete_ride` (tâche suivante de cette nuit), **toute**
course réelle se termine avec `measured: false` — le client voit « Trajet non relevé » sur son
résumé. C'est honnête, mais c'est un état transitoire d'une seule tâche : si la session s'arrête
ici, une course jouée de bout en bout n'a pas de trajet enregistré du tout. C'est exactement ce que
L3-10 comble.
