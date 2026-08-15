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

---

## L3-05 — Endpoint « 5 chauffeurs les plus proches »

**Fait**, avec un écart de fond déposé avant d'écrire le code d'intégration : `amoa/questions/
L3-05.md`.

### Le géo-index complète maintenant jusqu'à 5 (correction du point relevé hier soir)

`services/realtime/src/redis/geo-index.ts::findNearby` sur-échantillonnait d'un facteur fixe
(×3) pour absorber les positions expirées — insuffisant après une coupure réseau généralisée, le
cas courant à Douala, où une majorité du pool peut être périmée en même temps. Le facteur double
maintenant et la requête est rejouée jusqu'à obtenir `limit` résultats frais ou jusqu'à ce que
Redis renvoie moins de candidats bruts que demandé (tout le rayon déjà parcouru). Test de
non-régression ajouté à `test/geo-index.test.ts` : 30 chauffeurs périmés placés délibérément plus
près que 6 chauffeurs frais — l'ancien facteur fixe aurait renvoyé zéro résultat frais sur la
première page, la nouvelle version en renvoie 5.

### L'écart : d'où viennent prénom, photo, note et gamme de moto

`nearby.drivers` doit porter des données de profil possédées par Odoo, et le service temps réel
n'a et ne doit avoir aucun client PostgreSQL (invariant 1). Aucune tâche du lot L3 ne fait
transiter ces champs vers Redis — un cousin exact du problème de configuration résolu hier par
L3-15, mais L3-15 sert `ir.config_parameter` (global), pas une donnée par enregistrement comme un
profil chauffeur. **Décision provisoire, même geste que L3-02/L3-15** : `redis/driver-profiles.ts`
(nouveau, pas dans la liste de fichiers de la spécification — même raison que `redis/positions.ts`
pour L3-02) lit un hash Redis par chauffeur. **Rien n'écrit encore cette clé en production** :
un chauffeur disponible sans profil en cache est omis de `nearby.drivers`, jamais complété par une
valeur inventée. Détail et proposition de canal dans le fichier d'écart.

### Ce qui est livré

`nearby/projection.ts` : liste blanche de champs (piège explicitement documenté par la
spécification) — chaque champ du `NearbyDriver` renvoyé est construit un par un depuis le
géo-index et le profil en cache, jamais en étalant un objet source. Position arrondie
(`http.roundToNearbyPrecision`, 4 décimales, C-02/C2b, définition unique déjà partagée avec le
contrat REST). Un chauffeur sans profil est omis.

`nearby/handler.ts` (`NearbyManager`) : un seul abonnement actif par client (indexé par
`userId`, un nouvel abonnement annule le précédent) ; rayon plafonné côté service quel que soit le
rayon demandé (`NEARBY_MAX_RADIUS_METERS`, déjà posé par L3-03) ; limitation de débit sur l'action
`subscribe` elle-même, par utilisateur, fenêtre glissante en mémoire ; diffusion périodique tant
que l'abonnement est actif (`NEARBY_BROADCAST_INTERVAL_SECONDS`) ; nettoyage automatique à la
fermeture de connexion (`ws/connection.ts`, un abonnement ne doit pas survivre à son socket).
Wiring dans `ws/dispatch.ts` (`nearby.subscribe`/`nearby.unsubscribe`, réservés au rôle client) et
`ws/connection.ts` (le dispatcher reçoit maintenant le socket, pas seulement le contexte —
nécessaire pour répondre et diffuser).

`NEARBY_BROADCAST_INTERVAL_SECONDS`, `NEARBY_RATE_LIMIT_MAX_SUBSCRIPTIONS`,
`NEARBY_RATE_LIMIT_WINDOW_SECONDS` ajoutés à `config.ts`, même bloc et même réserve provisoire que
les valeurs de L3-02/L3-03/L3-04 — condamnées par L3-15 ou son successeur, pas par cette tâche.

Tests (`test/nearby.test.ts`, contre Redis réel comme `test/geo-index.test.ts`) : rayon ramené au
plafond sans erreur (1), profil absent omis, position arrondie (3), charge utile strictement en
liste blanche — absence explicite de `lastName`/`phone`/`licensePlate`/etc., pas seulement
présence des champs attendus (4, le piège documenté), second abonnement remplace le premier (5),
limitation de débit appliquée (6). Chaque test utilise ses propres coordonnées isolées (>5 km des
autres) : les tests de ce fichier ne purgent pas entre eux, une contamination croisée aurait
faussé les comptes exacts attendus.

**Vérification sur base fraîche** : commune avec L3-06, qui la réutilise directement (le
géo-index corrigé ici sert de socle à la réservation atomique) — détail dans l'entrée suivante.
