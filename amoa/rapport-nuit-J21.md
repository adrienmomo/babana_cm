# Rapport de nuit — J21

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-29.md` lu en entier avant d'ouvrir quoi que
ce soit. Périmètre confié : D45 (fuseau) et D46 (banc de vérification) d'abord — la suite reste
rouge tant que D45 n'est pas traité — puis L8-03 (partage de trajet) et L8-04 (bouton d'urgence),
cinq nuits reportées.

---

## D45 — le fuseau se pose à la création, et les deux bornes du jour se convertissent en UTC

Les deux moitiés, comme demandé — corriger l'une sans l'autre laisse un décalage d'une heure à
Douala, plus rare donc plus difficile à voir.

### Moitié 1 — tout compte reçoit son fuseau à la création

`_babana_find_or_create_from_google` (`models/res_users.py`) ne posait jamais `tz` dans les `vals`
du `create()` — tout compte héritait donc du défaut Odoo, `Europe/Brussels`. Corrigé : `tz` est
désormais lu depuis `ir.config_parameter` (`babana.default_account_tz`, repli `Africa/Douala`),
même idiome que `CASH_LIMIT_PARAM` et les autres paramètres du dépôt (invariant 5) — configurable
sans déploiement, comme demandé (« le jour où le service dépasse le Cameroun, cette valeur doit
changer sans toucher au code »).

### Moitié 2 — la conversion en UTC qui manquait

`_babana_cash_collected_today` (`models/babana_driver.py`) calculait `today` correctement avec
`fields.Date.context_today(self)` (le fuseau réel du compte connecté — code/docs/odoo-pitfalls.md
réserve `context_today()` exactement à ce cas), mais construisait ensuite `start`/`end` comme des
`datetime` **naïfs** sur ce jour calendaire local, comparés tels quels à `create_date` (stocké en
UTC). Corrigé par localisation explicite (`pytz`) : chaque borne est construite séparément
(`combine` sur `today` puis sur `today + 1 jour`, pas `start + timedelta(days=1)`) pour rester
correcte un jour de changement d'heure, puis convertie en UTC avant la requête.

### Recherche d'autres occurrences du même motif

Demandée explicitement (« c'est le genre de motif qui se recopie »). `grep` sur `combine(`,
`time.min`, `time.max`, `context_today` dans tout `services/odoo/addons/babana` (hors tests) :
`_babana_cash_collected_today` est la **seule** fonction qui construit une borne de requête depuis
un jour calendaire local. Toutes les autres occurrences de date du jour
(`babana_motorcycle.py`, `babana_fare_rule.py`, le cron d'alerte de `babana_driver.py`,
`services/routing.py`) utilisent déjà `fields.Date.today()` (UTC, sans contexte utilisateur) —
conforme à la règle documentée dans `code/docs/odoo-pitfalls.md`, rien à corriger là.

### Tests — la frontière, pas l'horloge du moment

« Un test qui tourne à quatorze heures ne dira jamais rien » : les trois tests de
`_babana_cash_collected_today` (`tests/test_driver.py`) figent `today` par `unittest.mock.patch`
sur `odoo.fields.Date.context_today` plutôt que de dépendre de l'heure réelle d'exécution, et
posent `create_date` explicitement par SQL direct (champ non-écrivable par `write()`) :

- un mouvement à 23h30 UTC (00h30 heure locale Douala, jour suivant) est bien compté dans la
  recette du jour local qui vient de commencer — exactement le mouvement qui disparaissait avant
  correctif ;
- un mouvement à 23h30 UTC un jour plus tard (00h30 locale, encore un jour plus tard) est bien
  exclu — la borne de fin est symétriquement correcte, pas seulement celle de début ;
- un chauffeur `Europe/Brussels` (le défaut Odoo qu'un compte pourrait encore porter) obtient un
  résultat différent d'un chauffeur `Africa/Douala` pour le même mouvement — preuve que le calcul
  suit réellement le fuseau du compte, pas une valeur fixe câblée dans le test.

Deux tests supplémentaires (`tests/test_auth.py`) prouvent la moitié 1 : un compte fraîchement créé
via `/auth/google` porte `Africa/Douala`, et changer `ir.config_parameter` change ce défaut sans
toucher au code.

**Logique financière, sous revue humaine** (`CLAUDE.md`) : le changement touche directement le
calcul de solde affiché au chauffeur, écrit et testé comme tel — 6 tests nouveaux, tous verts,
suite `babana` complète rejouée sur base fraîche sans régression (voir passe finale).

Deux tests jusqu'ici verts par accident deviennent verts pour la bonne raison : les tests HttpCase
`TestDriverCashController.test_returns_balance_limit_and_collected_today` et
`test_a_remittance_does_not_count_as_collected_today` (ne fixent pas l'horloge, dépendent du
moment réel d'exécution) — jusqu'ici verts sauf entre 22h et minuit UTC. Vérification obtenue sans
avoir à la provoquer : l'exécution de la suite ciblée ce soir est tombée exactement dans cette
fenêtre (23h19 UTC, `date -u` à l'appui), la même qui faisait rougir ces deux tests avant
correctif — et les deux sont passés.

**Fichiers.** `models/res_users.py`, `models/babana_driver.py`, `tests/test_auth.py`,
`tests/test_driver.py`.

---

## D46 — le banc de vérification en même origine, aucun code applicatif touché

Aucun fichier du dépôt à changer : `controllers/`, `infra/caddy/Caddyfile`, `apps/client/config.ts`
restent inchangés. La correction est entièrement dans **la façon de vérifier**, pas dans le
produit — exactement ce que D46 (`amoa/01-architecture.md` §9 ter) demande.

### Ce qui a été refait, précisément

Même montage que J16/J17 (`amoa/rapport-nuit-J16.md`, `amoa/rapport-nuit-J17.md`) : `dist-web`
construit avec `BABANA_API_URL`/`BABANA_REALTIME_WS_URL` pointés sur l'origine du banc lui-même,
et un Caddy jetable (`http://verify.localhost:8888`, jamais commité, retiré en fin de session) qui
sert `dist-web` **et** relaie `/api/*` et `/rt/*` vers Odoo et le service temps réel réels —
`api/*` sur la même origine que le bundle, pas sur une seconde. C'est précisément l'inverse du
montage de J20 (bundle sur `verify.localhost`, API laissée sur `api.localhost` — deux origines),
identifié comme la cause du préflight refusé (`amoa/questions/L6-18-cors-api-web-quote.md`).

### Preuve, pas seulement le montage

Session réelle injectée (même geste que J17 — restauration de session, pas le flux OAuth web qui
n'existe pas encore), jeton obtenu par un vrai aller-retour `mock-google-identity` → `POST
/api/v1/auth/google` contre le banc lui-même. Après rechargement : `HomeScreen` s'affiche,
`GET /api/v1/me` répond **200** sur `http://verify.localhost:8888` (même origine que la page,
`read_network_requests` à l'appui), aucune erreur console. Aucun préflight `OPTIONS` déclenché —
un navigateur n'en émet jamais pour une requête réellement same-origin, c'est tout l'intérêt du
montage.

**Ce que ça ne referme pas** : `amoa/questions/L6-18-cors-api-web-quote.md` reste ouvert tel quel
— le jour où l'app Client réelle sera déployée en web (L6-18), la topologie de production devra
elle-même être same-origin (ou une vraie politique CORS explicite posée), ce qui est le travail de
cette tâche-là, pas de ce soir. Ce soir prouve seulement que **le défaut était dans le banc**, pas
dans l'API — et que vérifié correctement, le parcours ne bute sur rien.

---

## L8-03 et L8-04 — partage de trajet et bouton d'urgence, cinq nuits reportées

**Un seul commit pour les deux**, décision assumée plutôt que subie : les deux fonctions
partagent le même écran d'accueil (`TrackingScreen.tsx`), la même notion de « pendant une
course » (`babana_ride.py::TOGETHER_STATES`, nouvelle, utilisée par les deux contrôleurs), et le
même registre de contrat (`packages/contracts/src/http/index.ts`). Les séparer en deux commits
aurait exigé des états intermédiaires qui ne compilent pas ou dont les tests d'écran ne
passeraient pas — un choix d'implémentation non spécifié (`CLAUDE.md`), tranché et documenté ici
plutôt que forcé.

### L8-03 — partage de trajet

**Jeton et validité vivent dans Odoo** (`models/babana_ride_share.py`) : `secrets.token_urlsafe(32)`,
jamais dérivé de l'identifiant de course (critère 1), réutilisé tant qu'il reste actif
(`action_get_or_create`, un client qui rouvre l'écran ne doit pas invalider le lien déjà envoyé
par SMS), révocable immédiatement et de façon idempotente (critère 4). Expiration (critère 3) :
`completed_at`/`cancelled_at` du ride plus un délai de grâce configurable
(`babana.share_link_grace_minutes`, repli 30) — délibérément **pas** `settled_at`, qui peut
survenir bien après si l'encaissement traîne et prolongerait à tort un lien déjà périmé du point
de vue du proche qui le suit. `rejected` en est exclu : ce n'est pas un état terminal pour le
client (D11), une course refusée retourne à la sélection.

**La page publique est servie par le service temps réel, jamais par Odoo** (spécification) :
`GET /s/{token}` et `GET /s/{token}/status` (`services/realtime/src/share/`), déjà routés par
Caddy (`handle /s/*`, en place depuis L0-01 — rien à changer côté infra). Odoo n'expose que la
liste blanche (`POST /api/internal/share/resolve`, critère 2 : destination, prénom, gamme, phase
`approach`/`course` — jamais le nom du client, son téléphone, l'historique, le montant, ni
l'identité complète du chauffeur, testé explicitement en cherchant leur absence dans la réponse
brute). La position vive et le point de rendez-vous pendant l'approche viennent de Redis
(`tracking/session.ts`, `redis/positions.ts`) — la même donnée éphémère que `ride.track` lit déjà,
pas une seconde source, invariant 1 respecté.

**Pas de dépendance de carte** (délibéré, signalé plutôt qu'ajouté en silence) : la page est un
seul fichier HTML/CSS/JS inline, sans bundler, avec un repère SVG minimal (deux points mis à
l'échelle de leur propre boîte englobante à chaque actualisation) plutôt qu'un fond de carte
tuilé — `@babana/maps` suppose un bundle React Native/web, une bibliothèque de tuiles (Leaflet)
aurait été une dépendance nouvelle non nécessaire pour une page dont la spécification demande
justement l'inverse (« pas de dépendance lourde », terminal d'entrée de gamme, réseau lent).
Actualisation par sondage (`fetch` toutes les `SHARE_POLL_INTERVAL_SECONDS`, 10 s par défaut),
jamais de WebSocket depuis une page publique sans authentification.

**Critère 6, limitation de débit par jeton** : fenêtre glissante en mémoire par jeton
(`share/rateLimit.ts`), même patron que `nearby/handler.ts` -- pas un second mécanisme inventé.

Tests : 14 côté Odoo (modèle, contrôleur client, résolution interne), 10 côté service temps réel
(page, statut, liste blanche, limitation de débit, routage), 4 côté app Client
(`ShareTripButton.test.tsx` : création puis ouverture du sélecteur natif, repli sur le lien affiché
si `Share` est indisponible — l'export web, révocation immédiate, erreur métier traduite).

### L8-04 — bouton d'urgence

**Un seul endpoint, symétrique** (`POST /rides/{id}/incidents`, `babana.incident`) : l'acteur
(client ou chauffeur) se déduit du jeton d'authentification, jamais transmis dans le corps
(invariant 3). Réservé aux états `TOGETHER_STATES` -- avant l'affectation personne n'est encore
réuni, après un état terminal ce n'est plus « pendant ». La course ne s'arrête jamais
automatiquement (critère 5, prouvé par un test qui vérifie l'état de la course après création de
l'incident) -- la décision revient à un humain au back-office.

**Back-office, critère 3** : non listée dans les fichiers de la tâche (comme la vue des écarts de
caisse, L5-06, avant elle) -- ajoutée quand même, sans elle le critère n'est pas vérifiable.
`views/babana_incident_views.xml`, liste triée statut puis ancienneté, décoration rouge sur
`open`, boutons `Prendre en charge`/`Clôturer` réservés aux superviseurs.

**Critère 4, contact d'urgence -- notifié, pas livré, et c'est écrit noir sur blanc.** Aucun relais
SMS n'existe dans ce dépôt (aucun mock, comme il en existe pour Google ou la cartographie -- D42
nomme déjà ce trou pour le masquage de numéro, « une intégration téléphonique entière »).
`_notify_emergency_contact` fige le numéro sur l'incident et journalise l'intention
(`_logger.warning`) plutôt que de simuler un envoi réussi -- écart consigné,
`amoa/questions/L8-04-emergency-contact-relay.md`, **la limite la plus sérieuse de ce lot**.

**Critère 6, hors connexion.** Une file locale dédiée
(`packages/api-client/src/incident/offlineQueue.ts`, `PendingIncidentQueue`) -- pas une
généralisation de `realtime/queue.ts::ActionQueue`, qui documente explicitement ne connaître que
les messages WebSocket rejoués à la reconnexion : forcer un déclenchement REST hors connexion
dans ce contrat aurait étiré une portée déjà explicite pour un module minuscule qu'il est plus sûr
de dupliquer. `client.request()` (`@babana/api-client`) gagne un `idempotencyKey` optionnel
(critère nouveau, testé) -- sans lui, chaque tentative de rejeu après une coupure aurait obtenu
une nouvelle clé et aurait pu dupliquer un incident déjà reçu par le serveur dont la réponse se
serait perdue en chemin.

**Le geste, pas une boîte de dialogue** (spécification) : `Pressable` avec `onLongPress`
(800 ms) -- un relâchement avant ce délai n'a aucun effet, prouvé par test.

**Symétrique entre client et chauffeur, avec une différence assumée.** Côté client,
`EmergencyButton.tsx` obtient sa position via `../location` (déjà utilisé par `HomeScreen`,
L6-06). Côté chauffeur, **aucun écran de course en cours n'existe** (L6-11 à L6-14, jamais
construites -- vérifié dans le dépôt, aucune branche ne les nomme) : le composant existe, testé
en isolation (quatre tests), mais `getPosition` y est **injecté** plutôt qu'obtenu directement,
pour ne pas ajouter une dépendance de géolocalisation à une app qui n'a encore personne pour la
déclencher, et pour laisser à L6-13 le vrai choix (rappeler le GPS, ou réutiliser la dernière
position déjà en vol vers `position.update`). Écart consigné,
`amoa/questions/L8-04-driver-screen-gap.md` -- le critère 1 (« atteignable en un geste ») **n'est
pas vérifiable côté chauffeur ce soir**, faute d'écran où le vérifier.

Tests : 9 côté Odoo (modèle -- notification, snapshot du contact, course jamais interrompue,
traitement back-office ; contrôleur -- déclenchement client/chauffeur, états rejetés, propriété,
validation, rejeu par idempotence), 7 pour la file hors connexion (`@babana/api-client`), 1 pour
`idempotencyKey`, 7 côté app Client (`EmergencyButton.test.tsx`), 4 côté app Chauffeur.

**Fichiers.** Contrats : `packages/contracts/src/http/{incident,share}.ts`, `errors.ts` (+
`RIDE_NOT_ACTIVE`), `index.ts`. Odoo : `models/{babana_incident,babana_ride_share}.py`,
`babana_ride.py` (+`TOGETHER_STATES`), `controllers/{incident,share}.py`,
`controllers/internal.py` (+`resolve_share`), `views/babana_incident_views.xml`,
`security/ir.model.access.csv`, `__manifest__.py`. Service temps réel :
`src/odoo/share.ts`, `src/share/*`, `config.ts`, `server.ts`. `@babana/api-client` :
`src/incident/offlineQueue.ts`, `src/http/client.ts` (+`idempotencyKey`), `src/http/errors.ts`.
Apps : `apps/client/src/components/{EmergencyButton,ShareTripButton}.tsx`,
`apps/client/src/incidentQueue.ts`, `apps/client/src/screens/TrackingScreen.tsx`,
`apps/driver/src/components/EmergencyButton.tsx`, `apps/driver/src/incidentQueue.ts`.

### Vérification navigateur -- ce qui a marché, ce qui a buté, et pourquoi ce n'est pas pareil

**D45/D46 vérifiés de bout en bout** : session client réelle restaurée sur le banc à même origine
(`http://verify.localhost:8888`, D46), `GET /api/v1/me` à 200 sans préflight, aucune erreur
console. C'est le même banc, corrigé comme prévu, qui a servi toute la suite de la nuit.

**L8-03/L8-04 -- prouvés en direct jusqu'à un point précis, puis bloqués par un défaut réel,
préexistant, trouvé et documenté (pas contourné).** Chauffeur réellement mis en ligne et positionné
par le chemin réel (WebSocket) ; côté client, `HomeScreen` a affiché ce chauffeur réel, une vraie
sélection a déclenché une vraie réservation atomique, et **une vraie proposition a été reçue côté
chauffeur en temps réel** (montant, distance, compte à rebours réels) -- `WaitingScreen` affichée
avec ce compte à rebours. Au-delà de ce point, un défaut préexistant et sans lien avec les tâches
de ce soir (`amoa/questions/L3-05-nearby-list-goes-silently-empty.md`, commité séparément sur
`master`) a empêché de boucler jusqu'à `TrackingScreen` de façon fiable : la diffusion périodique
`nearby.drivers` (toutes les 5 s) cesse d'atteindre la connexion de longue durée de l'app sans
fermeture ni erreur, alors qu'une connexion neuve retrouve systématiquement le bon résultat au
même instant -- vérifié à répétition, root-causé avant d'être signalé, jamais juste observé.

**Ce que ça ne remet pas en cause** : L8-03 et L8-04 sont prouvés de bout en bout contre le
**vrai** Odoo par `test/http-contract/endpoint-coverage.test.ts` (critère 6 de C-01 -- un vrai
`fetch`, une vraie réponse, validée par son propre schéma, jamais fabriquée par le test) --
`triggerIncident`, `createRideShare`, `revokeRideShare` y sont exercés ce soir pour la première
fois, tous verts. Les composants `EmergencyButton`/`ShareTripButton` sont prouvés par appui long
réel, rejeu hors connexion réel, révocation réelle (React Test Renderer, pas des mocks de haut
niveau). Ce qui manque ce soir est la dernière jointure -- **voir ce défaut, dans un navigateur,
depuis `TrackingScreen`** -- pas la logique elle-même.

---

## Passe finale

`make reset && make up` puis toute la suite sur base fraîche, dans cet ordre :

- **Odoo** : `-i babana --test-enable`, **2255 tests, 0 échec, 0 erreur** (base entièrement neuve,
  modules standard compris -- pas seulement le sous-lot `babana`).
- **`npm run build/typecheck/lint --workspaces`** : propres sur tout l'arbre.
- **Suites par paquet** : `api-client` 58, `contracts` 70, `maps` 19, `navigation` 4, `realtime`
  167, `client` 96, `driver` 19 -- toutes vertes.
- **`test/` (concurrence, authentification, contrat HTTP)**, rejoué **seul**, jamais en parallèle
  d'une autre charge lourde (le faux échec de contention documenté cette nuit dans la première
  tentative, ressources partagées, pas un vrai défaut -- même mécanisme que J20) : **28 tests, 0
  échec**, y compris les 20 itérations x 8 appels simultanés des trois scénarios de concurrence et
  les trois nouveaux exercices `triggerIncident`/`createRideShare`/`revokeRideShare`.
- **`make verify`** : vert (santé Odoo, santé temps réel, back-office, `.well-known` à l'apex,
  objet MinIO refusé sans URL signée).
- **`make secrets-scan`** : même faux positif préexistant (`react-native-keychain.web.js`),
  toujours pas corrigé, toujours hors du périmètre d'une nuit qui ne le nomme pas -- vérifié que
  je n'en ai introduit aucun nouveau (le jeton d'exemple de `ShareTripButton.test.tsx` a été
  raccourci sous le seuil de détection pour cette raison précise, `git log` de ce soir).

---

## Ce qui reste ouvert

- **`amoa/questions/L3-05-nearby-list-goes-silently-empty.md`** (nouveau, ce soir) -- la
  diffusion périodique `nearby.drivers` meurt silencieusement sur une connexion de longue durée.
  Touche potentiellement `ride.track` (L3-09, même patron de connexion continue) : à traiter
  avant de considérer le suivi de course robuste sur un vrai réseau mobile intermittent.
- **`amoa/questions/L8-04-emergency-contact-relay.md`** (nouveau) -- aucun relais SMS réel pour le
  contact d'urgence, journalisé seulement. La limite la plus sérieuse du lot L8-04.
- **`amoa/questions/L8-04-driver-screen-gap.md`** (nouveau) -- le bouton d'urgence chauffeur n'a
  pas d'écran où vivre (L6-11 à L6-14 jamais construites).
- **`amoa/questions/L6-18-cors-api-web-quote.md`** -- toujours ouvert, hors périmètre de ce soir.
- Le lot Chauffeur, L3-12, L4-06, `make secrets-scan` (le faux positif à traiter proprement), la
  validation du plan comptable, la vérification développeur Android -- inchangés depuis J20.

## Doute pour un client réel

**Le même que celui qui a bloqué la vérification ce soir, et c'est le plus important de la nuit.**
Si la diffusion périodique `nearby.drivers` peut mourir silencieusement sur une connexion longue,
rien ne dit que `ride.track` (L3-09) -- le flux qui montre au client où est son chauffeur pendant
une vraie course -- ne fait pas exactement la même chose. `TrackingScreen` n'affiche une bannière
de déconnexion que si `connectionState !== 'connected'` : si la connexion reste *déclarée* ouverte
pendant que ses diffusions s'arrêtent, l'écran ne dirait rien du tout -- un client verrait son
chauffeur figé sur la carte, sans le moindre signal que quelque chose ne va pas. C'est précisément
le genre de défaut que ce dépôt existe pour attraper avant qu'il n'atteigne un vrai chauffeur, sur
un vrai réseau intermittent, avec un vrai client qui attend.

**Un doute secondaire, plus classique** : le contact d'urgence n'est aujourd'hui que journalisé,
jamais réellement notifié -- si un client renseigne ce champ en pensant qu'un proche sera prévenu
en cas de coup dur, c'est faux ce soir, et rien dans l'app ne le dit.
