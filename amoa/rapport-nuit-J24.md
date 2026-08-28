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

---

## Correctif de contrat 2 — la réponse d'encaissement dit ce qui s'est passé

### L'écart de L6-14, tranché

Franchir le plafond d'encaisse n'est pas une erreur : `action_settle` réussit, le chauffeur passe
hors ligne dans la même transaction (L5-02), et `SettleRideResponse` ne le disait pas. L'écran
`SettlementScreen` devait donc **comparer** le nouveau solde à un plafond qu'il allait chercher par
un **second `GET /drivers/me/cash`**. Troisième application de D49 en trois jours : là où l'app
devine, il manque un champ.

### Ce qui a été fait

- **Contrat** : `SettleRideResponseSchema` gagne `cashLimit` (MoneyAmount), `cashLimitReached`
  (bool) et `marginRemaining` (`max(0, cashLimit − driverCashBalance)`).
- **Odoo** : `action_settle` renvoie désormais `{"ride": self, "cash_limit_crossed": bool}` — la
  valeur **réelle** calculée par `_babana_apply_cash_limit`, jamais une reconstitution.
  `_settle_ride` la porte dans la réponse, avec le plafond et la marge lus dans la même
  transaction. Le `driverCash` (`GET /drivers/me/cash`) disparaît du chemin d'encaissement de
  l'app.
- **App** : `SettlementScreen` lit `settled.cashLimitReached` / `.marginRemaining` directement.
  Plus aucun second appel, plus aucune inférence. La bannière « vous êtes passé hors ligne » +
  accès remise s'affiche sur `cashLimitReached`, pas sur une comparaison locale.

### Tests

- `packages/contracts/test/http.test.ts` : l'exemple de réponse valide le nouveau schéma.
- Odoo : `test_settlement.py` (`action_settle` renvoie `cash_limit_crossed` juste, franchi /
  sous le plafond) ; `test_ride_controller.py` (`test_full_happy_path_up_to_settled` assert les
  trois nouveaux champs ; `test_settle_response_announces_crossing_the_cash_limit` — 200,
  `cashLimitReached: true`, `marginRemaining: 0`, chauffeur hors ligne).
- App : `SettlementScreen.test.tsx` — solde et marge viennent de la réponse de `settle` sans
  second appel ; `cashLimitReached` annonce le hors-ligne ; sous le plafond, marge affichée,
  bouton « Terminé ».
- e2e : `endpoint-coverage.test.ts` — `settleRide` valide la réponse contre son schéma.

`amoa/questions/L6-14.md` : **points 1 et 2 résolus** (arbitrage REPONSES-2026-09-01 §2). Point 3
(file hors connexion persistante) reste L6-16, non commencée.

### Doute pour quelqu'un de réel

`marginRemaining` est plafonné à 0 quand le plafond est franchi — l'écran affiche alors la
bannière, pas la marge. Un chauffeur qui voudrait savoir de *combien* il a dépassé ne l'apprend
pas ici (il le verrait à la remise). C'est un choix : « marge restante » négative se lit mal. À
revoir si le terrain montre que le chiffre exact du dépassement manque.

---

## L3-10 — accumulation distance / durée / tracé dans Redis

### L'invariant 1, tenu là où on serait tenté de le perdre

**Rien de ce qui est accumulé ici n'écrit dans Odoo.** Distance, durée et tracé vivent dans un
seul HASH Redis (`babana:ride:accumulation:<driverId>`) pendant la course, et ne rejoignent Odoo
qu'à la fin de course — une écriture, à une décision humaine (le chauffeur qui appuie sur
« Terminer »). Aucune écriture ne dépend du temps écoulé ni de la distance parcourue.

### Le mécanisme

- **`startAccumulation`** — appelé par `POST /internal/rides/started` (au commit de `action_start`,
  D32). Depuis `ride.start`, pas depuis l'acceptation.
