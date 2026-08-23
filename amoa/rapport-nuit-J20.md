# Rapport de nuit — J20

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-28.md` lu en entier avant d'ouvrir quoi que
ce soit. Périmètre confié : les correctifs (D43, nettoyage du contrat, D44), puis L4-12, puis la
vérification navigateur complète jusqu'au résumé de fin.

---

## D43 — aucune configuration de fournisseur externe ne retombe sur le vrai fournisseur

### La cause réelle, pas celle supposée hier

L'hypothèse portée par la nuit précédente (double instanciation du module `@babana/maps` dans le
bundle webpack, un exemplaire configuré, un autre lu) a été vérifiée en premier, en inspectant les
stats du bundle produit (`webpack --json`, filtré sur `packages/maps`) : **un seul** module
`providers/google/config.js` apparaît dans le graphe. L'hypothèse était fausse — vérifié, pas
supposé, avant d'écrire quoi que ce soit d'autre.

La vraie cause, une fois cherchée avec la règle donnée hier plutôt qu'en devinant : `getSearchUrl`
(`packages/maps/src/providers/google/config.ts`) faisait `searchUrl || defaultUrl`, et
`defaultUrl` était `PLACES_TEXT_SEARCH_URL`, **l'adresse Google réelle**. Une variable non
configurée — exactement le cas d'un build web sans `infra/env/.env` sourcé avant `npm run
build:web`, puisque `apps/client` ne fait pas partie de `docker compose` — ne produisait donc pas
une erreur visible, mais un appel qui *réussit* silencieusement, avec un destinataire différent.

### Le correctif, et la règle appliquée au-delà du cas trouvé

`getSearchUrl()` lève désormais si `searchUrl` n'est pas configuré, exactement comme
`getGoogleMapsApiKey()` le fait déjà pour la clé. Plus de paramètre `defaultUrl` : la production
doit poser l'adresse Google réelle explicitement, jamais par défaut.

**La consigne demandait d'appliquer la règle partout, pas seulement ici.** Audit de tout appel à
`os.environ.get(NOM, valeur_par_défaut)` où la valeur par défaut pointe vers une vraie adresse de
fournisseur externe (`grep -rn "googleapis.com\|accounts.google.com"`) :

- `GOOGLE_ROUTING_URL` (`services/routing.py`) : défaut déjà vers **mock-maps**, pas vers le vrai
  fournisseur — conforme à la règle, rien à changer.
- `GOOGLE_JWKS_URL` (`google_identity.py` **et** `infra/compose.yaml`, deux niveaux) : défaut vers
  **`https://www.googleapis.com/oauth2/v3/certs`**, la vraie adresse Google — même défaut,
  masqué aujourd'hui parce que `infra/env/.env.example` pose toujours une valeur explicite en
  développement, mais un défaut qui pointe vers le vrai fournisseur reste un défaut qui pointe vers
  le vrai fournisseur. Corrigé aux deux niveaux : `os.environ["GOOGLE_JWKS_URL"]` (Python, lève
  `RuntimeError` si absente) et `${GOOGLE_JWKS_URL:?...}` (compose, refuse de démarrer le conteneur
  Odoo si absente — plus bruyant encore, à l'échelle du service).

### Vérifié dans un navigateur, jusqu'au point que D43 promettait de débloquer

Montage jetable identique aux nuits précédentes (`verify.localhost`, Caddy, jamais commité, retiré
après coup — `git status` vérifié propre). Session client réelle obtenue par le vrai flux
(`mock-google-identity` → `POST /api/v1/auth/google`, jamais un raccourci serveur) et injectée dans
`localStorage` sous la clé du stub de trousseau web, exactement l'équivalent d'un redémarrage
d'app avec une session déjà persistée. Chauffeur réel amené en ligne par un script jetable en
WebSocket (`availability.set`, `position.update`, `proposal.accept` — même patron que les nuits
précédentes), jamais un raccourci serveur non plus.

**La recherche « Akwa » a fonctionné, dans le vrai navigateur, à l'écran.** C'est précisément le
point que la nuit précédente n'a jamais pu atteindre. Chauffeur réel visible (900 m), point
d'arrivée « Bonanjo » sélectionné de la même façon. Voir la section « Vérification navigateur »
plus bas pour ce qui a suivi et où ça s'est arrêté.

### Fichiers

`packages/maps/src/providers/google/config.ts`, `places.ts`, `test/places.test.ts` ;
`apps/client/config.ts` (commentaire) ; `infra/env/.env.example` (commentaires, deux variables) ;
`infra/compose.yaml` (`GOOGLE_JWKS_URL`) ; `services/odoo/addons/babana/services/
google_identity.py`, `tests/test_google_identity.py`.

---

## D44 — la réconciliation restaure un état complet, jamais un engagement sans course

### Ce que l'unification (L3-18) a changé sous ce correctif

Avant l'unification, engagement et suivi étaient deux structures Redis distinctes : un engagement
réparé sans suivi (`force-engage`) était visiblement incomplet, une simple absence de la seconde
structure. Depuis L3-18, les deux sont un seul enregistrement — la même réparation produit
désormais un état qu'**aucune transition normale ne peut produire** : `engaged`, sans `rideId`, un
non-sens dans un système où chaque champ posé par `resolve` porte toujours son `rideId` avec lui.

### Le correctif

Odoo connaît l'identifiant de la course de chaque chauffeur engagé (une seule course active par
chauffeur, `assigned`/`in_progress`, jamais les deux) : `POST /internal/drivers/engaged` porte
désormais `{"engaged": [{"driverId", "rideId"}, ...]}` plutôt qu'une simple liste d'identifiants.
`force-engage` (`ride/state.lua`) pose maintenant `rideId` et son index inverse
(`rideOwnerKey` → `driverId`), exactement ce que `resolve` pose à l'acceptation — un état réparé
est désormais indiscernable d'un état produit par le cycle réservation → résolution normal (il lui
manque encore `clientUserId`/origine, mais c'est aussi vrai, brièvement, entre un `resolve(...,
true)` réel et l'`attachEngagedSession` qui le complète juste après — un état qu'une transition
normale traverse déjà, donc plus un état qu'aucune ne peut produire).

`driver/reconcile.ts` porte désormais une `Map<driverId, rideId>` plutôt qu'un `Set<driverId>`, et
passe ce `rideId` à `setEngaged` pour chaque marqueur manquant qu'il pose.

### Trouvé en chemin : `services/realtime/package.json` cassé depuis L3-18

`npm run build` du service temps réel échouait (`cp: src/reservation/*.lua: No such file or
directory`) — le script de build packageait encore `src/reservation/*.lua` et `src/proposal/*.lua`,
retirés par l'unification, et ne packageait jamais `src/ride/*.lua`, où vit désormais l'unique
script. Une régression de build silencieuse depuis la nuit précédente, jamais remarquée parce que
`npm test` ne dépend pas de `npm run build` pour ce service (`tsx` exécute les sources
directement). Corrigé — `dist/redis`, `dist/ride`, les deux emplacements réels.

### Fichiers

`services/realtime/src/ride/state.ts`, `state.lua`, `driver/engagement.ts`, `driver/reconcile.ts`,
`odoo/rides.ts` (`fetchEngagedDrivers`, renommée), `odoo/driver-profiles.ts` (commentaire),
`package.json` ; `services/odoo/addons/babana/controllers/internal.py`,
`tests/test_internal_controller.py` ; tests ajustés (signature de `setEngaged`/`forceEngaged`,
inchangée dans leur intention) : `test/reservation.test.ts`, `test/ride-state.test.ts`,
`test/reconcile.test.ts`, `test/internal.test.ts`.

---

## C-02R (suite) — nettoyage du contrat

`ride.start`, `ride.complete`, `cash.limit.warning` retirés de
`packages/contracts/src/realtime/{client-to-server,server-to-client}.ts` — leur vrai chemin est
construit et testé ailleurs (HTTP pour les deux premiers, notification push L7-05 pour le
troisième), les garder n'était qu'une source de confusion pour la prochaine lecture de la
cartographie. `ride.proposed` gardé : sa raison (synchronisation d'un second appareil du même
client) est désormais écrite dans le contrat lui-même, pas seulement dans `amoa/questions/`.

Tests ajustés en conséquence : `packages/contracts/test/realtime.test.ts`, et deux fichiers
`packages/api-client/test/realtime/{connection,queue}.test.ts` qui utilisaient `ride.start`/
`ride.complete` comme exemples génériques pour exercer le mécanisme de file hors connexion —
remplacés par `proposal.accept`/`ride.track`, deux messages réels qui existent toujours, la
mécanique testée (ordre, identifiants conservés) restant identique.

`docs/contracts/realtime-message-map.json` / `realtime-events.md` mis à jour : **20 messages au
contrat, contre 23 hier**, tous cartographiés (`verify-realtime-message-map.js` vert).

---

## L4-12 — l'annulation notifiée à qui n'a pas décidé

### Le patron, et les deux différences avec L3-19

Même patron que `notify_ride_started`/`notify_ride_completed` : l'appel vit **dans**
`action_cancel` (`babana_ride_state.py`), après l'écriture de la transition, enregistré au COMMIT
(`env.cr.postcommit.add`, D32) — jamais pendant. `action_cancel` ne porte aucun savepoint (vérifié
dans le code, pas supposé), donc rien à protéger de D33.

**Différence 1 — le destinataire dépend de l'acteur.** `action_cancel` connaît déjà `actor_role`
(son premier argument) : un client qui annule prévient le chauffeur affecté (s'il y en a un), un
chauffeur prévient le client, un superviseur prévient les deux — jamais celui qui vient de
décider, qui le sait déjà. Calculé dans `action_cancel` lui-même, jamais recalculé côté service
temps réel (`realtime_client.notify_ride_cancelled` ne fait que porter la décision jusqu'à
`POST /internal/rides/cancelled`, `notifyClientUserId`/`notifyDriverId` chacun optionnel).
`self.driver_id` reste lisible après l'écriture (`action_cancel`, contrairement à `action_reject`,
ne l'efface jamais) : une annulation depuis `rejected` n'a donc, à raison, personne côté chauffeur
à prévenir.

**Différence 2 — le message porte le motif.** `RideCancelledPayloadSchema` gagne `cancelledBy`
(`'client' | 'driver' | 'supervisor'`), en plus du `reason` déjà existant — un chauffeur qui
apprend qu'une course est annulée doit au moins savoir lequel des deux cas (client, ou
supervision) s'est produit avant de décider s'il continue à rouler vers un point de prise en
charge.

### Preuve composée en trois, même discipline que L3-19

1. **Le point d'accroche** (`test_realtime_commit_hook.py`) : rollback n'appelle jamais, commit
   appelle exactement une fois, `_post` mocké — `notify_ride_cancelled` ajoutée à `GATED_CALLS`,
   couverte par le même balayage AST anti-savepoint (D33) et anti-appel-non-gated (D32) que les
   autres appels sortants de ce module.
2. **Le câblage** (`test_ride_state_machine.py`) : six nouveaux tests — client/chauffeur/
   superviseur, plus les deux cas où `notify_ride_cancelled` ne doit **pas** être appelée (annulé
   depuis `requested`, sans chauffeur ; annulé depuis `rejected`, chauffeur déjà parti).
3. **La livraison réelle** (`services/realtime/test/internal.test.ts`) : contre Redis et
   WebSocket réels — un client qui annule ne reçoit rien lui-même, un chauffeur qui annule ne
   reçoit rien lui-même, un superviseur déclenche les deux.

### Fichiers

`packages/contracts/src/realtime/server-to-client.ts`, `test/realtime.test.ts` ;
`services/realtime/src/tracking/broadcast.ts` (`broadcastRideCancelled`), `src/http/internal.ts`
(`POST /internal/rides/cancelled`), `test/internal.test.ts` ;
`services/odoo/addons/babana/services/realtime_client.py` (`notify_ride_cancelled`),
`models/babana_ride_state.py` (`action_cancel`), `tests/test_ride_state_machine.py`,
`tests/test_realtime_commit_hook.py` ; `docs/contracts/realtime-message-map.json`,
`realtime-events.md`.

---

## Vérification navigateur — jusqu'où elle a pu aller, et où elle s'est arrêtée

Demandée explicitement, jusqu'au résumé de fin, sans contournement manuel. Montage jetable
(`verify.localhost`), retiré avant tout commit — `git status` vérifié propre sur
`infra/compose.yaml`/`infra/caddy/Caddyfile` après coup.

**Bloquée une première fois avant même d'atteindre l'écran d'accueil : le certificat local de
Caddy.** `make reset` régénère l'autorité locale de Caddy à chaque fois (`caddy-data` fait partie
des volumes effacés) — le certificat qu'un profil Chrome de cette machine avait approuvé les nuits
précédentes ne correspond plus au nouveau. Constaté par comparaison d'empreintes
(`security find-certificate`, `openssl x509 -fingerprint`) avant de demander quoi que ce soit :
l'entrée de confiance existante portait un numéro de série différent de celui du certificat frais.
Je ne modifie pas de réglage de confiance système moi-même — l'utilisateur l'a fait, avec son
propre mot de passe/Touch ID, deux fois (le premier import portait par erreur l'ancien certificat).

**Ce qui a été vu, en clair, jusqu'à la sélection du point d'arrivée inclus** : session restaurée,
recherche « Akwa » puis « Bonanjo » via `PlacePicker` — **D43 en train de fonctionner dans un vrai
navigateur**, le point précis qui bloquait hier. Chauffeur réel visible (`nearby.subscribe`),
départ et arrivée réels sélectionnés. Plus loin qu'aucune nuit précédente sur ce chemin précis.

**Bloquée une seconde fois, par un défaut différent, jamais rencontré avant parce que jamais
atteint avant ce soir.** `QuoteScreen` : « L'estimation a échoué. » Réseau :
`OPTIONS https://api.localhost/api/v1/quote` → 401, avant que la vraie requête `POST` ne parte —
un préflight CORS refusé. Cause identifiée sans ambiguïté (`grep -ri cors` sur tout
`services/odoo/addons/babana` : aucun résultat ; `controllers/quote.py` ne déclare que
`methods: ["POST"]`, aucune route `OPTIONS`) : aucune route de ce dépôt ne gère CORS, parce qu'en
production l'app Client est React Native, jamais un navigateur — CORS n'a de sens que pour l'export
web (D22), dont le déploiement réel est explicitement porté par **L6-18** ailleurs dans ce dépôt.

**Décidé de ne pas corriger, conformément au protocole** : construire une réponse CORS ce soir
aurait été trancher seul, en fin de nuit, une question qui a de vraies implications de sécurité sur
l'API de production (quelles origines autoriser, sur une API à jeton porteur) — hors du périmètre
confié, et hors de la portée naturelle de D43/D44/C-02R/L4-12. Détaillé, avec la proposition
associée : `amoa/questions/L6-18-cors-api-web-quote.md`.

**Ce que ça n'empêche pas de conclure.** D43 est vérifié, dans un vrai navigateur, à l'écran, sur
le point précis qu'il promettait de débloquer. Le nouveau blocage est un défaut différent,
préexistant, découvert seulement parce que D43 a permis d'aller assez loin pour l'atteindre — le
même genre de progression que L3-19 avait produit pour C-02R il y a deux nuits.

---

## Passe finale — et un défaut réel trouvé par elle, sans lien avec ce soir

`make build`/`lint`/`typecheck` propres sur tout l'arbre. `npm test` complet, sur base fraîche,
sans contention avec la suite Odoo (les deux exécutées en parallèle plus tôt ont produit un faux
échec de concurrence par ressources partagées, pas un vrai — rejoué seul, vert) : **422 tests, 0
échec** (`api-client` 50, `contracts` 64, `maps` 19, `ui` 4, `navigation` 4, `realtime` 157,
`client` 84, `driver` 15, `test/` — concurrence, contrat HTTP, authentification — 25), plus les
deux scripts de vérification (état de course, cartographie des messages) verts. `make verify` vert.

**`make test` (le pas Odoo) a échoué trois fois de suite sur les deux mêmes tests, jamais sur rien
d'autre — root-causé avant d'écrire cette section, pas seulement observé.**
`TestDriverCashController.test_a_remittance_does_not_count_as_collected_today` et
`test_returns_balance_limit_and_collected_today`, tous deux `collectedToday` retombé à 0. Pas un
flake au sens habituel : vérifié en `odoo shell`, `_babana_find_or_create_from_google` (aucune
tâche de ce soir) pose tout compte avec le fuseau par défaut d'Odoo (`Europe/Brussels`, jamais
`Africa/Douala`, jamais posé nulle part), et `_babana_cash_collected_today`
(`models/babana_driver.py`, introduite le 17 août — pas cette nuit) calcule ses bornes de requête
sur le jour calendaire de **ce** fuseau sans jamais les convertir en UTC avant de les comparer à
`create_date` (stocké en UTC). Les deux horloges divergent chaque jour entre 22h00 et 23h59 UTC
(l'écart de l'UTC+2 estival) — un mouvement d'encaissement posé à l'instant, dans cette fenêtre,
disparaît de la requête du jour. **Pas qu'un artefact de test** : un vrai chauffeur, avec le même
défaut de fuseau jamais posé à l'inscription, verrait sa recette du jour afficher zéro pendant la
même fenêtre, tous les jours. Introduit le 17 août (`git log`), dormant depuis, jamais rencontré
avant parce que jamais exécuté dans cette fenêtre-là avant ce soir.

Hors du périmètre confié (aucune tâche de ce soir ne nomme le compte courant), et adjacent au lot
L5 (logique financière) que `CLAUDE.md` place explicitement parmi ce qui exige une revue humaine
avant fusion — pas corrigé, signalé avec la cause complète et la correction proposée :
`amoa/questions/L5-collected-today-timezone-boundary.md`. Vérifié que rien d'autre n'est concerné :
le sous-lot `babana` seul (418 tests) est passé à 0 échec plus tôt dans la nuit, avant 22h UTC ;
seules les passes qui recouvraient la fenêtre ont montré ces deux échecs, toujours les deux mêmes,
jamais un troisième.

`make secrets-scan` : même faux positif préexistant que les nuits précédentes
(`react-native-keychain.web.js`, une clé `localStorage` jamais un secret), toujours pas corrigé,
toujours hors du périmètre d'une nuit qui ne le nomme pas.

### Fichiers (référence rapide, détail par tâche ci-dessus)

D43 : `packages/maps/*`, `apps/client/config.ts`, `infra/env/.env.example`, `infra/compose.yaml`,
`services/odoo/.../google_identity.py`. D44 : `services/realtime/src/{ride,driver,odoo}/*`,
`package.json`, `services/odoo/.../controllers/internal.py`. C-02R+L4-12 :
`packages/contracts/src/realtime/*`, `services/realtime/src/{tracking,http,ws}/*`,
`services/odoo/.../{realtime_client,babana_ride_state}.py`, `docs/contracts/*`.

---

## Ce qui reste ouvert

- **`amoa/questions/L6-18-cors-api-web-quote.md`** (nouveau) — `/api/v1/*` refuse tout préflight
  CORS, bloque l'export web dès `POST /quote`. Candidat naturel : un lot préparatoire de L6-18.
- **`amoa/questions/L5-collected-today-timezone-boundary.md`** (nouveau) — `collectedToday`
  retombe à 0 chaque jour entre 22h00 et 23h59 UTC, cause et correctif déjà identifiés. Lot L5,
  revue humaine requise (`CLAUDE.md`).
- **L3-12** — file persistante avec rejeu côté service.
- **L4-06** — la facture.
- **`make secrets-scan`** — le faux positif à traiter proprement.
- **La validation du plan comptable** — trois questions à poser.
- **La vérification développeur Android.**
- **L8-03/L8-04** — partage de trajet, bouton d'urgence : reportés une nuit de plus, faute de
  temps une fois la vérification navigateur et ses deux blocages traités jusqu'au bout. Toujours
  la priorité absolue avant le lot Chauffeur (arbitrage du 28 août).

## Doute pour un client réel

**Deux, nommés précisément plutôt que lissés.**

Un : le CORS. Tant qu'il n'est pas réglé, aucun parcours réel ne peut aller au-delà de l'écran
d'estimation sur l'export web — pas un défaut de ce soir, mais un vrai mur, pas seulement une
gêne.

Deux, plus inquiétant parce que discret : la fenêtre de fuseau horaire sur `collectedToday`. Un
chauffeur qui encaisse une course tard le soir (23h-1h WAT, l'équivalent local de la fenêtre UTC
trouvée ce soir) verrait sa recette du jour afficher zéro sur son propre écran, sans erreur, sans
rien qui le distingue d'un vrai zéro. C'est exactement le genre de défaut qu'un chauffeur découvre
seul, la nuit, sans personne pour lui dire que c'est un bug plutôt que son argent qui a disparu —
et qui a dormi huit nuits avant d'être trouvé, seulement parce qu'une exécution de test a
coïncidé avec la bonne heure.
