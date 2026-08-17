# Rapport de nuit — J14

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-22.md` lu en entier avant d'ouvrir quoi que ce
soit — §1 et §2 arbitrent les deux ponts manquants du rapport J13 en une seule cause (D35) et sa
conséquence (D36).

---

## Vérification préalable, sur base fraîche

Demandée explicitement en tête de nuit : deux sessions consécutives sans confirmer la suite Odoo
et le test de concurrence, c'est une de trop (rapport J13 §« Vérification finale »).

`make up` : propre. Suite Odoo complète (`-i babana`, base fraîche) : **386 tests, 1 échec**
avant toute écriture de code cette nuit — `TestBabanaToken.test_rotate_produces_new_pair_and_invalidates_old`.
`npm test` (racine, y compris `test/concurrency` et `test/auth`, L4-11) : tout vert, y compris le
scénario 3 (encaissement concurrent). Un flake déjà documenté (`DisconnectGraceTimers`,
`services/realtime/test/availability.test.ts`) est réapparu sous charge combinée, reconfirmé isolé
(3 tests, 0 échec) — même défaut temporel que J12/J13, sans rapport avec cette nuit.

**L'échec Odoo n'était pas un défaut de production, mais un défaut du test lui-même**, découvert
en le lisant avant d'y toucher (CLAUDE.md, « une dépendance supposée absente se vérifie dans le
dépôt ») : `old_record = self.env["babana.token"].sudo().search([("token_hash", "!=", False)],
order="id asc", limit=1)` cherche le **plus ancien enregistrement de toute la table**, pas celui
du jeton émis par ce test. `test_auth.py` (HttpCase, requêtes HTTP réelles donc commitées, pas
annulées comme une TransactionCase) laisse des `babana.token` antérieurs dans la même base de
test — un tri par id global attrapait le mauvais enregistrement, un défaut latent qui ne se
manifestait que selon l'ordre d'exécution des suites. Corrigé en cherchant par le hachage du
jeton précisément émis par le test (même patron que `test_logout_revokes_only_that_token_not_the_family`,
juste en dessous dans le même fichier). Puisque D36 (à suivre) touche exactement ce fichier
cette nuit, la correction voyage avec lui plutôt que d'ouvrir une tâche à part.

---

## D35 — `GET /me`, JSON-RPC abandonné pour les apps

**Ce qui existait avant.** `01-architecture.md` §5 réservait les lectures secondaires (historique,
factures, profil) au JSON-RPC natif d'Odoo. Personne n'avait vérifié que ce JSON-RPC accepte le
jeton applicatif — il ne l'accepte pas, il authentifie par session de cookie ou par identifiants
explicites. Le code avait détourné `/auth/refresh` au démarrage pour obtenir malgré tout un profil
à jour.

**Contrat (C-01, `packages/contracts/src/http/auth.ts`).** L'objet utilisateur, jusque-là déclaré
inline dans `AuthSessionSchema.user`, devient `AuthenticatedUserSchema`, une définition partagée.
`MeResponseSchema` la réutilise telle quelle — « même schéma, une seule définition », littéralement
la même constante des deux côtés, pas deux schémas qui se ressemblent. `GET /me` entre au registre
`HTTP_ENDPOINTS` (`packages/contracts/src/http/index.ts`), `requiresAuth: true`, sans erreur
propre au-delà des erreurs implicites (`UNAUTHORIZED`, `TOKEN_EXPIRED`) : une lecture de profil ne
refuse jamais un chauffeur non approuvé, même raison que `/auth/google` critère 8. Vingtième
endpoint du contrat (`generate-json-schema.ts` : 19 → 20). `docs/contracts/http-api.md` mis à jour
dans la foulée.

**Odoo (`controllers/auth.py`).** Nouvelle route `GET /api/v1/me`, seule route de ce contrôleur
authentifiée par `Authorization: Bearer` (`_common.authenticated_user()`) plutôt que par un jeton
transmis dans le corps — les trois autres routes de ce fichier restent sur leur mécanisme propre
(`amoa/questions/L1-02.md`). `_build_session` et le nouvel handler partagent désormais
`_build_user_payload(user, picture=None)` : un seul point de construction du payload utilisateur
côté serveur, miroir du « une seule définition » côté contrat. Tests dans un nouveau
`tests/test_me_controller.py` (profil client, profil chauffeur `pending` avec son statut, jeton
manquant, jeton illisible, jeton expiré) — même patron que `test_driver_cash_controller.py`.

**Client (`packages/api-client`, apps).** `AuthClient.refreshUser(httpClient)` (nouveau,
`session.ts`) appelle `GET /me` et remplace `state.user` sans toucher aux jetons. Il prend le
client HTTP en paramètre plutôt que d'utiliser `this.config.httpClient` : c'est le client enrobé
de renouvellement transparent (`withTransparentRefresh`, construit à l'extérieur d'`AuthClient` à
partir de cette même instance) qu'il faut lui passer, pour que le renouvellement redevienne une
réaction à une expiration plutôt qu'un appel systématique — exactement ce que la nuit demandait.
Les deux `navigation/index.tsx` (Client, Chauffeur) appellent `authClient.refreshUser(apiClient)`
à la place de l'ancien `authClient.refresh()` proactif ; le commentaire qui expliquait le
détournement est réécrit pour expliquer la solution. Tests mis à jour dans les deux
`AppNavigator.test.tsx` (mock `refreshUser` au lieu de `refresh`) et un nouveau cas dans
`session.test.ts`.

**`createJsonRpcClient` n'a pas été retiré.** Il ne coûte rien (un seul fichier, testé contre un
double, aucune dépendance nouvelle) et aucune tâche ne s'appuie dessus depuis L6-03 — le retirer
serait une suppression de code fonctionnel sans bénéfice mesurable ce soir. À reconsidérer si une
tâche future (L6-10 ?) confirme qu'aucune lecture ne l'utilisera jamais.

Vérifié : suite `@babana/contracts` (65 tests), `@babana/api-client` (49 tests), suite Odoo ciblée
puis complète (390 tests sur base fraîche, 0 échec), `@babana/client` (11 tests), `@babana/driver`
(15 tests), `npm run typecheck --workspaces` propre sur les onze paquets/apps.

---

## D36 — fenêtre de grâce sur la rotation du jeton de renouvellement

**Le problème que la relecture a trouvé, pas le rapport J13.** La rotation (L1-02) révoque toute
la famille à la réutilisation d'un jeton consommé — bonne règle contre le vol, mauvaise hypothèse
sur le réseau : une coupure entre l'envoi du jeton et la réception de son remplaçant laisse
l'ancien consommé côté serveur et rien de nouveau côté téléphone. Sans fenêtre, l'app suivante
présente ce seul jeton et perd toute sa famille.

**Modèle (`models/babana_token.py`).** Deux champs nouveaux sur `babana.token`, uniquement posés
à la rotation : `rotated_at` (horodatage de la rotation, borne de la fenêtre) et `next_raw_token`
(le jeton de renouvellement en clair déjà émis en remplacement). `_rotate` distingue désormais
trois cas à la présentation d'un jeton non actif :

- `state == 'rotated'` **et** dans la fenêtre (`ir.config_parameter`,
  `babana.token_reuse_grace_seconds`, défaut 30 s) : renvoie `record.next_raw_token` tel quel — le
  couple déjà émis, ni révocation, ni troisième jeton.
- `state == 'rotated'` et hors fenêtre : efface `next_raw_token` (il ne sert plus à rien, ne doit
  pas traîner en clair indéfiniment), révoque la famille, comportement d'avant D36.
- `state == 'revoked'` (vol déjà détecté, suspension, déconnexion explicite) : révoque
  immédiatement, **jamais** de fenêtre de grâce — ce n'est pas le même scénario qu'une rotation
  naturelle interrompue par le réseau.

**L'écart signalé — `amoa/questions/L1-02.md`.** Renvoyer le même jeton en clair à une seconde
présentation suppose de l'avoir gardé sous une forme récupérable, alors que C-01 décrit le jeton
de renouvellement comme une valeur dont « seul le haché est stocké ». Les deux principes se
contredisent littéralement dès que D36 exige un rejeu bit-à-bit. Retenu : conserver le jeton
remplaçant en clair sur l'enregistrement qui vient d'être remplacé, le temps de la fenêtre
seulement, effacé au premier accès qui la constate dépassée — une dérogation bornée et documentée
dans le `help` du champ, pas silencieuse. L'`accessToken`, lui, n'a pas besoin d'être rejoué à
l'identique (JWT sans état côté serveur) : une réémission fraîche à chaque rejeu ne casse rien et
donne au client une validité pleine. Deux options écartées et pourquoi : détaillées dans le
fichier d'écart. Réserve consignée : aucun nettoyage périodique n'efface `next_raw_token` pour un
jeton jamais représenté après rotation — inerte au-delà de la fenêtre, mais présent en base tant
que personne ne retente ce jeton précis.

**Test pré-existant devenu faux par construction, corrigé plutôt qu'ignoré**
(`test_auth.py::test_refresh_rotates_and_old_refresh_token_becomes_unusable`) : il vérifiait
qu'une réutilisation *immédiate* révoque toujours la famille — exactement le cas que D36 rend
légitime. Réécrit pour vieillir explicitement l'horodatage de rotation d'une heure avant de
rejouer (`rotated_record.write(...)`, `flush_recordset(["rotated_at"])`), donc vérifier le
comportement **au-delà** de la fenêtre plutôt que de dépendre d'un délai de grâce à zéro — une
fenêtre à zéro n'est pas fiable sur deux requêtes HTTP consécutives dans le même worker de test,
`fields.Datetime.now()` étant tronqué à la seconde (précision de stockage) : deux appels dans la
même seconde d'horloge auraient un écart nul, donc « dans » n'importe quelle fenêtre y compris
zéro. Nouveau test complémentaire pour le rejeu dans la fenêtre
(`test_replaying_a_just_rotated_token_within_the_grace_window_replays_the_same_pair`), bout en
bout par vraies requêtes HTTP.

**Critère 3 bis testé aux deux bornes, au niveau modèle** (`test_token.py`, `TransactionCase`,
horodatage manipulé directement plutôt que dépendre du temps réel écoulé) :
`test_reuse_within_the_grace_window_replays_the_same_pair` (9 s sur une fenêtre de 10 s — dans la
fenêtre, couple identique renvoyé, rien révoqué) et
`test_reuse_past_the_grace_window_still_revokes_the_family` (11 s sur une fenêtre de 10 s — hors
fenêtre, famille révoquée, `next_raw_token` effacé). Plus
`test_reusing_an_explicitly_revoked_token_ignores_the_grace_window` (un jeton `revoked` n'a jamais
droit à la fenêtre, même présenté immédiatement).

**Deux pièges trouvés en écrivant ces tests, tous deux déjà documentés ailleurs dans le dépôt mais
retrouvés à la dure plutôt que consultés d'abord — à noter pour la prochaine fois.**

1. **`flush_recordset()` manquant après une écriture manuelle d'horodatage.** Écrire
   `rotated_at` sur un enregistrement puis appeler aussitôt `_rotate()` (qui relit par
   `search()`, une requête SQL) peut lire une valeur non poussée en base dans la même
   transaction — exactement le piège déjà consigné dans `code/docs/odoo-pitfalls.md`
   (« tout code qui s'appuie sur une contrainte au niveau base doit provoquer le vidage avant de
   la déclencher », généralisé ici à toute relecture SQL directe après un `write()`). Corrigé par
   `flush_recordset(["rotated_at"])`, comme `test_routing.py` le fait déjà pour un besoin
   identique.
2. **`self.assertRaises` (TransactionCase) ouvre un savepoint qu'il annule à la sortie.** Un test
   qui observe un *effet secondaire persistant* de l'exception (ici : la révocation de la famille,
   l'effacement de `next_raw_token`) doit utiliser `try`/`except` explicite, pas
   `self.assertRaises` — sans quoi l'assertion suivante voit un état annulé, pas l'état réel.
   **Ce piège était déjà écrit en commentaire** dans ce même fichier, sur
   `test_reusing_a_rotated_token_revokes_the_whole_family`, à quelques lignes du nouveau test qui
   vient de le reproduire à l'identique. Trouvé par un échec confus (« TokenReused not raised »
   sur un appel dont le fait même de tracer pas à pas montrait la bonne exception levée un peu
   plus haut dans la même fonction) plutôt que par la lecture du commentaire voisin — la leçon
   était déjà là, elle n'a pas été relue avant d'écrire le test qui l'a redécouverte.

Vérifié : suite Odoo ciblée (`TestBabanaToken`, `TestAuthRefreshAndLogout`, `TestMeController`,
`TestGoogleAuth`, 28 tests, 0 échec) puis suite complète sur la même base (390 tests, 0 échec).

---

## L3-11 — Reconnexion et rattrapage d'état, côté serveur

**Le pont manquant depuis L6-04.** Le client (J13) sait déjà envoyer `session.resync` à
l'ouverture et rejouer sa file d'actions ; personne ne répondait. `session.resync` sortait donc
du `default:` silencieux de `ws/dispatch.ts`, sans jamais de `session.synced` en retour.

**Source de vérité : Odoo, interrogé à chaque resynchronisation, rien lu dans Redis.**
`services/realtime` ne garde aucune trace durable de l'état d'une course (invariant 1) — la
réponse à `session.resync` ne pouvait donc venir que d'un appel sortant vers Odoo, même famille
que `fetchEngagedDriverIds` (L3-17, réconciliation) : bloquant pour son appelant, à la différence
des notifications d'acceptation/refus qui ne bloquent jamais personne. Nouvel endpoint interne,
`POST /api/internal/session/active-ride` (`controllers/internal.py`), authentifié par le même
secret partagé que le reste de ce fichier. Il réutilise `CLIENT_ACTIVE_STATES` /
`DRIVER_ACTIVE_STATES` (`babana_ride.py`, déjà la définition de « une seule course active » qui
porte l'index unique partiel) — pas une nouvelle notion d'« actif » inventée pour l'occasion.

**`lastKnownRideId` sert à quelque chose, pas seulement transmis.** Avec l'invariant « une seule
course active par acteur », il n'y a jamais d'ambiguïté sur QUELLE course chercher tant qu'une
est active. Mais un client qui se reconnecte juste après que sa course est passée `completed`
(hors de `CLIENT_ACTIVE_STATES` — l'encaissement n'est pas bloquant, un nouveau `requested` peut
déjà être créé) recevrait `activeRideId: null` : un néant ambigu, indistinguable d'« aucune
course n'a jamais existé ». À défaut de course active, l'endpoint relit la course précise
désignée par `lastKnownRideId` et renvoie son état réel, quel qu'il soit — **toujours filtré par
propriété** (le `client_id`/`driver_id` de l'appelant), un identifiant public étant présentable
par n'importe qui : un jeton valide ne doit jamais suffire à lire l'état de la course de
quelqu'un d'autre en devinant son identifiant. Testé explicitement
(`test_active_ride_never_leaks_a_ride_that_does_not_belong_to_the_caller`).

**Dégradation silencieuse si Odoo est injoignable.** `ws/resync.ts` catch l'échec, le journalise,
et n'envoie rien — jamais `activeRideId: null` par défaut sur une panne réseau, ce qui laisserait
croire à tort qu'aucune course n'est en cours (même risque que la disparition de chauffeur
décrite en D30, transposée à une course). La connexion reste ouverte, le rejeu de la file
d'actions locale (déjà en cours côté client, indépendant de cette réponse) n'attend pas
`session.synced` pour continuer.

**Un état complet à chaque fois, jamais mémorisé, jamais un différentiel** — literalement : la
fonction ne connaît que la dernière réponse d'Odoo, aucun état intermédiaire n'est conservé entre
deux appels. `serverTime` posé à l'envoi, pas à la réception de la requête Odoo (l'écart entre
les deux est de l'ordre de la milliseconde, sans intérêt à distinguer).

**Tests.** Service (`test/resync.test.ts`, faux serveur Odoo local comme `reconcile.test.ts`) :
état complet renvoyé une fois, aucune course active, identité prise du contexte de connexion
jamais du message (même garde-fou que L3-01), `lastKnownRideId` transmis, socket déjà fermé
n'écrit rien, panne Odoo dégradée silencieusement. Odoo (`test_internal_controller.py`, nouvelle
section) : validation des champs requis, utilisateur inconnu (nulls, pas une erreur), course
active pour un client, pour un chauffeur, aucune course active, repli sur `lastKnownRideId`
quand la course est `completed`, **fuite refusée** quand `lastKnownRideId` désigne la course d'un
autre utilisateur, secret manquant.

**Un flake de plus, sous charge combinée, ni nouveau ni lié à cette tâche.** La suite complète du
service (`npm test -w @babana/realtime`, exécution parallèle par fichier du test-runner Node) a
fait échouer tantôt `proposal.test.ts` (critère 1), tantôt `reservation.test.ts` (critère 5), en
plus du `DisconnectGraceTimers` déjà documenté J12/J13 — tous des minuteurs sensibles au temps
réel écoulé, aucun touché par cette tâche. Reconfirmé : chaque fichier isolé passe systématiquement,
et la suite entière passe intégralement (118 tests, 0 échec) avec `--test-concurrency=1` (exécution
séquentielle plutôt que parallèle par fichier). Ce n'est plus un cas isolé (un seul fichier
documenté jusqu'ici) mais une famille de tests sensibles au parallélisme du test-runner sous
charge — à signaler pour arbitrage : soit border ces minuteurs avec une marge plus généreuse, soit
figer `--test-concurrency=1` pour ce paquet en CI. Pas corrigé cette nuit, hors du périmètre de
L3-11, mais plus une réserve mineure maintenant que trois fichiers distincts y sont sujets.

Vérifié : `test/resync.test.ts` (6 tests), suite Odoo ciblée
(`TestInternalController`, 17 tests) puis complète sur base fraîche (398 tests, 0 échec),
`npm run typecheck --workspaces` propre, `npm run lint --workspaces` propre.

---

## L6-06 — App Client, écran d'accueil

Lu avant d'écrire : L6-07 (ce que l'écran doit lui transmettre) et L3-05 (les garde-fous déjà
posés côté serveur pour `nearby.drivers`, notamment l'arrondi des positions et la dégradation
D30 sur un profil manquant).

**Le réticule avant la recherche, comme demandé.** `PlacePicker` (recherche textuelle) est un
composant autonome, complément et non préalable : la désignation principale se fait en glissant
la carte sous un réticule fixe (`@babana/maps`, `MapViewProps.onRegionChange`) -- déjà branché sur
`onRegionChangeComplete` côté fournisseur Google (`packages/maps/src/providers/google/MapView.tsx`,
posé par L6-01), donc le géocodage inverse ne se déclenche déjà qu'au relâchement du geste, jamais
par frame : rien à changer là, juste à le consommer correctement. Testé explicitement (`critère
2`) : le parcours complet (départ, bascule vers l'arrivée, désignation, activation de « Suivant »,
navigation vers `Quote`) passe sans que `searchPlace` soit appelé une seule fois.

**Position du client, capture ponctuelle -- premier écran du dépôt à en avoir besoin.** Aucun
précédent (L6-05, capture continue côté chauffeur, n'existe pas encore). `location.ts` /
`location.web.ts`, séparés par l'extension de plateforme que Metro et webpack résolvent tous deux
nativement (même mécanisme que `index.web.tsx`, D22) -- zéro `Platform.OS` dans l'écran. Vérifié
que le bundle web n'embarque jamais `@react-native-community/geolocation` (`grep` sur
`dist-web/bundle.js` : 0 occurrence, `navigator.geolocation` présent une fois). `location.web.ts`
exclu de `tsconfig.json` (comme `index.web.tsx` déjà, `lib` sans DOM) -- vérifié uniquement par
`build:web`, jamais par `tsc`. Permissions natives posées : `ACCESS_FINE_LOCATION`
(AndroidManifest.xml) et `NSLocationWhenInUseUsageDescription` (Info.plist, déjà présent vide --
scaffold anticipé, seul le texte manquait). Un refus ne bloque jamais l'écran (testé) : la carte
reste sur Douala, le départ reste à désigner à la main.

**Chauffeurs proches, mis à jour en direct, recentrés sur le départ.** `nearby.subscribe` porte la
position du départ une fois connu (GPS ou désignation manuelle), pas la position brute de la
carte -- `region` bouge à chaque glissement pour l'arrivée aussi, ce qui ne doit jamais rouvrir un
abonnement (`useEffect` indexé sur `departure.position` seule, exhaustive-deps désactivé
explicitement pour cette raison précise, écrite dans le commentaire plutôt que suffixée en
silence). Premier consommateur réel de `createRealtimeClient` (L6-04) : `apps/client/src/
realtime.ts`, un singleton au niveau de l'app (comme `authClient`/`apiClient`), pas de l'écran --
la connexion doit survivre à la navigation vers les écrans suivants.

**Trouvé en écrivant cet écran, pas dans le rapport J13 : la reconnexion ne réémettait aucun
abonnement.** `nearby.subscribe` n'est pas une action de la file persistante (positions et
abonnements en sont délibérément exclus, L6-04) -- une coupure réseau puis un retour rouvre un
socket sans mémoire de l'abonnement précédent, et rien ne le réémettait. Sur un réseau qui coupe
couramment (CLAUDE.md), la liste de chauffeurs se serait figée silencieusement à la première
coupure de la session, sans le moindre signal d'erreur. Corrigé avant de considérer la tâche finie
plutôt que simplement noté : `onRealtimeConnectionStateChange` diffuse désormais les transitions
de `createRealtimeClient` (`onConnectionStateChange`, déjà dans le contrat de L6-04, jamais câblé
jusqu'ici) ; HomeScreen réémet son abonnement à chaque passage à `'connected'`, initial ou non.
Testé explicitement.

**Aucun chauffeur : message clair et une action, jamais une erreur technique (critère 4).** Testé.
`DriverMarker` (D30) : prénom, note (ou « Nouveau » si absente ou insuffisante, jamais une note à
zéro), gamme, distance -- jamais au mètre près sous 1 km (palier de 50 m, arrondi cohérent avec la
précision déjà appliquée par le serveur, L3-05), au dixième de km au-delà. Avatar générique si le
profil manque.

**Ce qui n'existe nulle part encore et n'était pas dans le périmètre ce soir** : `Quote`
(`ClientParamList`) porte désormais `{ origin: RidePoint, destination: RidePoint }` (`position` +
`label`) -- choix d'implémentation pour que L6-07 affiche « prise en charge : <label> » sans
reformuler des coordonnées brutes, pas une spécification de L6-07 anticipée au-delà de son
interface d'entrée.

**Une dépendance nouvelle, signalée** : `@react-native-community/geolocation` (^3.4.0),
`apps/client` seulement (jamais `apps/driver`, qui n'a pas encore son propre besoin, L6-05). Aucun
équivalent RN natif encore présent dans le dépôt.

**Un ajout à `@babana/ui`** : `Button` accepte désormais `testID` (prop optionnelle, transmise au
`Pressable` sous-jacent) -- rien d'autre n'existait pour cibler un bouton précis dans un arbre qui
en contient plusieurs, un besoin qui n'existait pas avant le premier écran à plusieurs boutons.

### Tests

`HomeScreen.test.tsx` (8 cas, `@babana/maps` et `../realtime` mockés à leur frontière -- même
discipline que le mock de `../auth` dans `AppNavigator.test.tsx`) : les cinq critères
d'acceptation, plus la réémission d'abonnement à la reconnexion, le pré-remplissage GPS, le refus
de permission non bloquant. `PlacePicker.test.tsx` (4 cas) : seuil minimal avant recherche,
temporisation avant l'appel réseau, sélection qui vide et referme, une réponse tardive d'une
recherche abandonnée qui n'écrase pas la plus récente. `DriverMarker.test.tsx` (5 cas) : D30,
mention « nouveau », les deux paliers d'arrondi de distance. `location.test.ts` (4 cas) : iOS et
Android, succès et refus, jamais d'exception propagée. `AppNavigator.test.tsx` (Client) : `Home`
mocké (même raison que `SignInScreen` déjà mocké) -- un écran métier réel y ouvrirait une connexion
temps réel et demanderait la position, hors du périmètre de ce fichier.

**Un avertissement de test resté sans confirmation.** `npm test -w @babana/client` se termine avec
"a worker process has failed to exit gracefully" -- un minuteur de `VirtualizedList` (interne à
`FlatList`, utilisé par `PlacePicker` et la liste de chauffeurs) se déclenche après la fin d'un
test, sans effet sur le résultat (31 puis 32 tests, 0 échec, code de sortie 0) mais assez bruyant
pour mériter d'être noté plutôt que tu. Pas creusé ce soir -- probablement un `act()` manquant
autour d'un minuteur interne à `@react-native/virtualized-lists`, pas un défaut de cet écran.

Vérifié : `npm run typecheck --workspaces` propre, `npm run lint --workspaces` propre (deux
avertissements `no-void` dans `realtime.ts` corrigés en cours de route -- remplacés par une
gestion explicite de l'échec plutôt qu'un `void` qui aurait aussi laissé filer une rejection non
gérée sur `authClient.refresh()`), `npm run build:web` (`apps/client`) : succès, bundle inchangé
en taille notable, aucune trace du module natif de géolocalisation.

### Vérification finale de la nuit, sur base réellement fraîche

`make reset` puis `make up` (dû : D35 et D36 touchent Odoo). Suite Odoo complète -- sans
`--test-tags` cette fois, donc les modules de base réinstallés à partir de rien, pas seulement
`babana` sur une base déjà chargée : **2197 tests, 0 échec, 0 erreur** (~13 minutes, une base
vraiment neuve coûte largement plus que les réinstallations `-i babana` de la nuit). `npm test`
(racine, y compris `test/concurrency` et `test/auth`) relancé proprement ensuite (une première
tentative interrompue par mon propre `make reset` lancé trop tôt, en parallèle -- deux échecs de
scénarios de concurrence causés par l'infrastructure disparue sous leurs pieds, pas par le code ;
non retenus) : **vert intégralement, code de sortie 0**, y compris la vérification structurelle de
la machine à états (C-03, 9 états, 13 transitions, 7 événements métier). C'est la première fois en
quatre nuits que la nuit se termine sur une base fraîche vérifiée du premier coup à la bonne
étape -- le protocole du 12 août (« la base de développement est jetable ») tenu jusqu'au bout.

### Ce qui me laisse un doute, pour un chauffeur ou un client réel

**Le géocodage inverse n'a aucun moyen de dire qu'il s'est trompé.** Dans les quartiers non
cartographiés de Douala -- la majorité de la ville, en dehors des grands axes -- l'API renvoie
souvent le nom du repère connu le plus proche plutôt qu'une absence : un libellé plausible mais
qui peut correspondre à un point à plusieurs centaines de mètres du réticule réel. L'écran affiche
ce libellé avec la même confiance qu'une adresse exacte, sans aucun signal de proximité ou de
confiance. Un client qui fait confiance au texte plutôt qu'à la position réelle du réticule
pourrait se tromper de repère sans qu'aucun élément de l'écran ne l'alerte -- je n'ai pas de bonne
réponse à ça cette nuit au-delà de rappeler, dans l'interface, que c'est la carte qui fait foi.

**L'échec de la géolocalisation n'est jamais expliqué.** Refus de permission, GPS indisponible,
délai de 10 secondes dépassé : les trois aboutissent au même état silencieux (« Glissez la carte
ou recherchez »). Un chauffeur pressé qui voit l'écran attendre dix secondes sans rien afficher
avant de retomber sur ce message générique n'a aucun moyen de savoir s'il doit réessayer, aller
dans les réglages du téléphone, ou simplement designer son point à la main -- les trois causes
demandent une réaction différente, et l'écran n'en distingue aucune.

**Le bouton « Réessayer » peut heurter la limitation de débit sans le savoir.** `nearby.subscribe`
est limité par utilisateur côté serveur (L3-05, critère 6) ; un abonnement au-delà de la limite est
silencieusement ignoré -- ni erreur, ni confirmation. Un client qui tape plusieurs fois sur
Réessayer, croyant relancer une recherche qui n'a rien donné, pourrait finir par ne plus recevoir
aucune réponse à ses tentatives, sans que rien ne le lui indique. Le contrat C-02 ne prévoit
aujourd'hui aucun accusé de réception distinct pour `nearby.subscribe` -- corriger cela dépasse le
périmètre de cet écran, mais l'écran hérite du silence.

---

## Ce qui reste ouvert pour la prochaine session

Le lot du soir (D35, D36, L3-11, L6-06) ferme les deux ponts manquants signalés le 22 août et ouvre
le premier écran métier du lot L6 -- la nuit prochaine peut enchaîner L6-07 (estimation et choix du
chauffeur, qui reçoit déjà `{ origin, destination }` de `Quote`) sans pont ouvert derrière elle,
pour la première fois depuis le début du lot L6.

1. **Les trois doutes de L6-06** (ci-dessus) -- aucun n'est un défaut à corriger dans le périmètre
   de cet écran, mais tous les trois se reposeront dès L6-07/L6-08 : un montant basé sur un point
   mal géocodé, un chauffeur qui ne sait pas pourquoi sa position ne se met pas à jour, un client
   qui martèle un bouton sans réponse.
2. **`L3-12`** -- file persistante avec rejeu côté service temps réel. Inchangé depuis J10.
3. **`L4-06`** -- la facture. Inchangé.
4. **La validation du plan comptable** -- trois questions à poser au comptable, inchangé.
5. **La vérification développeur Android** -- inchangé.
6. **Le flake sous charge combinée** (`@babana/realtime`, trois fichiers désormais :
   `DisconnectGraceTimers`, `ProposalLifecycle` critère 1, `reserveDriver/releaseDriver` critère
   5) -- à arbitrer : marge plus généreuse sur ces minuteurs, ou `--test-concurrency=1` figé pour
   ce paquet en CI.
7. **L'avertissement `VirtualizedList` non wrappé dans `act()`** (`@babana/client`, tests utilisant
   `FlatList`) -- sans effet sur le résultat, jamais creusé.

