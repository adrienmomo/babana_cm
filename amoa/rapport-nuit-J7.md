# Rapport de nuit — J7 (nuit du 16 août 2026)

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). Périmètre : L4-02R (rejeu D25 + correction du scénario 2 de L4-11), L3-05,
L3-06 (réservation atomique, **avec L3-13** dans la même tâche), dans cet ordre — conformément à
la consigne de cette nuit.

**État de départ vérifié** : `master` propre au lancement (`b82bdc3`, débrief J6 déjà commité).
`amoa/questions/REPONSES-2026-08-16.md` lu en entier avant d'ouvrir `babana_ride_state.py`, comme
demandé — le diagnostic de la nuit dernière (défaut de verrouillage) y est corrigé : le
verrouillage était correct, la spécification (traduction de `SerializationFailure` en
`RIDE_INVALID_TRANSITION`) était fausse.

---

## L4-02R — rejeu de transaction sur échec de sérialisation (D25)

**Fait, mais pas comme la première version écrite ce soir.** Première implémentation : un
décorateur Python (`_retry_on_serialization_failure`) rejouant la méthode de transition entière
depuis son début, avec un savepoint autour du `SELECT ... FOR UPDATE`. **Vérifiée à blanc contre
la pile réelle avant de continuer** (même geste que C2 la nuit dernière) : sans le rejeu, le
scénario 2 corrigé de L4-11 échouait bien dès la première itération (`cancel` refusé en 409 alors
qu'il aurait dû aboutir) — la spécification du défaut était confirmée. **Avec** le rejeu, le
scénario 1 (acceptation concurrente) s'est mis à échouer *différemment* : `INTERNAL_ERROR` au
lieu de `RIDE_INVALID_TRANSITION` pour les perdants.

**Cause, et pourquoi la première implémentation ne pouvait pas marcher.** Sous `REPEATABLE READ`,
l'instantané d'une transaction PostgreSQL est fixé une fois pour toutes à son ouverture, pas à
chaque requête. Rejouer le `SELECT ... FOR UPDATE` *dans la même transaction* (même via un
savepoint) retombe donc sur le même instantané périmé et échoue de nouveau, indéfiniment — un
fait sur PostgreSQL, pas un défaut d'implémentation à corriger en ajustant le code autour. Un vrai
rejeu exige une transaction neuve, donc un curseur neuf.

**Or Odoo le fait déjà.** `odoo.service.model.retrying` enveloppe **toute requête HTTP**
(`Request._transactioning`, `odoo/http.py`) et rejoue l'appel entier — curseur neuf, `env.reset()`
— sur exactement `(LockNotAvailable, SerializationFailure, DeadlockDetected)`
(`PG_CONCURRENCY_EXCEPTIONS_TO_RETRY`), borné à `MAX_TRIES_ON_CONCURRENCY_FAILURE` (5, avec
temporisation aléatoire croissante), en journalisant chaque tentative et l'épuisement final. Le
défaut du 14 août n'était donc pas seulement une mauvaise traduction : c'était une traduction qui
**cachait** l'erreur à un mécanisme de rejeu qui existait déjà, un niveau au-dessus.

**Retenu.** Décorateur supprimé. `_lock_for_update()` (`babana_ride_state.py`) laisse
`SerializationFailure` remonter telle quelle, sans la traduire ni la rattraper. `controllers/
ride.py::_dispatch` laisse `PG_CONCURRENCY_EXCEPTIONS_TO_RETRY` (importé directement d'Odoo, pas
redéclaré) traverser son `except Exception` générique au lieu de l'avaler en `INTERNAL_ERROR` —
c'est la ligne qui rend le mécanisme d'Odoo réellement atteignable. Revérifié : scénario 1 et
scénario 2 passent tous les deux, 20 itérations chacun, contre la pile réelle. Journaux Odoo
confirmés : `SERIALIZATION_FAILURE, N tries left, try again in ... sec` apparaît à chaque rejeu.

**Écart déposé : `amoa/questions/L4-02.md`, point 5**, parce que la lettre de la spécification
(« la transition réessaie... en repartant d'un instantané neuf ») pointait vers
`babana_ride_state.py` comme porteur du rejeu, alors que la seule implémentation qui fonctionne
vit à la frontière HTTP. Le comportement observable est conforme (rejeu borné, instantané neuf,
`RIDE_INVALID_TRANSITION` seulement après relecture réelle) ; seul l'endroit diffère de ce que le
texte suggérait — signalé plutôt que corrigé en silence, cette tâche étant sous revue humaine
(L4-02).

**Le scénario 2 de `test/concurrency/ride-transitions.test.ts` réécrit**, selon la rédaction déjà
corrigée dans `amoa/specs/L4-course.md` (L4-11) : ce qu'il prouve n'est plus « une seule des deux
transitions gagne » (faux : `accept` puis `cancel` est une séquence légitime) mais « l'annulation
aboutit toujours, quel que soit l'ordre, et l'état final est toujours `cancelled` ». Vérifié à
blanc dans les deux sens (voir plus haut).

**Base fraîche, `make test` complet, dédié à cette tâche** : `make reset && make up`, puis suite
Odoo (`-i babana --test-enable`), `npm test` (paquets JS/TS, `test/concurrency` scénarios 1 et 2,
`test/auth`), vérification de la machine à états — tout vert.
