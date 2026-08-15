# Rapport de nuit — J6 (nuit du 15 au 16 août 2026)

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). Périmètre : J6-C (corrections), L3-02, L3-03, L3-04, dans cet ordre — **pas**
L3-05 ni L3-06 (réservation atomique, sous revue humaine).

**État de départ vérifié** : `master` propre au lancement (`1d6d951`, débrief J5 déjà commité).
Branche `J6-C-corrections` pour les cinq corrections, un commit par correction (C1 à C5) comme
demandé — contrairement à J5, où deux paires de tâches avaient partagé un commit.

---

## J6-C — corrections

### C1 — la charge utile du jeton d'accès devient un contrat (D23)

**Fait.** `packages/contracts/src/auth/access-token.ts` porte `AccessTokenClaimsSchema` (Zod) :
`sub` (UUID), `role`, `driverId` (UUID, présent si et seulement si `role` vaut `driver`, imposé
par un `.refine()`), `iat`, `exp`, `jti` (UUID). Exporté sous le namespace `auth` depuis
`packages/contracts/src/index.ts`, à côté de `http` et `realtime`.

Odoo (`controllers/auth.py:_issue_access_token`) émet désormais `sub` au lieu de `uid`, et
`driverId` (`babana.driver.public_id`) sur tout jeton chauffeur — `babana.driver` existe toujours
à ce stade grâce à L1-03R. Le service temps réel (`services/realtime/src/ws/token.ts`) importe
`AccessTokenClaimsSchema` au lieu de redéclarer sa propre forme (`ApplicationTokenClaims` devient
un alias de `auth.AccessTokenClaims`), et valide les claims décodées avec `.safeParse()` plutôt
qu'à la main.

**Le lecteur oublié que la consigne annonçait existait bien** : `controllers/_common.py`,
`authenticated_user()`, cherchait `claims.get("uid")` — inchangé depuis que L1-02 émettait déjà
`uid` la nuit dernière. Corrigé pour lire `sub`. Sans cette correction, C1 aurait réparé le jeton
côté émission et vérification WebSocket, mais cassé silencieusement *tous* les endpoints HTTP
authentifiés (`/quote`, `/rides/*`, etc.), qui seraient passés d'un `uid` cohérent à un `sub`
introuvable — un défaut plus large que celui réparé.

Tests réalignés sur la forme réelle (`services/realtime/test/{token,auth,ws}.test.ts` :
UUID pour `sub`/`driverId`/`jti`, `iat` présent) plutôt que des valeurs inventées (`'user-1'`,
`'driver-public-1'`). Le test `'jeton valide sans driverId (L1-02 pas encore posé)'` n'avait plus
de sens (D23 rend `driverId` obligatoire sur un jeton chauffeur) : remplacé par un test qui
prouve qu'un tel jeton est désormais **rejeté**, pas dégradé en `driverId: null`. Deux tests
ajoutés dans `token.test.ts` : un jeton portant l'ancienne forme (`uid` au lieu de `sub`) est
rejeté, et un jeton chauffeur sans `driverId` est rejeté. Côté Odoo, `test_token.py` gagne
`test_access_token_carries_driver_id_distinct_from_sub`, qui prouve que `driverId` et `sub`
diffèrent réellement à l'émission (pas seulement dans le contrat).

### C2 — le test qui aurait dû exister (C-01, critère 5)

**Fait.** `test/auth/token-handshake.test.ts` : obtient un jeton par `POST /auth/google` contre
le vrai Odoo (`signIn()` de `test/concurrency/helpers/odoo-session.ts`, réutilisé tel quel), puis
ouvre avec lui une connexion WebSocket contre le vrai service temps réel — un scénario client, un
scénario chauffeur. `test/package.json` étend son glob (`concurrency/*.test.ts auth/*.test.ts`),
`test/tsconfig.json` inclut le nouveau dossier ; nom et description du paquet npm élargis pour
couvrir « accord inter-services », pas seulement la concurrence — choix d'implémentation non
spécifié, gardé pour ne pas perturber `package-lock.json` en renommant le paquet.

**Vérifié à blanc**, comme demandé (même protocole que L3-13 point 5) : `controllers/auth.py`
remis à `uid` temporairement, les deux sous-tests échouent ; restauré, ils passent. Cette
vérification a révélé un second défaut, dans le test lui-même cette fois : l'événement `open` du
WebSocket arrive *avant* que le serveur ne referme la connexion pour un jeton invalide
(l'authentification applicative a lieu après la poignée de main WebSocket, dans
`wss.on('connection', ...)`) — un test qui conclut au succès sur `open` seul ne prouve donc rien,
il a laissé passer le jeton `uid` cassé lors du premier essai à blanc. Corrigé par une fenêtre de
grâce de 300 ms après `open` avant de conclure à une acceptation réelle.

### C3 — compteur de quota de routage incrémenté atomiquement

