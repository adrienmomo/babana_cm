# Rapport de nuit — J19

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-27.md` lu en entier avant d'ouvrir quoi que ce
soit. Périmètre confié : L3-19 (l'émetteur manquant), C-02R (la cartographie des messages), puis
L3-18 (l'unification de l'état Redis) si le reste tient.

---

## L3-19 — l'émetteur du cycle de vie de course vers le client

### Ce qui a été vérifié avant d'écrire une ligne

`action_start`/`action_complete` (`babana_ride_state.py`) : **aucun des deux ne porte de
savepoint**, vérifié en lisant le fichier, pas supposé — le rapport de la nuit précédente et le
message de cette nuit affirmaient le contraire pour `action_complete` (« elle en porte un »).
C'était faux, et l'écrire d'abord dans ce fichier plutôt que de le découvrir en silence est
exactement ce que `CLAUDE.md` demande (« une dépendance supposée absente se vérifie dans le
dépôt, jamais dans le prompt » — vaut aussi pour une dépendance supposée présente). Conséquence
directe : D33 ne s'applique pas ici par construction, il n'y a rien à protéger d'un savepoint qui
n'existe pas — documenté dans le code plutôt que passé sous silence, pour que la prochaine
relecture n'ait pas à le redécouvrir.

### Le câblage

Même patron que `notify_cash_limit_reached` (D33, `action_settle`) : l'appel sortant vit **dans**
la méthode de transition elle-même (`babana_ride_state.py`), pas dans le contrôleur — cohérent
avec ce que ce fichier fait déjà pour un cas voisin, plutôt qu'avec `clear_engagement` (appelé
depuis `controllers/ride.py`). `realtime_client.notify_ride_started`/`notify_ride_completed`
enregistrent leur appel via `env.cr.postcommit.add(...)`, jamais pendant (D32).

`ride.completed` porte le détail décomposé **gelé à la création** (D41) : reconstruit depuis
`fare_rule_snapshot` (JSON stocké par `POST /quote`), jamais recalculé sur la distance réellement
parcourue. La fonction de mise en forme pour le fil (`_round_breakdown_for_wire`) vivait dans
`controllers/quote.py` — déplacée vers `services/pricing.py` (`round_breakdown_for_wire`, pure,
sans dépendance Odoo) pour que le modèle puisse la réutiliser sans faire dépendre un modèle d'un
contrôleur (mauvais sens de dépendance). `controllers/quote.py` l'importe désormais de là, comme
avant, à l'identique.

**Identité du client** : `babana.ride.client_id` est un `res.partner`, jamais un `res.users` — le
seul objet qui porte `babana_public_id` (l'identifiant exposé aux apps, C-01). Nouvelle méthode
`babana.ride._babana_client_public_id()` (`babana_ride.py`) fait le pont par une recherche sur
`partner_id`. Dégrade en silence (retourne `None`, l'émission est alors sautée) si aucun compte
n'est rattaché — le cas de toutes les fixtures de test qui créent un partenaire directement sans
passer par `/auth/google` ; jamais le cas d'une vraie course.

Côté service temps réel : deux nouvelles routes internes, `POST /internal/rides/started` et
`/completed` (`http/internal.ts`), qui reçoivent `clientUserId`/`driverId` **directement d'Odoo**
plutôt que de les retrouver via `tracking/session.ts` — Odoo les connaît déjà
(`client_id`/`driver_id`), et une lecture de session aurait introduit une dépendance d'ordre avec
`/internal/engagement/clear` (même requête HTTP, `_complete_ride`) sans rien apporter. Poussé aux
deux destinataires (client ET chauffeur) via `ConnectionRegistry`, exposé depuis
`ws/connection.ts` exactement comme `proposals` l'est déjà — même instance, même raison.

### Ce qui a manqué en testant, et pourquoi ça compte plus que le code lui-même

**Un test `HttpCase` de bout en bout, écrit puis abandonné, pour la bonne raison.** Première
tentative : ouvrir une vraie connexion WebSocket, appeler `POST /start` puis `/complete` par le
vrai chemin HTTP, vérifier la réception de `ride.started`/`ride.completed`. Le test échouait sans
la moindre erreur ni le moindre avertissement — dix secondes de silence. Cause, trouvée en lisant
`odoo/sql_db.py` : `--test-enable` enveloppe **toute** requête HTTP, y compris celles qu'`HttpCase`
sert réellement, dans un `TestCursor`, dont `commit()` vide `postcommit` **sans l'exécuter**.
Aucun test Odoo, `HttpCase` compris, ne peut donc jamais prouver qu'un appel accroché au commit
part réellement sur un vrai aller-retour HTTP. Ce n'est pas propre à ce soir : `clear_engagement`
(L3-17) n'a jamais eu ce genre de preuve non plus, personne ne l'avait remarqué faute d'avoir
cherché à l'obtenir.

Documenté dans `code/docs/odoo-pitfalls.md` (nouvelle entrée), avec la règle qui en découle : la
preuve d'un effet accroché à `cr.postcommit` se compose en trois, jamais en un seul test bout en
bout —

1. **le point d'accroche** (rollback n'appelle jamais, commit appelle exactement une fois) contre
   un `_FakeEnv`/`_FakeCursor` qui reproduit fidèlement `commit()`/`rollback()`
   (`test_realtime_commit_hook.py`, même patron que les tests déjà existants pour
   `clear_engagement` — `notify_ride_started`/`notify_ride_completed` ajoutées à `GATED_CALLS`,
   couvertes par le même balayage AST anti-savepoint) ;
2. **le câblage** (`action_start`/`action_complete` appellent la bonne fonction, avec les bons
   arguments) par `patch.object`, dans un `TransactionCase` ordinaire
   (`test_ride_state_machine.py`, quatre nouveaux tests, dont un qui prouve la dégradation
   silencieuse sans compte lié et un qui prouve la dégradation silencieuse sans
   `fare_rule_snapshot`) ;
3. **la livraison réelle** (le client ET le chauffeur reçoivent le message, un tiers n'importe
   quoi), côté service temps réel lui-même, contre un Redis et des WebSocket réels
   (`services/realtime/test/internal.test.ts`, deux nouveaux scénarios).

Les trois preuves composées couvrent ce qu'un unique test bout en bout promettait sans jamais
pouvoir le tenir.

### Vérifié dans un navigateur (critère 5) — partiellement, et pourquoi

Montage jetable identique à C-01R/J18 (`verify.localhost`, Caddy, jamais commité — retiré avant ce
commit, `git status` vérifié après coup). Bloqué deux fois avant même d'atteindre l'écran
d'accueil : le certificat local de Caddy n'était approuvé par aucun profil Chrome de cette machine
(je ne modifie pas de réglage de confiance système moi-même — l'utilisateur l'a fait, avec son
propre mot de passe/Touch ID) ; une fois débloqué, un second défaut, réel et hors périmètre, a
empêché d'aller plus loin par l'écran : la recherche de lieu de l'export web appelle l'API Google
réelle au lieu de `mock-maps`, malgré une configuration qui semble correcte à la lecture — détaillé
et consigné dans `amoa/questions/L6-06-recherche-web-appelle-google.md`, pas corrigé ce soir
(hors périmètre confié).

**Ce qui a quand même été vérifié en direct, contre la vraie pile, dans le vrai navigateur** :
session client réelle injectée (même geste qu'un redémarrage d'app avec une session persistée),
un chauffeur réel visible dans `nearby.drivers` sur l'écran d'accueil. Le reste du cycle a été
produit par API réelle (même session que celle du navigateur) plutôt que par la saisie manuelle
bloquée par le défaut ci-dessus : `POST /quote`, `POST /rides`, `POST /rides/{id}/select-driver`
(vrais, 200), acceptation réelle par un chauffeur scripté connecté en WebSocket, **`POST /start`
puis `POST /complete` (vrais, 200 chacun, transitions `in_progress` puis `completed` confirmées)**
— pendant que le navigateur restait connecté avec la session du client de cette même course.

**Ce que ça prouve, et ce que ça ne prouve pas.** Ça prouve que `notify_ride_started`/
`notify_ride_completed` se sont déclenchés sans erreur pour une vraie transition Odoo (sinon
`POST /complete` n'aurait pas pu suivre `POST /start` sur le même chauffeur réellement engagé, et
les deux ont retourné 200). Ça ne prouve **pas**, par une observation visuelle directe dans ce
navigateur, que `ride.started`/`ride.completed` sont arrivés sur CE socket précis :
`TrackingScreen`/`RideSummaryScreen` n'ont jamais été atteints, faute de pouvoir saisir un point de
départ par l'écran. Cette dernière preuve reste donc celle des tests composés (section
précédente) et de `services/realtime/test/internal.test.ts`, qui exerce exactement ce mécanisme de
livraison (même registre, même ciblage par identité) contre un Redis et des WebSocket réels.

**Honnêtement, un doute que je n'avais pas la nuit dernière et qui reste ouvert** : je crois, sans
l'avoir vu de mes yeux dans ce navigateur précis, que le client a reçu les deux messages. La preuve
serveur est solide ; la preuve visuelle manque, et c'est la première fois depuis quatre nuits que
cette vérification ne va pas jusqu'au bout — pas à cause de L3-19, mais à cause d'un défaut
préexistant et sans rapport qu'elle a mis au jour.

### Fichiers

`services/odoo/addons/babana/services/pricing.py`, `controllers/quote.py`, `models/babana_ride.py`,
`models/babana_ride_state.py`, `services/realtime_client.py`, `tests/test_realtime_commit_hook.py`,
`tests/test_ride_state_machine.py` ; `services/realtime/src/http/internal.ts`,
`src/tracking/broadcast.ts`, `src/ws/connection.ts`, `src/server.ts`,
`test/internal.test.ts` ; `docs/odoo-pitfalls.md`.

### Doute pour un client réel

**Un, honnête, plutôt qu'aucun.** Le mécanisme est prouvé quatre fois (accroche au commit contre
`_FakeEnv`, câblage par `patch.object`, livraison contre Redis/WebSocket réels dans
`internal.test.ts`, et ce soir une vraie transition `in_progress`→`completed` déclenchée en
conditions réelles sans la moindre erreur) — mais pas par l'observation directe, dans un
navigateur, d'un écran qui affiche le résumé de fin. Un défaut préexistant et sans rapport
(`amoa/questions/L6-06-recherche-web-appelle-google.md`) a empêché d'aller jusque-là ce soir ; je
ne peux pas dire, comme les trois nuits précédentes, « je l'ai vu ». Second point, secondaire :
l'application Chauffeur ne lit encore aucun des deux messages (aucun écran ne les consomme,
`apps/driver` à peine commencée) — l'émetteur les lui pousse déjà, symétriquement, prête pour le
jour où L6-13/L6-14 existeront.

---

## C-02R — la cartographie des messages

### Le mécanisme

`docs/contracts/realtime-message-map.json` (données) + `docs/contracts/verify-realtime-message-map.js`
(vérification), chaîné après `npm test` (`package.json`, même patron que
`verify-ride-state-machine.js` pour C-03). La liste des messages à couvrir se dérive du contrat
lui-même par extraction textuelle des appels `envelopeSchema('nom', ...)` dans
`packages/contracts/src/realtime/{client-to-server,server-to-client}.ts` — jamais recopiée à la
main. Le script échoue au chargement si un message du contrat n'a pas d'entrée, si une entrée
`wired` n'a pas d'émetteur/consommateur non vides, ou si une entrée `pending` n'a pas de `reason`
— la mention explicite qu'exige le critère 5. Vérifié dans les deux sens : j'ai retiré une entrée
du fichier de données pour confirmer que le script la réclame (`"ride.started" du contrat n'a
aucune entrée..."`), remis, revérifié vert.

