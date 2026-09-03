# Rapport de nuit — J36

Tenu au fil de l'eau, une entrée par tâche finie. Lu en entier : `CLAUDE.md` (le point 9 de la
définition de fini), `amoa/questions/REPONSES-2026-09-12.md`, `amoa/specs/L3-temps-reel.md`
(L3-12, L3-17, L3-11), `amoa/questions/L3-17.md`, `amoa/01-architecture.md` §2,
`services/realtime/src/odoo/{client,rides}.ts`, `services/realtime/src/proposal/lifecycle.ts`,
`services/odoo/addons/babana/controllers/internal.py`.

Périmètre confié : L3-12 (file de rejeu côté service temps réel) et L4-06 (facture).

---

## 1. L3-12 — la file de rejeu, et une spécification qui ne décrivait plus le dépôt

### Vérifié avant d'écrire une ligne : « quatre appels » n'en fait plus que deux

La spécification énumère quatre écritures Odoo dont le service temps réel porterait les appels
2 et 3 (affectation, fin de course). En ouvrant `controllers/ride.py::_complete_ride` avant de
supposer quoi que ce soit : la fin de course est déclenchée par l'app chauffeur **directement**
sur Odoo, qui **lit** le relevé de trajet accumulé (`fetch_ride_measurement`, l'exception déjà
documentée pour `reserve_and_propose`) avant sa propre transition — jamais un appel sortant que
ce service initierait. Seul l'appel 2 (affectation/refus) est réellement porté par
`odoo/rides.ts`. Consigné dans `amoa/questions/L3-12.md`, avec la correction proposée pour la
spécification — je ne l'ai pas corrigée moi-même, le protocole réserve ça à une demande
explicite.

Conséquence retenue : `OUTBOX_ENTRY_TYPES` (`odoo/outbox.ts`) énumère exactement
`driver-accepted`/`driver-rejected`, et `enqueueOutboxEntry` refuse à l'exécution tout type hors
de cette liste — la lecture la plus proche du critère 1 de L3-12 (« un test échoue si un
cinquième type apparaît ») compatible avec ce que le dépôt fait réellement.

### Le trou lui-même : un refus qui échouait durablement bloquait la course pour toujours

Constaté depuis le 20 août (`amoa/questions/L3-17.md`) : `reportDriverAccepted`/
`reportDriverRejected` appelaient `callOdoo` directement — trois réessais **en mémoire**, perdus
si le service redémarre. Un refus dont l'appel Odoo échouait plus longtemps que ces trois
réessais laissait la course bloquée en `proposed` pour toujours (`action_propose` n'accepte que
`requested`/`rejected` en état source).

`odoo/outbox.ts` : chaque entrée est posée dans Redis (`babana:outbox:queue`, `babana:outbox:
entry:*`) **avant** toute tentative HTTP — c'est ce qui la fait survivre à un redémarrage, le
passage périodique suivant trouve simplement une échéance déjà dépassée. `reportOutboxWrite`
persiste puis tente un envoi immédiat sans bloquer l'appelant (même contrat que l'ancien code) :
latence inchangée dans le cas courant, filet réel dans le cas dégradé. Délai croissant plafonné
(`OUTBOX_BASE_DELAY_MS`/`OUTBOX_MAX_DELAY_MS`), alerte journalisée si la file dépasse un seuil ou
qu'une entrée dépasse son nombre de tentatives (`OUTBOX_ALERT_*`) — même principe que
`driver/reconcile.ts` (répare **et** dénonce), cinq nouveaux paramètres, aucun codé en dur.

### L'idempotence : un rappel à moi-même autant qu'aux prochaines nuits

La spécification (« Odoo rejette silencieusement un identifiant déjà traité ») demandait le
mécanisme d'idempotence par en-tête `Idempotency-Key` déjà posé pour les routes publiques (L4-03,
`_common.run_idempotent`) — jamais câblé sur `controllers/internal.py`, qui ne comptait jusqu'ici
que sur `action_accept`/`action_reject` échouant proprement en `RIDE_INVALID_TRANSITION` sur un
état déjà transitionné. **Écrit dans l'écart avant d'être réellement fait** : une relecture avant
de committer a trouvé que `internal.py` n'avait pas bougé alors que `amoa/questions/L3-12.md`
l'affirmait déjà — corrigé sur-le-champ, avant tout commit, mais le noter ici parce que c'est
exactement le genre d'écart entre le dit et le fait que ce dépôt existe pour traquer. `_dispatch`
enveloppe désormais le handler dans `run_idempotent` ; sans en-tête (aucun appelant hors la file
aujourd'hui), rien ne change. Trois tests dans `test_internal_controller.py` le prouvent : un
rejeu avec la même clé renvoie la réponse mise en cache sans réexécuter la transition, un rejeu
sans clé garde l'ancien filet 409.

### Tests

`test/outbox.test.ts` (13, Redis réel + faux serveur Odoo local, même patron que
`reconcile.test.ts`) : persistance avant tentative, délai croissant (mesuré depuis l'instant de
chaque appel, pas depuis un total cumulé — la première version comparait des durées polluées par
la variance d'un aller-retour localhost et échouait au hasard), Idempotency-Key stable à travers
le rejeu, reprise après « redémarrage » simulé (aucune référence en mémoire conservée), 409
`RIDE_INVALID_TRANSITION` traité comme déjà appliqué, alertes de seuil. `test_internal_
controller.py` (+3, ci-dessus).

### Non-régression (à ce stade)

`make reset && make up`, puis `make test` en entier sur base fraîche : suite Odoo verte,
`services/realtime` 226 tests (0 échec). `make seed` inchangé par cette tâche.