**Fait.** `services/routing.py:_record_quota_usage` remplace lecture-ORM-puis-écriture
(`get_param` + `set_param`, faux sous concurrence et surtout une écriture sur une ligne globale à
chaque cotation) par une seule instruction SQL (`INSERT ... ON CONFLICT DO UPDATE`,
`RETURNING`). Flush explicite avant l'UPSERT (contrainte `key_uniq` — même règle que
`code/docs/odoo-pitfalls.md`) et invalidation explicite du cache ORM de `get_param()`
(`env.registry.clear_cache()`, même mécanisme que `create()`/`write()`/`unlink()` du modèle
`ir.config_parameter`) — sans elle, une lecture ultérieure via `get_param()` serait restée
périmée, découvert en écrivant le test.

Test unitaire (`test_routing.py`) : trois appels successifs incrémentent le compteur de trois. La
vraie preuve de concurrence (N appels simultanés, aucun échec) n'est pas dans ce lot — elle
demanderait un test contre la pile réelle comme L3-13/L4-11, hors du périmètre annoncé pour cette
nuit ; signalé ici plutôt que fait à moitié.

### C4 — repli sur cache périmé quand l'API de routage est indisponible (D24)

**Fait.** `get_reference_route` capture `RouteUnavailable` autour de l'appel API et, si une
entrée existe pour la même clé (même périmée), la sert en journalisant le repli — le 503
(`ROUTE_UNAVAILABLE`) ne subsiste que si rien n'a jamais été calculé pour ce trajet.
`babana.route.cache._get_any()` (sans filtre de fraîcheur) ajouté à cet effet, à côté de
`_get_fresh()`. Aucun appel de repli n'est comptabilisé pour le quota (pas d'appel sortant).

Trois tests ajoutés : repli servi (distance identique à l'entrée périmée), absence totale
d'entrée toujours en erreur explicite (critère 3 préservé), et repli sans incrément de quota.

### C5 — borner le minuteur d'expiration de connexion WebSocket

**Fait.** `services/realtime/src/ws/connection.ts` : le délai passé à `setTimeout` est plafonné à
`2**31 - 1` ms (`MAX_SET_TIMEOUT_MS`). Une ligne, comme annoncé — `Math.min(Math.max(...), ...)`
plutôt que `Math.max(...)` seul.

---

## Vérification sur base fraîche

`make reset` puis `make up` (la stack tournait depuis la session précédente ; relancée à froid
avant de déclarer J6-C fini, conformément au point de vigilance répété deux nuits de suite dans
`CLAUDE.md`), puis `make test`.

**Un défaut de séquencement trouvé et corrigé, sans rapport avec la logique métier** : la cible
`test` du `Makefile` lançait `npm test` avant l'installation du module `babana`
(`odoo -i babana --test-enable`, deuxième commande de la même cible) — invisible tant que la base
n'était jamais vraiment vierge au moment de `make test` (le module restait installé d'une session
à l'autre). Sur une base réellement fraîche, `npm test` échouait immédiatement (404 sur
`/auth/google`, module absent) avant même d'atteindre la commande qui l'installe. Corrigé en
inversant les deux lignes. Détail dans `amoa/questions/L4-11.md`.

**Un défaut réel trouvé, non corrigé, hors périmètre** : une fois l'ordre réparé, le scénario 2 de
`test/concurrency/ride-transitions.test.ts` (L4-11, hors de ce lot) s'est montré intermittent sur
4 exécutions consécutives — une fois avec la forme la plus sérieuse : `accept` (chauffeur) et
`cancel` (client) concurrents sur la même course ont **tous les deux réussi**. Aucun fichier de
`babana_ride*.py` ni `controllers/ride.py` ne fait partie de J6-C, L3-02, L3-03 ou L3-04 — et
`CLAUDE.md` place la machine à états (L4-02) sous validation humaine obligatoire. Signalé, pas
contourné : détail complet, hypothèse de cause et reproduction dans `amoa/questions/L4-11.md`.

**Le reste, vert** : suite Odoo complète (module `babana` + dépendances, `--test-enable -i
babana`), `npm test` pour tout le reste (paquets JS/TS, `services/realtime`, apps, et
`test/concurrency` scénario 1 + le nouveau `test/auth/token-handshake.test.ts` contre la pile
réelle), `npm run typecheck --workspaces`, `npm run lint --workspaces` (client/driver, les seuls
paquets à porter un script `lint`).

---

## L3-02 — Ingestion des positions

**Fait.** `services/realtime/src/tracking/validation.ts` (fonction pure `checkPlausibility`,
distance à vol d'oiseau Haversine pour la vitesse implicite), `redis/positions.ts` (stockage
Redis avec TTL, `POSITION_KEY_PREFIX`), `tracking/ingest.ts` (`ingestPosition`, orchestration :
lit la position précédente, valide, stocke, comptabilise). L'identité du chauffeur vient
exclusivement du `ConnectionContext` de la connexion WebSocket (`context.driverId`), jamais du
message `position.update` — qui ne porte d'ailleurs aucun identifiant d'émetteur (C-02, L3-01
critère 3). Une position rejetée est comptée par motif (`ingestMetrics`, compteurs en mémoire —
pas de dépendance de métriques nouvelle pour ce lot) et ignorée sans jamais fermer la connexion.