- **`accumulatePosition`** — appelé par `tracking/ingest.ts` après **chaque position déjà
  acceptée** par la plausibilité (L3-02) : une position rejetée n'y arrive jamais (critère 2).
  - **Distance** : somme des segments, avec un filtre par **distance radiale** — un déplacement
    sous `ACCUMULATION_MIN_SEGMENT_METERS` (5 m) depuis le dernier point retenu n'accumule pas et
    n'avance pas ce point. Le bruit GPS à l'arrêt tourne autour du même point sans jamais s'en
    éloigner assez → distance 0 (critère 1) ; une moto qui rampe dans les embouteillages finit
    par franchir le seuil et accumule alors le saut entier.
  - **Tracé** : simplification au fil de l'eau, fenêtre glissante de trois points. Un sommet
    quasi colinéaire avec ses voisins est remplacé, pas empilé — une ligne droite se réduit à ses
    extrémités, une forme en L garde son coin (critère 3). Plafond dur à
    `ACCUMULATION_MAX_TRACK_POINTS` (500).
  - **Durée** : temps d'horloge depuis `ride.start` (une coupure réseau ne raccourcit pas la
    course), calculée à la lecture.
- **`GET`-sémantique `POST /internal/rides/measurement`** — lu par Odoo (`_complete_ride`)
  **avant** la transition `in_progress → completed`. `realtime_client.fetch_ride_measurement` :
  une **lecture pure**, ne modifie aucune clé Redis, donc sans risque D25/D32 — même exception
  assumée et documentée que `reserve_and_propose`. Service injoignable ou aucune accumulation →
  `None` → la course se termine quand même, `trip_measured` faux (le correctif de contrat 1).
- **`endAccumulation`** — appelé par `POST /internal/engagement/clear` (fin de course **ou**
  annulation). Un TTL de sécurité (`ACCUMULATION_TTL_SECONDS`, 6 h, rafraîchi à chaque position)
  fait expirer une accumulation orpheline.

### Restart-safe (L3-14)

