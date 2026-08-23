# Rapport de nuit — J17

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-25.md` lu en entier avant d'ouvrir quoi que ce
soit. Périmètre : C-01R d'abord — rien d'autre ne comptait tant que ce n'était pas fait — puis
l'extension de contrat (D41), puis L3-09.

---

## C-01R — les trois défauts enchaînés, plus la suite qui manquait

Les quatre pièces demandées, dans l'ordre du rapport de J16.

### 1. Cartographie des dates, puis sérialiseur unique (D40)

Avant de toucher quoi que ce soit : recherche exhaustive de tout endroit où une date part
d'Odoo vers le contrat mobile (`grep -rn "isoformat"` sur tout `services/odoo/addons/babana`,
hors tests). Trois occurrences, dans deux contrôleurs : `quote.py::expiresAt` (portait déjà, par
chance, son propre `+ "Z"` local — c'est cette divergence de traitement, pas son absence totale,
qui avait laissé `POST /rides` seul à échouer), `ride.py::createdAt` et
`ride.py::proposalExpiresAt` (les deux nus, la cause du défaut C-01).

**Un point unique** : `_common.iso_datetime(value)`, qui suffixe `Z` et renvoie `None` pour une
date absente (jamais une chaîne inventée pour un champ optionnel). Les trois points d'appel
convertis pour l'utiliser, y compris celui de `quote.py` qui fonctionnait déjà par hasard — sans
ça, la prochaine date ajoutée aurait eu une chance sur deux d'oublier le suffixe, invisible à la
lecture (c'est exactement ce qui s'est produit ici).

**Fichiers.** `services/odoo/addons/babana/controllers/_common.py` (le sérialiseur),
`ride.py`, `quote.py` (les trois points d'appel).

**Vérifié.** Suite Odoo complète de `TestRideController`/`TestQuoteController` (31 tests) verte ;
`node -e` contre le vrai `zod` du dépôt confirme que `"...T....673009Z"` passe
`IsoDateTimeSchema`.

### 2. Classification du rejeu : une `ZodError` n'est jamais réseau

`packages/api-client/src/http/client.ts::request()` traitait toute erreur qui n'est pas une
`ApiError` comme réseau, donc rejouable — correct pour un `fetch` qui lève avant toute réponse,
faux pour une `ZodError` de validation de réponse, qui survient *après* que la requête a
pleinement réussi. Corrigé : `error instanceof ZodError` court-circuite en `retryable = false`,
avant le test `instanceof ApiError`.

**Test de régression écrit d'abord, vu échouer, puis corrigé** (politique de non-régression,
CLAUDE.md) : `packages/api-client/test/http/client.test.ts`, réponse 200 délibérément malformée
(`drivers: 'not-an-array'`) — avant le correctif, 4 tentatives et aucun réessai empêché ; après,
une seule tentative, l'erreur remonte `ZodError` telle quelle. Vérifié à blanc en stashant le
correctif : le test échoue exactement comme attendu (L3-13, « à vérifier une fois, sinon il ne
prouve rien », appliqué par analogie à un correctif plutôt qu'à un mécanisme de concurrence).

**Fichiers.** `packages/api-client/src/http/client.ts`,
`packages/api-client/test/http/client.test.ts`, `packages/api-client/package.json` (`zod` en
dépendance directe — déjà transitive via `@babana/contracts`, mais désormais importée
directement ici, D17 étendu par précaution à cette dépendance explicite).

### 3. Idempotence Odoo : ce n'est pas l'écriture du cache qu'il faut protéger, c'est la clé

**Diagnostiqué avant d'être corrigé**, comme demandé. Reproduit d'abord la scène exacte du
rapport de J16 (rejeu séquentiel avec la même `Idempotency-Key`) contre la vraie pile : aucun
défaut — le mécanisme existant (chercher en cache, sinon exécuter puis écrire) fonctionne très
bien pour un rejeu séquentiel, ce qui n'était donc *pas* la cause du 500 observé en navigateur.

**La vraie cause, trouvée en reproduisant une vraie concurrence** (`curl` en parallèle, même clé,
client fraîchement inscrit pour écarter toute pollution d'un test précédent) : deux requêtes
portant la même clé, envoyées en même temps, manquent *toutes les deux* le cache (ni l'une ni
l'autre n'a encore commité), exécutent *toutes les deux* la transition, et la seconde à écrire le
cache heurte la contrainte unique — 500, alors que la transition a déjà été appliquée deux fois.
Exactement le défaut que D26 nomme pour le pool de chauffeurs (« ce n'est pas la réservation qu'il
faut rendre atomique, c'est le pool »), ici retrouvé sur un mécanisme entièrement différent
(le cache d'idempotence Odoo, pas Redis) — une lecture suivie d'une décision n'est jamais atomique,
quel que soit le magasin.

**Corrigé par réservation atomique de la clé, avant tout appel à `handler`** :
`claim_idempotency_slot` tente un `INSERT` (savepoint, même patron que
`babana_ride_state.py::action_propose` pour `DRIVER_ALREADY_TAKEN`) ; la contrainte unique sert de
verrou — un `INSERT` concurrent sur la même clé bloque jusqu'au `COMMIT`/`ROLLBACK` de l'autre,
jamais un échec immédiat pendant qu'elle est encore en vol. Une `IntegrityError` ici signifie donc
forcément que l'autre requête a déjà commité : sa réponse est en base, jamais à moitié écrite.
`resolve_idempotency_slot`/`release_idempotency_slot` complètent ou effacent la réservation selon
que `handler` a réellement appliqué une transition (200–299) ou non — un échec métier ou une
exception laisse la clé rejouable, comme l'exigeait déjà le mécanisme précédent.

Centralisé dans `_common.run_idempotent(endpoint, handler)`, appelé identiquement par
`ride.py::RideController._dispatch` et `remittance.py::RemittanceController._dispatch`, qui
dupliquaient auparavant le même code lecture-puis-écriture — DRY appliqué à un mécanisme partagé
par tous les endpoints d'écriture, pas seulement les deux qui l'utilisaient déjà.

**Fichiers.** `services/odoo/addons/babana/controllers/_common.py` (le mécanisme),
`ride.py`, `remittance.py` (les deux points d'appel, réduits à un seul appel chacun).

**Vérifié.** Reproduit le défaut (500 systématique) sur la pile réelle avant correctif, corrigé,
revérifié : 5 requêtes concurrentes, même clé, client fraîchement inscrit → une seule course
créée, les 5 réponses identiques au caractère près. Suite Odoo complète de
`TestRideController` (24 tests) et `TestRemittanceController` (4 tests) vertes après le
changement.

### 4. La suite qui manquait — critère 6 de C-01

`test/http-contract/endpoint-coverage.test.ts` : chaque endpoint du contrat appelé contre le vrai
Odoo, par le vrai `@babana/api-client` (sous-chemin `dist/http`, pas l'entrée principale du
paquet — celle-ci réexporte `./auth`, pensé pour Metro/React Native, que `tsx`/esbuild ne sait pas
transformer hors de ce contexte), sa réponse validée par `endpoint.responseSchema.parse` — la même
validation que le client applique en production, jamais une réponse fabriquée par le test.

**La liste des endpoints se dérive du contrat**, jamais tenue à la main : une boucle sur
`Object.keys(http.HTTP_ENDPOINTS)` exige que chaque clé apparaisse soit dans `EXERCISES` (une
fonction d'exercice réelle), soit dans `NOT_YET_IMPLEMENTED` (une exclusion documentée, avec sa
raison) — jamais dans aucun des deux, jamais dans les deux à la fois. Un endpoint ajouté sans
l'un ou l'autre fait échouer ce fichier au chargement, avant qu'un seul test ne s'exécute — même
discipline que `_ACTION_BY_TRANSITION` pour L4-10. Les quatre exclusions
(`rateRide`, `phoneVerifyStart`, `phoneVerifyConfirm`, `nearbyDrivers`) sont elles-mêmes vérifiées
à l'exécution : chacune doit encore répondre 404 aujourd'hui, sinon la suite le signale plutôt que
de laisser l'exclusion mentir silencieusement.

**Dix-sept endpoints réellement exercés**, avec leurs préconditions réelles quand il y en a —
`selectDriver`/`startRide`/`completeRide`/`settleRide` construisent un chauffeur réellement
approuvé, réellement en ligne (WebSocket, `test/http-contract/helpers/realtime-ws.ts`, même
patron que `services/odoo/addons/babana/tests/_realtime_ws.py` côté Python transposé en
TypeScript avec le `WebSocket` natif de Node) et réellement montré au client via `nearby.drivers`
avant la sélection (précondition C-03, L3-17). `uploadDriverDocument` et
`driverDocumentSignedUrl` parlent en `fetch` brut (multipart, que `createHttpClient` ne sait pas
faire), puis valident quand même avec le schéma exporté par le contrat — le critère 6 tient même
hors du client générique.

**C'est cette suite qui aurait attrapé C-01** : lancée contre le code d'avant ce soir (fuseau nu),
`createRide`/`selectDriver`/`startRide`/`completeRide`/`settleRide` échouent tous à
`responseSchema.parse` — exactement le défaut que six semaines de suites vertes n'avaient jamais
vu.

**Fichiers.** `test/http-contract/endpoint-coverage.test.ts`,
`test/http-contract/helpers/realtime-ws.ts`, `test/concurrency/helpers/odoo-session.ts`
(`mintGoogleToken` exporté, seul changement à un fichier existant), `test/package.json`,
`test/tsconfig.json`.

**Vérifié.** 20/20 tests verts contre la pile réelle (`make up`), y compris la vérification à
blanc du point précédent.

### Vérification navigateur, jusqu'au bout

Demandée explicitement. Faite contre la pile réelle, sur un montage jetable à une seule origine
(Caddy, `http://verify.localhost`, en clair — Chrome traite `*.localhost` comme un contexte
sécurisé même sans TLS, ce qui évite d'avoir à faire confiance à l'autorité locale de Caddy dans
le navigateur ; jamais commité, retiré avant ce commit). Deux écarts d'outillage de développement
trouvés en le faisant, aucun des deux nouveau au sens où ils bloquaient déjà le parcours avant ce
soir — consignés dans `amoa/questions/C-01R.md` plutôt que contournés en silence : la recherche de
lieu ne route nulle part en développement (bloquait toute désignation de point sans compte Google
réel), et `GET /drivers/nearby` n'a jamais été implémenté (vestige du contrat, la découverte réelle
passe entièrement par `nearby.subscribe`, C-02).

