# Rapport de nuit — J10

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-18.md` lu en entier avant d'ouvrir quoi que
ce soit. Deux blocs : d'abord débloquer et consolider (L3-16, D30, D31, D32), puis l'encaissement
mécanique (L4-05, L5-01, L5-02) si le premier bloc est fini et vert.

---

## L3-16 — Profils chauffeurs lisibles par le service temps réel, et D30

**Canal interne**, extension de l'authentification existante (`_common.authenticated_internal_call`,
même secret partagé que L3-17) plutôt qu'un second mécanisme : `controllers/internal_profiles.py`
expose `POST /api/internal/drivers/profiles`, par lot, liste blanche construite champ par champ
(jamais `driver.read()`). `firstName` vient du premier mot du nom complet de `employee_id` (aucun
champ prénom séparé sur `hr.employee` dans ce lot — choix d'implémentation non spécifié, à corriger
le jour où un vrai prénom existe). `rating` reste `None` tant que `rating_count` est à 0 (champ-pont
L1-03, [PONT — remplacé par L4-09]) : servir `0.0` aurait inventé une note. `photoUrl` toujours
`None` — aucun document de type photo de profil dans ce lot.

Côté temps réel, `redis/driver-profiles.ts` cesse d'être le hash provisoire de L3-05
(`amoa/questions/L3-05.md`, champ-pont retiré de `code/docs/bridge-fields.md` — il n'y figurait pas
explicitement, seul `driver-profiles.ts` portait la mention). `getDriverProfiles` (nouveau) reçoit
les candidats d'une requête `nearby`, lit le cache en un aller-retour Redis par candidat, et
déclenche **au plus un appel Odoo par lot** (`odoo/driver-profiles.ts`, critère 3) pour les entrées
absentes ou périmées — jamais un par chauffeur. Aucun TTL Redis sur les clés elles-mêmes : une
expiration TTL aurait fait disparaître un profil déjà lu dès qu'Odoo devient injoignable plus
longtemps que la fraîcheur voulue, l'inverse du critère 2. La fraîcheur se gère par une clé
compagnon (`fetched-at`) ; une entrée périmée déclenche une tentative de rafraîchissement, jamais
une suppression. `setDriverProfile` reste l'écrivain canonique du cache, utilisé aussi bien en
production que par les fixtures de test — un seul chemin d'écriture pour le cache, pas deux formats
différents.

**D30, la correction de fond.** L'ancienne règle — un chauffeur sans profil en cache est omis de
`nearby.drivers` — a produit un blocage total en production (aucun chauffeur réel ne portait de
profil, `amoa/questions/REPONSES-2026-08-18.md` §2). La règle elle-même était mauvaise, pas
seulement incomplète : un défaut de cache ne doit jamais retirer un chauffeur de la flotte, même
famille de panne que le marqueur d'engagement resté en place (D26). `NearbyDriverSchema` (C-01)
rend `firstName`, `photoUrl`, `rating`, `motorcycleClass` nullables ; `projectNearbyDrivers`
n'omet plus jamais un candidat, il complète les champs de profil absents par `null`. Seule
l'absence de **position** écarte un chauffeur (sans position, pas de distance) — inchangé,
`findNearby` ne renvoie que des candidats positionnés.

Conséquence en cascade : `_redis_fixture.py` (le seed Redis direct de L3-05, utilisé uniquement par
`_make_selectable_driver` dans `test_ride_controller.py`) n'a plus de raison d'exister — un
chauffeur en ligne et positionné apparaît désormais dans `nearby.drivers` sans qu'aucun profil ne
soit préchargé, exercant pour de vrai le canal L3-16 (Odoo répond avec le nom réel de l'employé de
test) plutôt que de le contourner. Fichier supprimé, usage retiré.

**Tests** : `services/realtime/test/driver-profiles.test.ts` (nouveau, faux serveur Odoo local —
même patron que `reconcile.test.ts`) couvre le lot unique, l'absence jamais inventée, le critère 2
(Odoo injoignable sert le dernier connu), la fraîcheur (pas d'appel si l'entrée est récente, appel
si périmée). `test/nearby.test.ts` : le test "omis" devient "reste présent, champs à `null`" (D30) ;
les autres adaptés à la nouvelle signature (`config` en premier argument de `projectNearbyDrivers`).
`test_internal_profiles_controller.py` (nouveau, Odoo, `HttpCase`) couvre l'authentification, les
quatre champs, le lot, la liste blanche stricte (recherche textuelle de fuite dans le JSON sérialisé),
l'absence d'un identifiant inconnu. `test_ride_controller.py` : plus de seed de profil, 19 tests du
fichier toujours verts.

`npx tsc --noEmit` (paquet `@babana/realtime`) et `npm run build -w @babana/contracts` propres.
Suite Odoo complète (`-u babana --test-enable`) : 293 tests, 1 échec —
`TestBabanaToken.test_rotate_produces_new_pair_and_invalidates_old`, artefact de base ancienne déjà
identifié le 15 août (`amoa/questions/REPONSES-2026-08-15.md`, vert sur base fraîche à chaque
vérification) ; reconfirmé sur `make reset` complet en fin de session (voir entrée de vérification
finale).

---

## D31 — un seul chemin d'écriture sur l'acceptation et le refus

`/rides/{id}/accept` et `/rides/{id}/reject` retirés de `controllers/ride.py`, de `packages/contracts/src/http/ride.ts` (schémas, types, catalogue d'erreurs, exemples — `startRideResponseExample` référence désormais un exemple `assigned` local plutôt que l'ancien `acceptRideResponseExample`) et du registre `HTTP_ENDPOINTS` (`packages/contracts/src/http/index.ts`, 21 → 19 endpoints). Le seul chemin d'écriture restant est `proposal.accept` / `proposal.reject` en temps réel (C-02), déjà câblé par L3-17 (`proposal/lifecycle.ts` résout atomiquement puis appelle `odoo/rides.ts::reportDriverAccepted`/`reportDriverRejected`, qui écrivent dans Odoo par le canal interne `controllers/internal.py`) : rien à construire ici, seulement retirer le second chemin qui l'ignorait.

**La preuve ne disparaît pas avec l'endpoint** (instruction explicite du débrief). `test/concurrency/ride-transitions.test.ts` (L4-11) vise désormais `/api/internal/rides/{id}/driver-accepted`, authentifié par le secret partagé (nouvelle aide `callInternalEndpoint`, `test/concurrency/helpers/odoo-session.ts`) plutôt que par un jeton de chauffeur — le verrouillage d'Odoo (`_lock_for_update()`) reste le même, que l'appelant soit un vrai chauffeur passé par le temps réel ou, comme ici, directement le canal interne.

**Effet de bord découvert en le câblant : le scénario 2 de L4-11 devenait injuste.** Depuis que l'acceptation vise le canal interne (authentification par secret partagé, sans résolution d'utilisateur ni recherche du chauffeur affecté), elle est structurellement plus rapide que `/cancel` (authentification complète par jeton) — sur 12 itérations à égalité de départ, l'acceptation gagnait 12 fois sur 12, et le critère 2 bis (« les deux ordres doivent se produire ») ne pouvait plus jamais être observé. Avant D31, les deux endpoints avaient un coût d'authentification comparable ; ce n'est plus le cas. Corrigé par un stager délibéré de 10 ms, alterné par itération — les deux appels restent réellement concurrents (le décalage reste largement sous le temps de traitement serveur, les deux transitions continuent de se disputer le même verrou de ligne), seul l'ordre de départ est rééquilibré. Vérifié : les deux ordres s'observent de nouveau sur 12 itérations.

**Conséquence en cascade côté Odoo** : `test_ride_controller.py` n'a plus d'endpoint public à appeler pour amener une course à `assigned` en préparation d'un test — nouvelle aide `_accept_via_internal_channel` (secret partagé). `test_unassigned_driver_cannot_accept` (critère 3 de L4-03, qui testait l'autorisation REST — disparue avec l'endpoint) devient `test_unassigned_driver_cannot_be_recorded_as_accepting` : la garantie qui reste est celle du modèle (`action_accept`, `by_driver != self.driver_id` → `RIDE_INVALID_TRANSITION`, pas `DRIVER_NOT_IN_PROPOSAL`) — l'identité de connexion, elle, est désormais garantie côté temps réel (`proposal.accept`, invariant L3-01), pas testable depuis ce fichier.

**Nettoyage lié à D30** (touché en passant, ces mêmes fichiers) : `test/concurrency/helpers/realtime.ts::seedDriverProfile` n'est plus une condition de visibilité depuis D30 — un chauffeur en ligne et positionné apparaît dans `nearby.drivers` sans profil. Gardé quand même, commentaire mis à jour : sans lui, le premier `nearby.drivers` qui montre un chauffeur fraîchement en ligne dans ces tests de concurrence déclencherait un aller-retour Odoo réel (L3-16) au lieu de lire un cache déjà chaud, ce qui aurait pu introduire une variation de temps d'exécution (critère 4 de L4-11).

**Vérifications** : suite Odoo complète (`-u babana --test-enable`) 297 tests, 1 échec (même artefact de base ancienne, `test_rotate_produces_new_pair_and_invalidates_old`). `npm run build -w @babana/contracts` (19 endpoints). `npx tsc --noEmit` sur `test/`. L4-11 scénario 1 en entier (20 itérations × 8 appels simultanés) : vert. Scénario 2 (12 itérations, avec le stagger) : vert, les deux ordres observés (`bothSucceeded` et `onlyCancelSucceeded` tous deux non nuls).

---
