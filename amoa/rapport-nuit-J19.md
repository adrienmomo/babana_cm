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
