# Rapport de nuit — J15

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-23.md` lu en entier avant d'ouvrir quoi que ce
soit. §1 passe avant tout le reste : c'est une correction de sécurité, pas une tâche du lot.

---

## D37 — le jeton rejouable est chiffré, rien ne survit à la fenêtre

**Ce que le rapport J14 avait sous-estimé.** `amoa/questions/L1-02.md` posait la bonne question
(rejouer un jeton exige de le garder récupérable, un haché ne s'inverse pas) mais concluait à une
« conséquence acceptée à surveiller » — un vestige rare, borné à la fenêtre de grâce. La relecture
demandée cette nuit a montré que ce n'était pas le cas : `next_raw_token` n'était effacé qu'à une
**représentation tardive** de l'ancien jeton, un chemin qui ne s'exécute jamais dans le cas normal
(le client reçoit son nouveau jeton et ne repasse plus l'ancien). Chaque renouvellement laissait
donc en base, **définitivement**, le jeton de renouvellement actuellement valide de l'utilisateur,
en clair. Pas un vestige — le jeton vivant. Un vidage de base aurait donné la session de chaque
utilisateur ayant renouvelé une fois.

**Tests écrits en premier, vus rouges.** Avant de toucher au modèle :
`test_next_token_is_never_stored_in_clear` (lit `babana_token` par SQL brut, pas par le nom du
champ — sinon on ne prouve que « le champ qu'on a choisi de lire est absent », pas que la valeur
en clair n'existe nulle part sur la ligne) et
`test_cron_purges_ciphertext_past_grace_window_even_if_nobody_returns` (le cas normal : un client
qui renouvelle et ne repasse jamais). Les deux échouaient contre le code d'avant cette nuit — le
premier parce que `next_raw_token` contenait bien le jeton en clair, le second parce qu'aucune
tâche périodique n'existait.

**Correctif : `next_raw_token` → `next_token_ciphertext`.** Le remplaçant est chiffré (AES-256-GCM,
`cryptography`, déjà tiré transitivement par `PyJWT[crypto]` — aucune dépendance nouvelle, seulement
un import direct désormais documenté dans `services/odoo/Dockerfile`) avec une clé dérivée par
SHA-256 du jeton **présenté** à cette ligne, jamais stockée elle-même. Séparation de domaine entre
cette clé et `token_hash` (préfixe distinct) : les deux dérivent du même jeton en clair, mais ne
sont jamais la même valeur — défense en profondeur peu coûteuse, pas une nécessité cryptographique
stricte.

Le client qui a le droit de rejouer est exactement celui qui possède l'ancien jeton : il fournit
donc du même geste la clé de son remplaçant. Un vidage de la base ne donne rien de déchiffrable,
puisque la clé n'y est jamais écrite — seul son haché SHA-256 (`token_hash`, préexistant) l'est,
et un haché ne s'inverse pas.

**Nettoyage périodique, pas seulement à la prochaine présentation.** Nouveau
`ir.cron` (`data/cron.xml`, toutes les minutes) appelant
`babana.token._cron_purge_expired_replay_ciphertext()` : efface `next_token_ciphertext` sur toute
ligne `rotated` dont `rotated_at` dépasse la fenêtre de grâce configurée, sans attendre qu'un
client vienne redemander ce jeton précis. C'est la pièce qui manquait à J14 — signalée comme
question ouverte dans `L1-02.md`, maintenant tranchée.

**Fichiers.** `services/odoo/addons/babana/models/babana_token.py` (champ, chiffrement/
déchiffrement, cron), `services/odoo/addons/babana/data/cron.xml` (nouvel `ir.cron`),
`services/odoo/addons/babana/tests/test_token.py` (deux tests neufs, un renommage de champ dans
un test existant), `services/odoo/Dockerfile` (commentaire), `amoa/questions/L1-02.md` (section
« Résolu — D37 » ajoutée). D37 était déjà consigné dans `amoa/01-architecture.md` par le débrief
J14 — rien à y changer, seulement à implémenter.

**Vérification.** Suite Odoo complète sur base fraîche (`make reset && make up`, `-i babana`) :
**400 tests, 0 échec**, y compris les 15 de `TestBabanaToken`. `npm test` racine : vert (voir
« Vérification finale » en fin de rapport pour la sortie complète, tenue une seule fois pour
l'ensemble de la nuit plutôt que répétée tâche par tâche).

**Ce que je retiens.** La même leçon que D26/D33, redite dans le débrief J14 : une décision qui
ajoute une commodité peut retirer une garantie posée ailleurs sans qu'aucune des deux ne paraisse
fausse isolément. Ici la garantie perdue était une propriété de sécurité, et rien ne la vérifiait —
elle vivait dans une phrase de contrat (« seul le haché est stocké »), pas dans une assertion.
Les critères 3 ter et 3 quater la rendent désormais mécanique : un test qui lit la table, pas un
test qui relit l'intention.

---

## Les trois doutes de L6-06

Les trois arbitrages du débrief J14 §2, implémentés ensemble puisqu'ils touchent le même écran et
partagent un même fil : ce qu'un client réel comprend d'un signal qu'on lui montre.

**§1 — « vers <lieu> », pas un fait.** `labelFor` (`HomeScreen.tsx`) préfixe désormais tout
libellé issu du géocodage inverse par `vers `, et un rappel permanent sous la carte (`📍 C'est le
point sur la carte qui fait foi, le libellé n'est qu'une indication.`) — visible en toute
circonstance, pas seulement pendant le géocodage. Le résultat d'une recherche textuelle
délibérée (`PlacePicker` → `handlePlaceSelected`) ne passe jamais par `labelFor` et garde son
libellé exact : ce n'est pas une approximation du même genre, c'est un choix explicite du client.

**§2 — trois échecs, trois messages.** `getCurrentPosition` ne renvoie plus `LatLng | null` mais
`LocationResult` (`apps/client/src/location.types.ts`, nouveau fichier neutre importé par
`location.ts` ET `location.web.ts` — une seule table de correspondance des codes d'erreur
`GeolocationPositionError` du standard W3C, partagée entre natif et web plutôt que dupliquée).
Trois `reason` distincts (`permission-denied`, `position-unavailable`, `timeout`), trois messages
et un bouton « Réessayer » qui relance la capture (`retryLocation`, factorisée depuis l'effet de
montage pour être rejouable). Le départ reste désignable à la main dans les trois cas, sans
changement de ce côté.

**§3 — un silence est le pire retour possible pour une limitation de débit.** Nouveau message
`nearby.subscribe.ack` (C-02, `NearbySubscribeAckPayloadSchema`, discriminé sur `accepted` :
`{accepted: true}` ou `{accepted: false, retryAfterMs}`) — répond désormais à **chaque**
`nearby.subscribe`, jamais seulement aux acceptés. `NearbyManager.allowSubscribe`
(`services/realtime/src/nearby/handler.ts`) renvoie maintenant `{allowed, retryAfterMs?}` plutôt
qu'un booléen : le délai est calculé depuis la plus ancienne tentative retenue dans la fenêtre de
débit, pas une constante. Côté écran, un état `subscribeRefusal` distinct de `nearbyDrivers`
vide : « Votre demande n'a pas été prise en compte, patientez N s avant de réessayer » plutôt que
la confusion avec « Aucun chauffeur disponible ». Effacé dès qu'une liste de chauffeurs arrive à
nouveau.

**Effet de bord assumé sur les tests existants.** `NearbyManager` répond désormais toujours (au
lieu de rien, sur refus) : les trois tests de `nearby.test.ts` qui comptaient les messages ont dû
être réécrits pour filtrer par type (`driverListMessages`, `ackMessages`) plutôt que de supposer
que "tout message reçu est une liste de chauffeurs" — c'était vrai avant cette nuit, plus
maintenant. Même chose côté contrat : `packages/contracts` rebuild (`npm run build -w
packages/contracts`) nécessaire avant que les autres paquets voient le nouveau type dans
`dist/` — noté ici parce que ce n'est pas automatique dans ce monorepo (pas de `pretest` qui
reconstruit les dépendances de workspace).

**Fichiers.** `packages/contracts/src/realtime/server-to-client.ts` (+test),
`docs/contracts/realtime-events.md`, `services/realtime/src/nearby/handler.ts` (+test),
`apps/client/src/location.types.ts` (nouveau), `apps/client/src/location.ts`,
`apps/client/src/location.web.ts` (+test), `apps/client/src/screens/HomeScreen.tsx` (+test).

**Vérification.** `packages/contracts` (66 tests), `services/realtime` (test/nearby.test.ts, 8
tests, contre Redis réel) et `@babana/client` (41 tests, jest) tous verts. `tsc --noEmit` sur les
quatre paquets touchés (contracts, realtime, api-client, client) sans erreur. Suite complète du
service temps réel (`npm test`, `services/realtime`) : le flake déjà documenté
(`DisconnectGraceTimers`, J14 rapport §4, minuteurs sous charge combinée) réapparaît de façon
intermittente, reconfirmé isolé (3/3 tests verts) -- sans rapport avec cette nuit, non traité
comme convenu (« à traiter quand il gênera »).

---

## L6-07 — estimation, détail décomposé, choix du chauffeur

`QuoteScreen.tsx` : appel à `/quote` au montage et à chaque changement de gamme (toggle
Standard/Confort, toujours proposé -- rien ne dit aujourd'hui côté serveur qu'une gamme serait
indisponible dans une zone, donc pas de condition à vérifier avant de l'afficher). Montant en
gros, détail décomposé juste dessous **sans dépliant** (D20, critère 1) : prise en charge,
distance toujours affichées ; majoration, remise, ajustement plancher, arrondi seulement quand
non nulles -- une ligne à zéro ne change rien à la somme, l'identité « les composantes affichées
somment exactement le total » (L2-03, critère 4) tient donc qu'elle soit montrée ou non. Distance
et ETA corrigé (`≈ N min`, É8/L10-03 -- le facteur vaut 1.0 aujourd'hui, non calibré, donc pas de
fausse précision à la minute ni à la seconde). Compte à rebours de validité ; à expiration,
`USER_MESSAGES.QUOTE_EXPIRED` et un bouton « Réactualiser », jamais un échec sec.

**Aucun calcul de tarif dans l'app** (critère 5) : `quote.amount` et `quote.breakdown` sont
affichés tels que reçus. La seule arithmétique côté client est `Math.abs()` pour l'affichage du
signe de la remise -- pas une règle métier, une mise en forme.

**Les 5 chauffeurs viennent d'un cliché, pas d'un second abonnement.** `HomeScreen` passe sa
liste `nearbyDrivers` (déjà tenue à jour en direct par L3-05) dans les paramètres de navigation
plutôt que de faire ouvrir à `QuoteScreen` un second `nearby.subscribe` pour la même position --
choix d'implémentation non spécifié, documenté dans `navigation/types.ts`. Conséquence acceptée :
la liste ne bouge plus une fois sur `QuoteScreen`, jusqu'à la sélection. Le serveur reste
l'arbitre final (`DRIVER_ALREADY_TAKEN` si un chauffeur affiché a été pris entre-temps, invariant
4) -- l'app n'affiche jamais une disponibilité qu'elle n'a pas vérifiée elle-même, elle affiche ce
que L3-05 lui a donné, et laisse le serveur trancher à la sélection.

`DriverCard.tsx` (nouveau) : toute la carte est la zone de sélection, pas un bouton à viser à
part -- terminal d'entrée de gamme, geste le plus direct possible. Mise en forme (distance par
paliers, « Nouveau » plutôt qu'une note à zéro, gamme) extraite de `DriverMarker.tsx` vers
`driverFormatting.ts` : les deux composants affichent le même `NearbyDriver` sous deux formes,
la règle d'affichage ne doit être écrite qu'une fois.

**Fichiers.** `apps/client/src/screens/QuoteScreen.tsx` (nouveau), `components/DriverCard.tsx`
(nouveau), `components/driverFormatting.ts` (nouveau, extrait de `DriverMarker.tsx`),
`navigation/types.ts` (`Quote` gagne `nearbyDrivers`), `navigation/index.tsx` (branché,
remplace le `PlaceholderScreen`), `screens/HomeScreen.tsx` (`handleNext` transmet la liste).

**Vérification.** `@babana/client` : 51 tests (8 nouveaux pour `QuoteScreen`, 2 pour
`DriverCard`, `DriverMarker` inchangé après extraction). `tsc --noEmit` et `eslint` propres.
Un piège de test noté pour la suite : `toLocaleString('fr-FR')` sépare les milliers par une
espace fine insécable (U+202F), invisible dans un éditeur -- comparer contre la même fonction,
jamais contre une chaîne de test tapée à la main avec une espace ordinaire (le premier jet de ces
tests échouait pour cette seule raison). Deuxième piège : un `setInterval` réel (le compte à
rebours) qui survit à la fin d'un test tant que le rendu n'est pas démonté explicitement --
`react-test-renderer` ne démonte rien tout seul entre les tests d'un même fichier, contrairement
à ce qu'on pourrait supposer. Consigné dans `code/docs/odoo-pitfalls.md` ? Non -- ce n'est pas un
piège Odoo, c'est un piège Jest/RN ; à documenter si un deuxième écran avec compte à rebours le
reproduit.

**Ce qui me laisse un doute pour un client réel (L6-07).** Le cliché de chauffeurs ne se corrige
jamais pendant que le client compare et hésite sur `QuoteScreen` -- si l'estimation prend son
temps à lire, un des cinq peut avoir disparu du pool sans que rien ne le signale avant le tap. Le
`DRIVER_ALREADY_TAKEN` renvoyé à la sélection est correct et sûr, mais l'expérience est mauvaise :
un message d'erreur générique plutôt qu'un rafraîchissement discret de la carte concernée. Ce
n'est pas un défaut de cette tâche au sens des critères d'acceptation, mais c'est le genre
d'aspérité qu'un utilisateur réel remarque à la deuxième course.

---

## L6-08 — attente, refus, nouvelle sélection (D11)

**Trouvé en lisant L3-07 comme dépendance, avant d'écrire quoi que ce soit d'autre : `ride.rejected`
ne portait ni `driverId` ni `reason`**, alors que L3-07 (critère 2) promet déjà « un motif distinct
de l'expiration » et que L6-08 a besoin de savoir quel chauffeur a refusé pour l'écarter. Corrigé
en premier, commit séparé (L3-07R), test d'abord vu rouge -- détail dans l'entrée L3-07R ci-dessus
et `amoa/questions/L3-07.md` §3.

**`WaitingScreen.tsx`** : compte à rebours affiché **indicatif** (le serveur reste seul juge de
l'expiration, spécification L3-07 -- cet écran ne décide jamais lui-même qu'une proposition a
expiré, il réagit à ce que `ride.assigned`/`ride.rejected` lui apprennent). « Annuler » appelle
`POST /rides/{id}/cancel`, instrumente l'abandon (critère 5 : rang de refus déjà essuyés + délai
depuis la sélection -- la donnée de L9-09) et revient à l'accueil.

**`DriverRejectedScreen.tsx`** : le fichier que la spécification liste séparément de
`WaitingScreen`, mais qui ne demande **aucune interaction** (« pas d'écran intermédiaire, pas de
confirmation à cliquer ») -- résolu en un écran qui affiche le message honnête puis se referme
tout seul après 1,8 s, juste le temps de le lire. Le message distingue refus explicite et
expiration (deux registres de phrases), et varie après plusieurs refus consécutifs plutôt que de
répéter la même phrase (critère 3) -- testé par l'absence d'identité entre les messages à streak
0, 1 et 5, pas par une correspondance exacte de texte (peu importe laquelle des trois phrases,
seulement qu'elles diffèrent).

**Le retour à la sélection réutilise la même course, jamais une seconde.** `POST /rides/{id}/
select-driver` accepte explicitement `rejected -> proposed` (C-01) : `QuoteScreen` porte
maintenant `selection.rideId` (absent au premier passage, présent dès la première sélection) et
saute `createRide` quand il est déjà là. Sans ce détail, chaque refus aurait créé une nouvelle
`babana.ride`, laissant les précédentes `rejected` orphelines en base -- pas une violation
d'invariant à la lettre, mais un défaut de hygiène de données qu'il valait mieux éviter à
l'écriture plutôt que découvrir plus tard.

**Le piège du bouton retour Android est câblé** (`navigation/transitions.ts::replaceWithRideFlow`,
posé par L6-00 et laissé pour L6-08 -- « appelé par L6-08 dès que POST /rides a répondu »,
littéralement son propre commentaire). `QuoteScreen` l'utilise au lieu de `navigate()` : la pile
Home/Quote est remplacée dès qu'une course existe côté serveur, jamais empilée sous Waiting.

**L3-08 n'existe pas, donc l'élargissement de rayon ne peut pas être réel ce soir.** Écart complet
dans `amoa/questions/L6-08.md` : ce qui a un vrai support serveur (refus nommé, exclusion,
variation du message) est implémenté et testé sans rien de fictif ; ce qui en dépendait
(élargissement par paliers, `NO_DRIVER_AVAILABLE` réel) est remplacé par un retour honnête à
l'accueil quand les cinq chauffeurs connus sont tous épuisés -- jamais une fausse promesse de
recherche en cours (spécification, critère 4 : « ne pas laisser croire qu'une recherche continue
en arrière-plan »).

**Fichiers.** `apps/client/src/screens/WaitingScreen.tsx` (nouveau),
`screens/DriverRejectedScreen.tsx` (nouveau), `screens/QuoteScreen.tsx` (réutilisation de
`rideId`, filtre `excludedDriverIds`, état `NO_DRIVER_AVAILABLE`, `replaceWithRideFlow`),
`navigation/types.ts` (`RideSelectionContext` partagé entre `Quote`/`Waiting`/`DriverRejected`),
`navigation/index.tsx` (branchés), `navigation/transitions.ts` + son test (params complets).
Côté L3-07R : `packages/contracts/src/realtime/server-to-client.ts`,
`services/realtime/src/proposal/lifecycle.ts`, leurs tests, `docs/contracts/realtime-events.md`.

**Vérification.** `@babana/client` : 64 tests (6 `WaitingScreen`, 4 `DriverRejectedScreen`, 6
`QuoteScreen` nouveaux pour la réutilisation de course/l'exclusion/`NO_DRIVER_AVAILABLE`, 1
`transitions` mis à jour). `tsc --noEmit` et `eslint` propres. `services/realtime` :
`test/proposal.test.ts` isolé, 7/7 -- en suite complète, un flake sous charge combinée y est
apparu pour la première fois cette nuit (`critère 1`, acceptation), même famille que
`DisconnectGraceTimers` (minuteurs, J14 rapport §4) : reconfirmé isolé avant d'écrire cette phrase,
non traité, la décision du 22 août reste (« allonger les délais masquerait le vrai comportement »)
-- un quatrième fichier touché par la même cause, à sérialiser plutôt que ralentir quand ça
gênera vraiment.

**Ce qui me laisse un doute pour un client réel (L6-08).** Le délai fixe de 1,8 s sur
`DriverRejectedScreen` est une estimation de « temps de lecture d'une phrase courte », pas une
mesure -- trop court pour quelqu'un qui lit lentement ou qui est distrait par la moto qui arrive,
trop long pour quelqu'un qui veut enchaîner vite. Rien dans la spécification ne dit s'il doit être
interruptible (toucher l'écran pour avancer plus tôt) ; je ne l'ai pas rendu interruptible, par
cohérence avec « pas de confirmation à cliquer » -- mais un client pressé le vivra comme une
attente imposée, aussi courte soit-elle. Et le doute le plus sérieux reste celui déjà écrit dans
`amoa/questions/L6-08.md` : sans L3-08, un client dont les cinq chauffeurs proches refusent tous
un par un se retrouve renvoyé à l'accueil après cinq allers-retours d'écran -- correct et honnête,
mais laborieux comparé à ce qu'un élargissement automatique de rayon offrirait.

---

## L6-00R -- le bundle web se construisait, mais ne s'exécutait pas

**Trouvé en faisant ce que le rapport J14 promettait de vérifier ce soir : ouvrir le parcours
dans un vrai navigateur.** `npm run build:web` réussit depuis L6-00 (21 août), et son critère
d'acceptation 6 ne demande rien de plus -- mais personne n'avait ouvert le résultat dans un
navigateur avant cette nuit. Trois défauts se sont révélés dans cet ordre, chacun masquant le
suivant :

1. **`public/index.html` ne charge jamais `bundle.js`.** Aucune balise `<script>`. La page est
   blanche, silencieusement -- aucune erreur, puisqu'aucun code applicatif ne s'exécute.
2. **`ReferenceError: exports is not defined`**, dans `@react-navigation/native`. Ces paquets
   livrent une syntaxe `export`/`import` sans jamais déclarer `"type": "module"` dans leur
   `package.json` ; webpack les traite donc comme de l'ESM strict, alors que babel-loader les
   transforme quand même en CommonJS (`@react-native/babel-preset` ne désactive cette
   transformation que pour Metro, pas pour un `caller` webpack) -- du code `exports.x = ...`
   exécuté dans un wrapper qui ne fournit jamais `exports`. `type: 'javascript/auto'` sur la
   règle babel-loader fait correspondre le type de module à ce que babel produit réellement.
3. **Les icônes de `@react-navigation/elements`** (flèche retour, loupe, croix) sont des imports
   `.png` -- sans règle d'asset, webpack refuse de les charger et le bundle ne se termine pas.
   Une règle `asset/resource` suffit.

**Un quatrième, non corrigé dans le code, contourné pour vérifier.** `react-native-keychain`
(stockage sécurisé de session, L6-02) n'a pas d'équivalent web, exactement comme
`react-native-maps` -- sans un alias du même genre, `AuthClient.restore()` lève au montage et
l'app ne dépasse jamais l'écran de chargement. Un stub `localStorage` (`webpack-stubs/
react-native-keychain.web.js`, même patron que le stub carte) débloque le bundle -- **mais il ne
chiffre rien** : légitime pour vérifier ce soir, pas pour L6-18, qui devra trouver une vraie
réponse à « une session web n'a pas de trousseau système à qui déléguer ».

**Vérifié, dans un vrai navigateur, contre la vraie pile (`make up`), avec un vrai chauffeur en
ligne (jeton réel via mock-google-identity, WebSocket réel, position réelle dans Redis) :**
- Restauration de session, écran d'accueil, carte (stub L6-18, hors de ce soir).
- **Le rappel « c'est le point sur la carte qui fait foi » (doute L6-06 §1) -- visible, exact.**
- **Le message de géolocalisation distinct par cause (doute L6-06 §2) -- « la localisation prend
  du temps » affiché quand le GPS de l'environnement de vérification n'a pas répondu vite.**
- **Le chauffeur réel apparaît en direct dans la liste (L3-05 -- D30 "Nouveau" correctement affiché
  pour un profil non seedé), après désignation par recherche texte (second moyen, L6-06).**
- Navigation vers `QuoteScreen` (bascule de route confirmée par le titre de l'onglet).

**Ce qui reste bloqué, et pourquoi ce n'est pas un défaut de cette nuit.** `POST /api/v1/quote`
échoue : le serveur Odoo (`localhost:8069`) n'envoie aucun en-tête CORS, et cette vérification
sert le bundle depuis un port différent (`localhost:5173`, un serveur statique de fortune -- rien
de tel n'existe encore dans ce dépôt). Le préflight `OPTIONS` échoue avant que la vraie requête
ne parte. **Ce n'est pas représentatif du déploiement réel** : une app native n'a pas de notion de
CORS, et l'export web réel (L6-18) est censé être servi par Caddy sous un domaine qui partage
l'origine de l'API (D18) -- exactement ce qui évite ce problème. Signalé pour L6-18, pas contourné
par un en-tête CORS ajouté à la hâte à un contrôleur Odoo à cette heure-ci.

**Fichiers.** `apps/client/public/index.html`, `apps/client/webpack.config.js`,
`apps/client/webpack-stubs/react-native-keychain.web.js` (nouveau). Aucun test automatisé --
`webpack.config.js` n'en a pas, et l'écran qu'il sert est déjà couvert par les suites Jest de
L6-06/L6-07/L6-08. La preuve, ici, est le navigateur lui-même.

**Pourquoi cette entrée touche un fichier de L6-00 alors que ce n'était pas au périmètre de ce
soir.** Trois raisons : (1) c'est un défaut, pas un choix -- un bundle qui compile mais
n'affiche jamais rien ne satisfait pas l'esprit du critère 6, seulement sa lettre ; (2) il
bloquait entièrement la vérification explicitement demandée pour cette nuit ; (3) le correctif
est petit, réversible, sans rapport avec la logique métier des quatre tâches du soir. Une session
future qui ouvrirait ce bundle dans un navigateur aurait buté sur exactement la même chose.

---

## Vérification finale, sur base fraîche -- une vraie régression trouvée et corrigée

`make reset && make up && make test`, comme la définition de fini l'exige. Première fois cette
nuit que la suite Odoo complète tournait avec `next_token_ciphertext` (D37) ET
`nearby.subscribe.ack` (doute L6-06 §3) en même temps -- chacune vérifiée isolément plus tôt,
jamais ensemble sur une base qui vient de zéro.

**13 échecs dans `test_ride_controller.py` (`TestRideController`), tous avec le même message :**
`chauffeur ... jamais apparu dans nearby.drivers après 8 tentatives`. Une régression réelle,
introduite par le correctif du doute L6-06 §3 -- trouvée seulement maintenant parce que je
n'avais fait tourner, après ce correctif, que la suite TypeScript de `services/realtime` et les
tests Jest du client. `services/odoo/addons/babana/tests/_realtime_ws.py`
(`make_driver_visible_to_client`) est un troisième consommateur du protocole WebSocket que je
n'avais pas identifié en implémentant l'accusé de réception : un client Python minimal, écrit
pour L3-17, qui lit **une seule trame** après `nearby.subscribe` et suppose que c'est
`nearby.drivers`. Avec l'accusé de réception, c'est désormais `nearby.subscribe.ack` qui arrive
en premier -- pris pour une absence de chauffeur, à chacune des 8 tentatives, systématiquement.

**Corrigé dans le seul fichier concerné** : la fonction lit maintenant les trames en boucle
jusqu'à `nearby.drivers` (ou l'épuisement de la fenêtre de la tentative), plutôt que de s'arrêter
à la première reçue -- même principe que `waitForDriverVisible` côté TypeScript
(`test/concurrency/helpers/realtime.ts`), qui filtrait déjà par type et n'avait donc jamais été
affecté. Vérifié qu'aucun autre appelant Python ou TypeScript ne lit une trame unique après
`nearby.subscribe` (recherche exhaustive sur `nearby.subscribe`/`nearby.drivers` dans
`services/odoo/addons/babana/tests/` et `test/`) -- un seul endroit avait cette hypothèse.

**Ce que je retiens.** Exactement la leçon que la nuit répète depuis plusieurs sessions (D26,
D33, D37 cette nuit même) : un changement qui a l'air localisé à un message WebSocket peut avoir
des consommateurs qu'aucune des suites déjà vertes ne couvre. La suite Odoo complète n'avait
tourné, ce soir, qu'une seule fois avant le doute L6-06 §3 (pour D37) -- jamais après. Le point 3
de la définition de fini (« `make test` passe en entier ») n'est pas négociable précisément pour
cette raison, et cette régression en est la preuve : une vérification tâche par tâche, aussi
soigneuse soit-elle, ne remplace pas une passe finale sur l'ensemble.

`services/odoo/addons/babana/tests/_realtime_ws.py` -- 1 fichier, pas de nouveau test (c'est déjà
la fixture d'un test existant qui l'a révélé). Suite `TestRideController` isolée : 0 échec, 24
tests, après correctif.

**Un second `make test` complet, après ce correctif, a buté sur le flake déjà documenté**
(`DisconnectGraceTimers`, minuteurs sous charge combinée, J14 rapport §4 -- réapparu cette nuit
dans `test/proposal.test.ts` également, voir l'entrée L6-08) -- sans lien avec cette nuit,
reconfirmé isolé une fois de plus (`services/realtime` seul : **119 tests, 0 échec**). Puisque
`npm run test --workspaces` s'arrête au premier échec, les paquets restants n'avaient alors pas
eu l'occasion de tourner : relancés séparément (`npm run test --workspaces`, sans le paquet déjà
reconfirmé), **tout est vert** -- `@babana/client` (64 tests), `@babana/driver`, `packages/*`,
`test/concurrency` (les quatre scénarios longs, dont le test de concurrence L4-11 et le rejeu de
sérialisation PostgreSQL L3-17). La suite Odoo complète (2200 tests, dont les 478 de `babana`)
est verte depuis le correctif ci-dessus. **Le seul rouge de la nuit, au global, était le flake
déjà connu -- rien d'autre.**