**Écriture Redis uniquement, jamais Odoo** (invariant 1) : `storePosition`/`getPosition` ne
touchent que Redis, avec une durée de vie courte et configurable. Le critère « le chauffeur sort
du pool à expiration » est prouvé au niveau du stockage (`hasFreshPosition` devient faux après le
TTL) — l'exclusion effective du géo-index est la responsabilité de L3-03, qui consomme ce même
signal au moment de la requête plutôt que de dupliquer un mécanisme d'expiration actif.

**Wiring nécessaire, hors de la liste de fichiers de la spécification mais indispensable pour que
la tâche fonctionne réellement** : `ws/dispatch.ts` (nouveau) route les messages entrants validés
contre `ClientToServerMessageSchema` vers leur gestionnaire par `type` ; `ws/connection.ts` y
délègue désormais le traitement de chaque message reçu, et `server.ts`/`createConnectionHandler`
passent le client Redis jusqu'au dispatcher. Un message illisible ou d'un type non encore traité
est ignoré, jamais une fermeture de connexion — même principe que le rejet d'une position. Choix
d'implémentation non spécifié par la tâche (structure de fichiers), nécessaire pour que
`position.update` atteigne effectivement `ingestPosition` ; noté ici plutôt que passé sous
silence.

**Écart déposé : `amoa/questions/L3-02.md`.** Les seuils de plausibilité, le TTL, et (pour
L3-03/L3-04) le rayon et la période de grâce sont des valeurs métier au sens de l'invariant 5 et
de D21 — qui prescrivent la base de données (réglages Odoo, L9-06), jamais `.env`. Mais le
service temps réel n'a et ne doit avoir aucun client PostgreSQL (invariant 1), et aucun canal de
lecture de configuration Odoo → temps réel n'existe encore. Provisoirement en variable
d'environnement (`services/realtime/src/config.ts`), valeurs par défaut plausibles (rectangle
englobant de Douala repris de `babana_zone_default.xml`, pas réinventé) et marquées comme
telles ; canal de lecture propre proposé pour la suite dans le fichier d'écart.

Tests (`test/ingest.test.ts`) : chaque règle de plausibilité isolée (critère 2, y compris la
zone d'exploitation distincte des bornes WGS84 génériques), position valide stockée (1), rejet
sans fermeture de connexion (3), expiration du TTL (4), taux de rejet par motif exposé (5), et
un message `position.update` reçu d'une connexion non-chauffeur rejeté sans jamais tenter de
dériver une identité de la charge utile.

---

## L3-03 — Géo-index des chauffeurs disponibles

**Fait.** `services/realtime/src/redis/geo-index.ts` : `addToPool`/`removeFromPool` (GEOADD/ZREM
sur une clé unique `babana:drivers:available`), `isInPool`, `findNearby` (GEOSEARCH par rayon,
triée par distance croissante, distance à vol d'oiseau documentée comme telle -- L3-03,
spécification). Ce module ne connaît **aucune règle métier** (invariant 3) : il ignore ce que
signifie « en course » ou « au plafond d'encaisse » -- l'appelant (L3-04 ce soir pour en ligne/
hors ligne ; L3-06/L3-07, hors de ce lot, pour réservation et affectation) décide seul d'appeler
`addToPool`/`removeFromPool`. Les critères 2 et 3 (jamais en course, jamais au plafond) sont donc
vérifiés par construction : un chauffeur jamais ajouté au pool n'y apparaît jamais.

**Nettoyage paresseux des positions expirées**, au-delà des critères numérotés mais explicitement
demandé par la spécification (« Sortie : ... expiration de la position ») : `findNearby` filtre
tout candidat sans position fraîche (`hasFreshPosition`, L3-02) et le retire du pool au passage --
`addToPool`/`removeFromPool` n'écoutent aucune notification d'expiration Redis (pas de
notification keyspace, hors de ce lot), un chauffeur déconnecté peut donc rester un court instant
dans l'index brut sans jamais être renvoyé par une requête, et disparaît définitivement à la
première requête qui le croise. Sur-échantillonnage fixe (×3) pour absorber ce filtrage sans
compliquer l'appel par une boucle de re-complétion.

**Test contre un Redis réel** (`test/geo-index.test.ts`, nécessite `make up` ou au moins
`docker compose up redis`) plutôt qu'une imitation en mémoire : le scoring géospatial interne de
Redis (GEOADD/GEOSEARCH) serait mal reproduit par une imitation -- même raisonnement que L3-06/
L3-13 pour la réservation atomique, appliqué ici au tri par distance plutôt qu'à l'atomicité.
Conséquence assumée : `npm test -w @babana/realtime` requiert désormais Redis disponible (il
l'était déjà implicitement pour le service lui-même, jamais pour sa suite de tests jusqu'ici).