Tout l'état vit dans Redis, **aucun état en mémoire du processus**. Le service temps réel peut
tomber en pleine course : au redémarrage, les positions reprennent, `accumulatePosition` relit le
HASH et continue là où il en était. Prouvé par `accumulator.test.ts` (« une coupure suivie d'une
reprise ne perd pas l'accumulation »). Un seul écrivain par nature — les positions d'un chauffeur
arrivent sur une seule connexion, traitées séquentiellement — donc pas de script Lua : ce module
n'est pas dans la liste des modules à couverture exhaustive.

### Valeurs de configuration

`ACCUMULATION_MIN_SEGMENT_METERS`, `_SIMPLIFY_TOLERANCE_METERS`, `_MAX_TRACK_POINTS`, `_TTL_SECONDS`
dans `config.ts` — PROVISOIRE au sens de D21, même écart déjà assumé que les seuils de
L3-02/L3-03/L3-04 (`amoa/questions/L3-02.md`) : devraient vivre en base (L3-15), qui n'existe pas.
Valeurs plausibles, pas arbitraires.

### Tests

- `services/realtime/test/accumulator.test.ts` (contre Redis réel) : les 4 critères numérotés
  (arrêt → distance 0 ; position rejetée jamais accumulée ; ligne droite → 2 sommets, L → 3
  sommets ; coupure/reprise), plus distance par sommation, durée d'horloge, `endAccumulation`,
  aller-retour d'encodage polyline sur l'exemple canonique Google.
- `services/realtime/test/internal.test.ts` : `started` démarre l'accumulation, `measurement` la
  renvoie, `clear` l'efface ; `measurement` d'un chauffeur inconnu → `measured: false`.
- Odoo : `test_ride_controller.py` (`_complete_ride` enregistre le relevé quand il y en a un →
  `trip_measured`, `actual_distance_km`, `track_polyline`) ; `test_realtime_commit_hook.py`
  (`fetch_ride_measurement` parse le relevé ; `None` si `measured` faux ; `None` si le service est
  injoignable — la fin de course ne doit jamais échouer pour ça).

### La fin de course honnête, bout en bout

Avec L3-10 branché, `_complete_ride` lit l'accumulation réelle. Une course dont le chauffeur a
émis des positions pendant le trajet enregistre **la distance et le tracé parcourus**. Une course
sans accumulation (service tombé au démarrage, app qui n'émet pas encore de position — L6-05
n'existe pas encore) enregistre **rien, explicitement** (`trip_measured` faux). C'est ce que la
nuit devait produire : « une course dont le trajet enregistré est celui qui a été parcouru — ou
rien, explicitement ».

### Doute pour quelqu'un de réel

**L6-05 n'existe pas encore** : l'app Chauffeur n'émet aujourd'hui **aucune** `position.update`.
Donc en pratique, jusqu'à L6-05, l'accumulation démarre à `ride.start` mais ne reçoit jamais de
position → toute course réelle se termine avec `distanceMeters = 0` et un tracé vide, `measured:
true` mais vide. Ce n'est pas faux (0 m réellement mesurés, honnêtement), mais c'est trompeur : un
résumé « 0 m » a l'aplomb d'un fait. **Faut-il, tant que L6-05 n'émet rien, renvoyer `measured:
false` quand le tracé est vide ?** Je ne l'ai pas fait — une accumulation active *est* une mesure,
même à zéro, et L6-05 est la tâche d'après. Mais c'est un cas à surveiller à la vérification
navigateur (côté chauffeur, pas de build web → l'app Chauffeur n'émet pas depuis le banc non
plus).

La simplification du tracé est réglée sur des seuils plausibles jamais mesurés sur de vraies
traces GPS de Douala (bruit, tunnels urbains, multipath). `SIMPLIFY_TOLERANCE_METERS = 8` peut se
révéler trop agressif (coins arrondis) ou trop lâche (tracé lourd) — c'est de la calibration de
pilote, comme l'ETA (L10-03).

---

## L6-05 — non entamée : arrêt après L3-10, comme prévu

Le périmètre confié autorisait explicitement l'arrêt après L3-10 si le lot ne passait pas en
entier. Je m'arrête là, en connaissance de cause :

- **L6-05 est la tâche la plus sensible du lot mobile** (« celle qui décide si un chauffeur garde
  l'application »), taille L, et son enjeu — batterie, forfait de données, service d'arrière-plan
  Android, permissions — est une **contrainte d'ingénierie native** qui ne se vérifie sur aucun
  banc de cet environnement (pas de build mobile ; L6-18 exclut explicitement l'app Chauffeur du
  web). La faire vite et sans mesure serait exactement le « tronquer en silence » que `CLAUDE.md`
  proscrit.
- Les trois tâches livrées répondent directement à ce qui était attendu ce matin : **une course
  dont le trajet enregistré est celui qui a été parcouru — ou rien, explicitement.** C'est fait,
  et vérifié contre la pile réelle (voir la passe finale). Le coût de la capture GPS (« une
  capture dont tu peux me dire ce qu'elle coûte ») est L6-05 **+** L6-17 (mesure batterie/données
  sur terminaux réels) — il ne peut pas être chiffré sans le terminal.

Ce que L6-05 devra tenir, relu dans sa spécification et dans L6-17/L6-16 : fréquence adaptative
selon la vitesse (hors ligne / immobile / en mouvement / en course), agrégation des positions
avant envoi, arrière-plan comme cas normal (service de premier plan + notification honnête), refus
de permission non bloquant, arrêt immédiat au passage hors ligne — et les points de mesure que
L6-17 exigera (elle ne mesurera que ce que L6-05 aura instrumenté).

---

## Passe finale — `make reset`, suite complète, vérification pile réelle

### `make reset` + `make up` + suites

Base jetée et reconstruite (volumes supprimés), pile rebâtie (`make up --build`, le conteneur
temps réel embarque donc le code L3-10). Sur base fraîche :

- **Suite Odoo `babana` : 464 tests, 0 échec, 0 erreur** (`-u babana --test-tags=/babana` sur la
  base fraîche installée par le premier passage). J23 était à 455 ; +9 (fin de course non
  mesurée, `fetch_ride_measurement`, réponse d'encaissement, relevé enregistré).
- **`npm test` par paquet, tous verts** : `@babana/contracts` 71, `@babana/maps` 19,
  `@babana/navigation` 4, `@babana/api-client` 66, `@babana/realtime` **187** (dont
  `accumulator.test.ts` 10 + le bloc L3-10 d'`internal.test.ts`), `@babana/client` 104,
  `@babana/driver` 69.
- **`@babana/concurrency-tests` : 28/28** contre la pile réelle — scénarios de concurrence 1/2/3,
  rejeu `select-driver`, et **C-01 critère 6** (chaque endpoint appelé contre le vrai Odoo, sa
  réponse validée par son propre schéma : `completeRide` corps vide → `measured`/nullable,
  `settleRide` → `cashLimit`/`cashLimitReached`/`marginRemaining`). Itérations réduites (6/4 au
  lieu de 20/8) pour tenir dans la session interactive : la correction est binaire, le décompte
  d'itérations sert la confiance statistique que l'intégration continue apporte.
- `make lint`, `tsc --noEmit` (tous paquets), `verify-ride-state-machine.js`,
  `verify-realtime-message-map.js` : verts.
- `make secrets-scan` : **seul le faux positif préexistant** `apps/client/webpack-stubs/react-native-keychain.web.js`
  (`babana-dev-keychain-stub`, entropie), identique à J23 — **aucun nouveau**.

### Un flake trouvé et corrigé

Sous la suite `@babana/realtime` complète, `reservation.test.ts` critère 5 (D26, « l'engagement
n'expire jamais tout seul ») échouait ~1 fois sur 3 : test sensible à l'expiration, avec un TTL de
1 s, sur la liste de validation humaine (L3-06), **non modifié cette nuit**. En isolation il passe
100 %. Cause : `accumulator.test.ts` (fichier neuf) faisait beaucoup d'écritures Redis réelles sur
le DB 0 partagé, décalant la fenêtre de course. Correctif (commit à part) : `accumulator.test.ts`
utilise une DB Redis logique dédiée + `flushdb` par test — toujours un vrai Redis. **Suite
complète relancée 5 fois : 5/5 vertes.**

### Vérification pile réelle — les deux côtés, jusqu'à l'encaissement

Sonde fidèle (jamais commitée, comme le banc de J23) contre la pile réelle : vrai `POST
/auth/google`, vrai WebSocket `/rt/ws`, vrais endpoints `/api/v1/*`, vrai Odoo lu en JSON-RPC.
**Client** (session + parcours d'estimation) et **chauffeur** (WebSocket réel : la précondition
C-03 posée par un vrai `nearby.subscribe`).

Une course jouée de bout en bout :

- `quote` (550 FCFA, 3437 m de référence) → `createRide` → `select-driver` → `proposal.new` →
  **`proposal.accept` → `proposal.accepted`** (D49) → `ride.assigned` (client).
- `POST /start` → `ride.started` (client). Le chauffeur émet **23 `position.update` réelles** le
  long d'un trajet en L (~308 m parcourus, pas 3437 m à vol d'oiseau).
- **`POST /complete` avec un corps vide** → 200, `measured: true`, **`distanceMeters: 308`** —
  le trajet en L réellement parcouru, **pas** la ligne droite de référence. `ride.completed`
  (client) porte la même distance. Odoo : `trip_measured` vrai, `actual_distance_km = 0.308`,
  `track_polyline` enregistré (l'accumulation a simplifié le L à ~3 sommets — correct).
- **`POST /settle`** → 200, la réponse porte `cashLimit = 50000`, `cashLimitReached = false`,
  `marginRemaining = 49450` — **aucun second `GET /drivers/me/cash`**.

**Le trajet enregistré est celui qui a été parcouru.** C'est ce qui était attendu ce matin.

### Ce qui n'a pas été fait en navigateur, dit franchement

Le bundle web du Client **compile proprement** avec les changements de contrat (garde de
non-régression — c'est ce qui masquait des pages blanches quatre nuits de suite en J21). Mais la
session a été **interrompue** (limite atteinte en cours de route) et je n'ai pas monté le banc
Caddy même-origine de J23 pour cliquer réellement les écrans Client dans un navigateur. Le
parcours a été vérifié par la sonde fidèle contre la pile réelle (ci-dessus) et par les tests
d'écran (`RideSummaryScreen` affiche « Trajet non relevé » sur `null` — testé unitairement ;
`endpoint-coverage` valide la vraie réponse d'Odoo). Le rendu des écrans Client dans un vrai
navigateur reste à refaire — c'est le seul point de la passe finale que je laisse ouvert.

---

## Qu'est-ce qui me laisse un doute pour quelqu'un de réel

**Le `measured: true` mais vide, tant que L6-05 n'émet rien.** C'est le doute central. L3-10 est
correct et vérifié avec de vraies positions — mais l'app Chauffeur n'en émet aucune aujourd'hui.
Jusqu'à L6-05, toute course réelle se termine avec `distanceMeters = 0`, `measured: true`. Le
client verrait « 0 m » sur son résumé, avec l'aplomb d'un fait. Ce n'est pas faux (0 m ont
réellement été mesurés), mais c'est le genre d'honnêteté littérale qui trompe. La bonne réponse
est L6-05 (la tâche d'après) ; en attendant, c'est un angle mort — nommé ici plutôt que masqué.

**La simplification du tracé, jamais éprouvée sur du vrai GPS.** Sur ma sonde (positions
synthétiques parfaites) le L se réduit proprement à 3 sommets. Sur une trace réelle de Douala —
bruit, multipath entre les immeubles d'Akwa, tunnels — `SIMPLIFY_TOLERANCE_METERS = 8` et
`MIN_SEGMENT_METERS = 5` peuvent lisser un vrai virage ou, à l'inverse, garder du bruit. C'est de
la calibration de pilote (comme l'ETA, L10-03), pas un défaut à corriger à l'aveugle.

**Le flake de `reservation.test.ts`.** Je l'ai contourné en isolant mon fichier neuf sur une autre
DB Redis, et la suite est verte 5/5. Mais le test lui-même reste fragile : un TTL de 1 s suivi
d'un `setTimeout(1500)` fixe perdra la course un jour ou l'autre sous une autre charge. Le vrai
correctif (attente active jusqu'à expiration observée, au lieu d'un délai fixe) touche un test de
la liste de validation humaine (L3-06) — je ne l'ai pas fait cette nuit, c'est signalé pour
arbitrage.

**La vérification navigateur du Client, non refaite** (voir ci-dessus) — la session a été
interrompue et je n'ai pas voulu bâcler le banc.

---

## Ce qui reste ouvert

- **L6-05** (capture GPS chauffeur) — non entamée, arrêt délibéré après L3-10. La plus sensible
  du lot mobile ; sans elle, l'accumulation de L3-10 tourne à vide.
- **`amoa/questions/L6-13.md`** — premier point résolu (fin de course = décision seule). **Second
  point toujours ouvert** : pas de bouton d'appel du client faute d'un numéro au contrat (même
  écart symétrique que `L6-09.md`).
- **`amoa/questions/L6-14.md`** — points 1 et 2 résolus. **Point 3** (file hors connexion
  persistante) reste L6-16, non commencée.
- **`reservation.test.ts` critère 5** — fragile (TTL 1 s + délai fixe). Contourné, pas réparé —
  le vrai correctif touche un test de validation humaine.
- **Vérification navigateur du Client** — bundle web compile ; le clic-à-travers réel des écrans
  reste à refaire.
- **L6-15** (inscription chauffeur), **L3-12** (file de rejeu persistante), **L4-06** (facture),
  la passerelle SMS, la validation du plan comptable, la vérification développeur Android —
  inchangés.