**Ce qui a été vu, en clair** : connexion (session réelle injectée, contournant le flux OAuth web
qui n'existe pas encore, L6-18 — pas un raccourci côté serveur, l'équivalent d'un redémarrage
d'app avec une session déjà persistée), écran d'accueil avec les chauffeurs proches réellement
affichés, estimation (300 FCFA, détail décomposé, `expiresAt` suffixé accepté sans erreur — la
preuve directe que le défaut de C-01 est réparé), sélection d'un chauffeur → écran d'attente sans
la moindre « erreur inattendue », expiration du délai d'acceptation → retour à la liste avec le
chauffeur refusant exclu et une nouvelle liste de cinq affichée (L3-08), nouvelle sélection.
**Aucune erreur inattendue à aucun moment** — c'est le geste central du produit qui a échoué six
semaines, il fonctionne ce soir de bout en bout.

**Une flakiness observée, expliquée, pas un défaut** : plusieurs tentatives rapprochées de
navigation Accueil→Estimation dans la même session ont fait apparaître des listes vides alors que
le service temps réel confirmait, interrogé directement, que les chauffeurs étaient bien dans le
pool. Cause la plus probable : la limitation de débit par utilisateur de `nearby.subscribe`
(L3-05, 10 abonnements / 60 s) — mes propres essais répétés l'épuisaient. Une session fraîche a
immédiatement retrouvé un comportement stable. Rien dans le code n'a été changé pour ça : c'est le
garde-fou C2b qui fonctionne, pas un défaut du parcours.

---

## D41 — l'extension de contrat que L6-09 attend

Périmètre de spécification : `ride.assigned` porte prénom, photo, gamme et immatriculation ;
`ride.completed` porte le détail décomposé. Décidé et arbitré le 25 août
(`amoa/questions/REPONSES-2026-08-25.md` §2) — cette tâche l'implémente.

### `ride.assigned` : quatre champs nullables, un seul nouveau canal de donnée

`RideAssignedPayloadSchema` (`packages/contracts/src/realtime/server-to-client.ts`) gagne
`firstName`, `photoUrl`, `motorcycleClass` (réutilise `VehicleClassSchema` de `quote.ts` plutôt
que de redéclarer l'énumération, D17) et **`licensePlate`** — le champ que C2b interdit partout
ailleurs. Tous nullables, même raison que `NearbyDriverSchema` (D30) : un profil chauffeur
qu'Odoo n'a pas fini de synchroniser ne doit jamais retarder ni bloquer l'envoi de la confirmation
d'affectation elle-même.

**La frontière C2b ne bouge pas** : `services/odoo/addons/babana/controllers/
internal_profiles.py::_project` gagne `licensePlate` (`driver.motorcycle_id.license_plate`), mais
c'est un canal interne (authentifié par secret partagé, jamais atteignable depuis le mobile ni
Caddy) lu par deux consommateurs distincts côté temps réel — `nearby/projection.ts`, qui continue
de ne PAS lire ce champ (liste blanche explicite, inchangée), et `proposal/lifecycle.ts::accept`,
qui le lit pour la première fois, seulement au moment où le chauffeur est réellement accepté.
Même cache Redis que `nearby.drivers` (`redis/driver-profiles.ts::DriverProfile`, TTL de
fraîcheur, pas d'expiration qui perdrait un profil déjà lu) — une seule lecture Odoo, deux
projections différentes en sortie.

### `ride.completed` : le détail décomposé, pas recalculé

`RideCompletedPayloadSchema` gagne `breakdown: FareBreakdownSchema` — réutilise exactement le
schéma de `POST /quote` (D17), cohérent avec le fait que le montant final de
`POST /rides/{id}/complete` (L4-04) est celui de l'estimation gelée à la création, jamais
recalculé. Aucun point d'appel existant à mettre à jour : `ride.completed`/`ride.started` ne sont
émis nulle part encore dans `services/realtime/src` (vérifié par recherche, pas supposé) — cette
partie du contrat attend son émetteur, une tâche encore non assignée, distincte de L3-09 dont le
périmètre est le suivi de position, pas le cycle de vie de la course.

**Fichiers.** `packages/contracts/src/realtime/server-to-client.ts`,
`packages/contracts/test/realtime.test.ts` (exemples mis à jour),
`docs/contracts/realtime-events.md` (doc à jour, D17 — le contrat est du code, la doc le suit).
`services/odoo/addons/babana/controllers/internal_profiles.py`,
`services/odoo/addons/babana/tests/test_internal_profiles_controller.py` (cinq champs, pas
quatre). `services/realtime/src/redis/driver-profiles.ts`,
`services/realtime/src/proposal/lifecycle.ts` (le seul point d'appel réel de `ride.assigned`),
plus les fixtures `DriverProfile` des tests existants (`expand.test.ts`, `nearby.test.ts`,
`driver-profiles.test.ts`) étendues du champ requis.

**Vérifié.** Suite Odoo (`TestInternalProfilesController`, 7 tests) et suite `@babana/contracts`
(66 tests) vertes. Suite `services/realtime` complète (126 tests, dont deux nouveaux pour
`accept()` : profil présent avec les quatre champs, profil absent dégradé en `null`) verte deux
fois de suite contre Redis réel.

---

## Doute pour un client réel

**Le rejeu concurrent existait probablement ailleurs aussi, jamais prouvé avant ce soir.** Le
même patron lecture-puis-décision (`_dispatch` d'origine) était dupliqué mot pour mot entre
`ride.py` et `remittance.py` — les deux sont corrigés, mais je n'ai vérifié la course réelle
(requêtes concurrentes) que sur `ride.py` (createRide). Je n'ai pas reproduit la même preuve sur
`remittance.py`, en confiance sur l'identité du code plutôt que sur une nouvelle mesure — à faire
si `createRemittance` devient un point chaud en production (déclarations de fin de journée,
probablement corrélées dans le temps entre chauffeurs, pas nécessairement pour la même clé mais
la classe de défaut mérite sa propre preuve).

**`GET /drivers/nearby` reste dans le contrat sans jamais avoir été construit.** Ce n'est pas
dangereux en soi (rien ne l'appelle), mais un contrat qui documente un endpoint qui n'existe pas
est le genre d'écart qui trompe un développeur pressé — à trancher (retirer, ou construire) avant
qu'il ne soit cité comme référence par erreur.

**`ride.assigned` porte l'immatriculation dès l'affectation, jamais retirée après.** D41 dit « rien
ne change avant l'affectation » — c'est vrai à l'émission. Mais rien, côté serveur, n'efface ce
que le client a reçu une fois la course terminée ou annulée : l'app garde en mémoire (état de
navigation, pas persisté) la plaque d'un chauffeur avec qui la course est finie. Sans conséquence
tant que L6-09 (l'écran qui l'affiche) n'existe pas encore, mais la tâche qui le construira devra
décider explicitement quand cette donnée cesse d'être affichée — pas la garder par défaut parce
que rien ne l'a dit de faire autrement.

---