### Ce qui compte plus que le mécanisme : douze sur vingt-trois

**12 des 23 messages du contrat sont en attente** — pas 2 ou 3 comme je m'y attendais en commençant
(je pensais ne retrouver que `ride.started`/`ride.completed`, déjà réparés par L3-19). Le détail
complet, avec émetteur/consommateur réels ou raison de l'attente, fichier par fichier, est dans
`realtime-message-map.json` ; ce qui suit trie les douze en trois familles, parce qu'elles
n'appellent pas la même décision — voir `amoa/questions/C-02R.md` pour le détail complet et les
options.

**Sept — il manque une application, pas un câblage.** `position.update`, `availability.set`,
`proposal.accept`, `proposal.reject`, `proposal.new`, `proposal.expired` : le serveur est réel et
testé pour chacun, `apps/driver` n'existe presque pas encore (L6-05/L6-11/L6-12). `session.synced` :
émis et testé, mais aucun écran d'`apps/client` ne s'abonne à son type pour reprendre la
navigation après reconnexion (L6-16) — un routeur générique de messages n'est pas une
consommation, le cas le plus facile à manquer en relisant vite.

**Quatre — probablement des définitions obsolètes du contrat**, sans émetteur ni consommateur,
réel ou de test, nulle part : `ride.start`/`ride.complete` (le vrai chemin est HTTP, établi
depuis L3-17/L4-03, et c'est là que L3-19 accroche l'émission ce soir), `cash.limit.warning`
(L7-05, l'alerte réellement spécifiée, est une notification push, pas ce message), `ride.proposed`
(déjà connu du client de façon synchrone par la réponse HTTP de `select-driver`). Précédent déjà
posé par D31 pour `/accept`/`/reject` HTTP : une décision d'architecture semble prise ailleurs,
le contrat porte encore une définition qui la contredit en silence. Pas retiré ce soir — un
changement de `@babana/contracts` mérite une décision explicite, pas un retrait de bord de route.

**Un — un troisième trou du même genre que celui que L3-19 vient de réparer.** `ride.cancelled` :
L4-07 (annulations) transitionne réellement, relâche réservation et engagement côté Redis, mais ne
prévient jamais l'autre partie. Aucun critère d'acceptation de L4-07 ne le demandait — pas un
défaut d'implémentation, le même manque de découpage. Candidat naturel pour la priorité de la
prochaine session : L4-07R, même patron que L3-19.

### Fichiers

`docs/contracts/realtime-message-map.json`, `docs/contracts/verify-realtime-message-map.js`,
`package.json` (chaînage). `amoa/questions/C-02R.md` (le détail des trois familles, avec
proposition pour chacune).

### Doute pour un client réel

**Aucun sur le mécanisme** — il fait exactement ce qu'on lui demande, vérifié dans les deux sens.
Le doute est ailleurs, et c'est la vraie réponse à la question posée en tête de nuit : la moitié du
contrat n'a personne au bout, dans un sens ou dans l'autre, et je ne l'aurais pas su sans ce
fichier. C'est la mesure que je n'avais pas hier.

---

## L3-18 — état de course unifié côté Redis

### Arbitrage de périmètre, avant tout code

Le script d'éligibilité lisait quatre clés (en ligne, réservation, engagement, plafond
d'encaisse) ; le contexte de la spécification ne nomme que trois structures à unifier —
réservation (L3-06), engagement (L3-07), session de suivi (L3-09). « En ligne » et « plafond
d'encaisse » n'y figurent pas, et sont des états indépendants d'une course. Mais le critère 6 dit
« le script ne lit plus qu'un état », ce qui pouvait aussi bien vouloir dire une fusion totale.
Demandé avant d'écrire la moindre ligne, vu l'enjeu (réservation atomique) : **unifier seulement
les trois structures de course** — le script passe de quatre clés lues à trois (en ligne, plafond,
état unifié), pas à une seule lecture globale. `driver/availability.ts` et `driver/cash-guard.ts`
n'ont pas bougé.

### Ce qui a changé, et ce qui n'a délibérément pas bougé

**Un seul enregistrement Redis par chauffeur** (`ride/state.ts`, `babana:driver:ride-state:<id>`,
une HASH), remplaçant la réservation (`reservation/reserve.ts`), le marqueur d'engagement
(`driver/engagement.ts`) et la session de suivi (`tracking/session.ts`, qui vivait elle-même dans
deux clés distinctes -- `rideSessionKey(rideId)` et `driverActiveRideKey(driverId)`). Un seul
script Lua (`ride/state.lua`), quatre actions dispatchées par un paramètre -- `reserve`
(inchangée : même gate ZSCORE/ZREM sur le pool que l'ancien `reserve.lua`, c'est elle qui garantit
l'exclusivité, L3-13), `resolve` (accepte ou libère, même gate que l'ancien `resolve.lua`, pose en
plus l'index inverse `rideId -> driverId` sur acceptation), `release` (efface inconditionnellement,
remplace `releaseDriver`/`clearEngaged`/`endRideSessionForDriver`), `force-engage` (réconciliation
L3-17, inconditionnel comme l'ancien `setEngaged`).

**Les trois anciens modules (`reservation/reserve.ts`, `driver/engagement.ts`,
`tracking/session.ts`) restent en place, comme façades minces** au-dessus de `ride/state.ts` --
même signature publique qu'avant, pour qu'aucun appelant (`proposal/lifecycle.ts`,
`http/internal.ts`, `driver/reconcile.ts`) ni leurs tests n'aient à changer d'API. `reservation/
keys.ts`, `reservation/reserve.lua`, `proposal/resolve.lua` supprimés (plus aucun appelant).

**Les échéances restent distinctes**, le point que la spécification appelait « délicat » : une
réservation porte un TTL (`EXPIRE`, action `reserve`) ; un engagement n'expire jamais tout seul
(`PERSIST`, action `resolve` sur acceptation) -- testé aux deux bornes dans
`test/ride-state.test.ts`, et par le veilleur d'expiration lui-même (`startStateExpiryWatcher`,
mécanisme inchangé, seul le préfixe écouté change).

### Piège trouvé en écrivant les tests, pas en écrivant le code

`attachEngagedSession` (complète l'enregistrement engagé avec `clientUserId`/origine, appelée par
la façade `startRideSession`) supposait d'abord qu'un `resolve(..., true)` avait déjà posé
`state`/`rideId` juste avant -- exact pour l'appelant de production
(`proposal/lifecycle.ts::accept`), faux pour `test/broadcast.test.ts`, qui appelle
`startRideSession` comme fixture autonome, sans passer par `reserve`/`resolve`. Six tests de ce
fichier échouaient en silence de timeout (`TrackingManager` ne trouvait jamais la session).
Corrigé : `attachEngagedSession` établit désormais une session complète à elle seule (state, rideId,
champs de suivi, index inverse), pas seulement un complément -- et je l'ai spécifiquement re-testé
en autonome (`test/ride-state.test.ts`, "établit une session complète à lui seul") pour que ce
comportement ne redevienne pas une supposition.

### Vérifié

Critère 3, spécifiquement : `test/concurrency/reservation.test.ts` (L3-13) **n'a pas été touché**
(`git diff` vide sur ce fichier après coup) et passe -- 30×10 par défaut, puis 150×25 (3750
tentatives) pour de bon, un succès exact à chaque itération. Vérifié aussi que le test détecte
toujours une implémentation naïve : `reserve()` remplacée temporairement par un ZSCORE puis
ZREM+HSET en deux temps, le test a échoué (10 succès au lieu d'1, comme attendu), version atomique
restaurée aussitôt après, rien de la version naïve n'est resté.

`services/realtime` : 153/153, `tsc --noEmit` propre. Suite Odoo complète : 408/408 sur deux
passes consécutives sur base fraîche ; une troisième passe (au milieu de la vérification, pas sur
l'état final commité) a vu échouer un test préexistant et sans lien
(`test_notify_cancellation_async_touches_no_redis_key_if_the_transaction_rolls_back`, isolé il
passe seul) -- le service temps réel réel tourne en continu pendant ces passes et sa réconciliation
périodique (L3-17) peut courir contre les mêmes clés qu'un test qui les pose à la main sans passer
par une vraie course ; rejoué deux fois de suite ensuite, vert les deux fois. Pas creusé plus loin
faute de reproduction fiable -- même famille que le flake déjà connu et déjà mitigé
(`services/realtime`, commit "flake: sérialise l'exécution des tests"), pas une régression de
cette tâche à ma connaissance, mais je ne peux pas l'affirmer avec certitude sans l'avoir fait
flancher une seconde fois.

### Fichiers

Nouveaux : `services/realtime/src/ride/state.ts`, `src/ride/state.lua`,
`test/ride-state.test.ts`. Façades réécrites : `src/reservation/reserve.ts`,
`src/driver/engagement.ts`, `src/tracking/session.ts`. Appelants mis à jour :
`src/proposal/lifecycle.ts`, `src/driver/reconcile.ts`, `src/redis/pool-eligibility.ts`,
`src/redis/pool-eligibility.lua`. Supprimés : `src/reservation/keys.ts`,
`src/reservation/reserve.lua`, `src/proposal/resolve.lua`. Tests ajustés (façades inchangées,
seule la clé de nettoyage change) : `test/reservation.test.ts`, `test/proposal.test.ts`,
`test/cash-guard.test.ts`, `test/internal.test.ts`.

### Doute pour un client réel

**Un, et je le nomme précisément plutôt que de le lisser.** Le flake ci-dessus, vu une fois sur
trois passes complètes, jamais reproduit isolément. Je crois qu'il est préexistant (même
mécanisme, même famille qu'un flake déjà documenté), mais « je crois » n'est pas « j'ai vérifié » --
je ne l'ai pas fait flancher une seconde fois pour le prouver, contrairement à ce que ce dépôt
demande d'habitude avant d'écrire une conclusion. Le reste -- l'unification elle-même, l'atomicité
de la réservation, la distinction des échéances -- est vérifié aussi solidement que L3-06 l'a été
en son temps.
