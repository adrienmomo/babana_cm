# Rapport de nuit — J13

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-21.md` lu en entier avant d'ouvrir quoi que ce
soit — §5 arbitre le trou trouvé la nuit dernière : la navigation devient une tâche, L6-00, première
de la nuit. Trois fondations partagées ce soir : navigation, client API, client WebSocket. Toujours
pas d'écran métier — la dernière nuit dans ce cas, selon les réponses.

---

## L6-00 — Navigation et arborescence des écrans

**Le nouveau paquet, `packages/navigation`, ne porte que ce qui doit vraiment être partagé.** La
spécification le dit explicitement : « ce qui se partage, ce sont les types de routes et la garde
d'authentification, pas l'arborescence elle-même. » Trois exports minces :

- `SessionState<TUser>` (`loading` / `unauthenticated` / `authenticated`) — générique, sans
  dépendance à `@babana/api-client` : ce paquet ne connaît que la forme de l'état, chaque app câble
  son propre `AuthClient` vers cette forme.
- `AuthGate<TUser>` — la garde elle-même, un simple aiguillage à trois branches (`renderLoading` /
  `renderSignedOut` / `renderSignedIn`). La garantie ne vient pas d'une vérification : elle vient de
  ce que le sous-arbre authentifié n'est **monté** que quand `session.status === 'authenticated'`.
  Un écran métier ne peut pas être atteint par une navigation directe (critère 3) parce qu'il n'existe
  tout simplement pas dans l'arbre React tant que la session n'est pas là — plus fort que n'importe
  quelle vérification répétée dans chaque écran.
- `PlaceholderScreen` — écran-pont, même discipline que les champs-pont de `CLAUDE.md` appliquée à
  un écran : les quinze écrans de L6-05 à L6-17 n'existent pas encore, mais l'arborescence qui les
  accueillera doit exister ce soir (critère 1). Chaque route non écrite pointe ici avec le nom de la
  tâche qui la remplacera — la tâche cible retire l'usage qui la nomme, même geste qu'un champ-pont.

**Bibliothèque retenue : `@react-navigation/native` + `@react-navigation/native-stack`, avec
`react-native-screens`.** Vérifié compatible avec React 19.2.3 / React Native 0.86.2 avant l'ajout
(peer dependencies). `native-stack` plutôt que `@react-navigation/stack` : ce dernier exige en plus
`react-native-gesture-handler` en v7, une dépendance supplémentaire pour un rendu JS plus lourd sur
un terminal d'entrée de gamme — `native-stack` s'appuie sur les contrôleurs de navigation natifs de
la plateforme, sans gestion de geste maison à charger.

### La garde, concrètement

Chaque app (`src/navigation/index.tsx`) construit sa propre session à partir de `AuthClient`
(L6-02) : `restore()` au démarrage, abonnement à `onSessionLost` (nouveau, voir plus bas) pour
revenir à la connexion depuis n'importe quel écran (critère 4), et `handleSignedIn` câblé sur
`SignInScreen.onSignedIn` pour que la connexion fasse apparaître les écrans métier sans navigation
explicite — c'est le changement de `session.status` qui remplace tout le sous-arbre, pas un appel à
`navigate('Home')`.

**`onSessionLost` n'existait pas comme mécanisme observable depuis l'extérieur d'`AuthClient`.**
`AuthClientConfig.onSessionLost` (L6-02) est un callback fourni une fois à la construction ; sans
navigation, personne n'avait encore besoin de s'y abonner depuis un composant React qui n'existe
qu'après montage. Plutôt que de modifier `AuthClient`/`session.ts` (déjà revu, déjà testé) pour lui
ajouter un mécanisme de sur-abonnement, `apps/*/src/auth.ts` porte désormais un petit registre
d'écouteurs (`onSessionLost(listener)`, `Set<() => void>`) et configure `AuthClient` avec
`onSessionLost: () => écouteurs.forEach(l => l())`. Le fichier déjà responsable de construire le
singleton de session reste le seul à toucher `AuthClient` ; `@babana/api-client` n'a pas changé.

### Le rafraîchissement proactif au démarrage — ce que le code a révélé en écrivant cette tâche

**`AuthClient.restore()` (L6-02) ne restaure jamais `driverStatus`.** Le commentaire de `session.ts`
le dit lui-même : « L'utilisateur n'est pas persisté dans le trousseau [...] le premier appel
authentifié le rafraîchira de toute façon depuis le serveur si besoin. » En vérifiant ce que ce
« premier appel authentifié » recouvre réellement (CLAUDE.md, « une dépendance supposée absente se
vérifie dans le dépôt ») : **aucun endpoint du catalogue C-01 ne renvoie le profil utilisateur**, hors
de `/auth/google` et `/auth/refresh`. Un chauffeur qui rouvre l'app avec un jeton d'accès encore
valide aurait donc un `driverStatus` vide jusqu'à sa prochaine expiration de jeton — la garde de
L6-00 (critère 5, chauffeur `pending` routé vers l'attente de dossier) aurait fonctionné juste après
la connexion, puis se serait tue au redémarrage suivant.

Pas un défaut d'architecture à corriger en dehors de cette tâche : `POST /auth/refresh` renvoie déjà
l'utilisateur complet (même schéma que `/auth/google`), et l'appeler une fois au démarrage — sans
attendre un `TOKEN_EXPIRED` réactif — donne un profil à jour sans endpoint supplémentaire. Les deux
`src/navigation/index.tsx` font donc : `restore()` puis `refresh()` proactif ; en cas d'échec
authentifiant (`ApiError`, jeton de renouvellement révoqué), `handleRefreshFailure()` a déjà nettoyé
la session et déclenché `onSessionLost` ; en cas d'échec réseau (hors ligne — l'exception n'est pas
une `ApiError`, `fetch` a levé avant le serveur), l'app continue avec la session restaurée plutôt que
de bloquer le démarrage. Le réseau intermittent est le cas courant (CLAUDE.md), et un `driverStatus`
périmé n'ouvre aucune faille : le serveur reste l'arbitre (invariant 3), `DRIVER_NOT_APPROVED` existe
précisément pour rattraper le cas où le client se serait trompé.

**Défaut-refus déclaré explicitement côté Chauffeur** : `DriverAppSwitch` ne nomme que `'approved'`
pour accéder aux écrans de course ; `pending`, `rejected`, `suspended`, et l'absence de statut (échec
hors ligne du rafraîchissement) sont tous routés vers l'attente de dossier. Testé avec les quatre
valeurs (`it.each`).

### Le piège du bouton retour

Un seul navigateur par app (pas de sous-navigateurs emboîtés) : la distinction entre « empiler » et
« remplacer » est portée par `navigation.reset()`, pas par la forme de l'arbre.

- **Client** (`src/navigation/transitions.ts`, `replaceWithRideFlow`) : au moment où une course est
  créée côté serveur, la pile Home/Quote est remplacée par `[Waiting]` seul — un retour depuis le
  suivi ne peut pas ramener à l'estimation d'une course déjà commandée (l'exemple donné par la
  spécification). Réservé à cette seule frontière ; à l'intérieur de la phase course
  (Waiting → Tracking → RideSummary), la même technique reste disponible pour L6-08/L6-09, qui
  connaissent le déroulé réel de ces écrans — pas décidé ici par anticipation.
- **Chauffeur** (`replaceWithActiveRide`, `replaceWithHome`) : `Proposal` se présente en plein écran
  par-dessus `Home` (`Home` reste dessous — un retour depuis `Proposal` dismiss simplement, c'est le
  comportement voulu). L'acceptation remplace la pile par `[ActiveRide]` seul (un retour ne peut pas
  rouvrir une proposition déjà résolue) ; la fin de course remplace par `[Home]` seul (un retour ne
  peut pas rouvrir une course déjà encaissée).

Testé par assertion sur la forme exacte de l'appel à `reset()` (`routes` de longueur 1), pas
seulement sur le fait qu'il soit appelé.

### La compatibilité web, vérifiée avant, pas après

Critère non négociable de la tâche. `apps/client/webpack.config.js` + `index.web.tsx` bundlent
`App.tsx` (donc `AppNavigator`, donc `@react-navigation/*` et `react-native-screens`) avec
`react-native-web` — succès (`npm run build:web`, `2.33 MiB`, aucune erreur). `apps/driver` n'a reçu
aucun de ces fichiers : pas d'export web, conforme à D22.

**Ce que le premier essai a révélé, et qui aurait coûté cher à L6-18 sans être vu maintenant :**
`react-native-maps` publie `"main": "src/index.ts"` — du TypeScript brut, jamais transpilé, en
suivant l'usage de sa propre chaîne de build (attendu d'être compilé par le bundler de l'app qui
l'installe). `@babana/maps` réexporte `MapView` (donc le fournisseur Google, donc le SDK) depuis son
point d'entrée unique : importer ne serait-ce que `configureMapsProvider` (pour `bootstrap.ts`)
charge donc transitivement le SDK natif, qui n'a pas d'équivalent web. C'est exactement le trou que
L6-18 doit combler (« troisième implémentation », `providers/web/`) — pas cette tâche. Contourné à la
frontière du bundle web seulement (`resolve.alias` de webpack, `react-native-maps$` → un double sans
SDK, même forme que `__mocks__/react-native-maps.tsx` déjà utilisé par les tests), commenté comme
provisoire et condamné par L6-18 : `packages/maps/src/activeProvider.ts` n'a pas été touché, la
frontière posée par L6-01 reste entière. La même divergence a été rencontrée côté Jest (voir
ci-dessous) et résolue de la même façon, pour la même raison.

**Deux règles de webpack 5, découvertes en creusant les erreurs plutôt que devinées :**
`@react-navigation/*`, `react-native-screens` et le second chemin (web) de
`@react-native-google-signin/google-signin` publient un build ESM (`lib/module/`) où les imports
relatifs entre fichiers voisins n'ont pas d'extension — webpack 5 refuse cette forme par défaut pour
de l'ESM strict (`fullySpecified`). Une règle de module (`{ test: /\.m?js$/, resolve: {
fullySpecified: false } }`) suffit ; sans elle, le message d'erreur ("Did you mean
'GoogleSignin.web.js'?") montre au passage que ce SDK **fournit déjà** un chemin web — juste
inatteignable tant que cette règle manque, une bonne nouvelle trouvée en cherchant autre chose,
utile à L6-18.

**`webpack-cli`, installé mais pas hoisté à la racine** (npm en a décidé ainsi, sans conflit de
version identifiable — un seul point de déclaration dans tout l'arbre) : le binaire `webpack`
hoisté à la racine ne le retrouve pas depuis son propre emplacement. `npm run build:web` invoque
directement `node node_modules/webpack-cli/bin/cli.js` plutôt que `webpack` seul — contournement
documenté ici et dans `webpack.config.js`, pas une correction de fond (`npm dedupe` n'a rien changé).

### Divergence Jest sur `react-native-maps`, et sa résolution

En écrivant les tests de `AppNavigator` (qui montent `App.tsx` en entier, donc `bootstrap.ts`, donc
`@babana/maps`), `require.resolve('@babana/maps')` renvoyait bien `dist/index.js`, mais le rendu
échouait sur `react-native-maps/src/index.ts` (ESM brut, voir plus haut) — le même défaut structurel
que côté webpack, révélé cette fois par les traces d'erreur source-mappées de Jest vers les fichiers
`.tsx` d'origine (`packages/maps/src/...`), ce qui a longtemps fait croire à une résolution vers la
source plutôt que vers `dist/`. `apps/client/__mocks__/react-native-maps.tsx` et
`apps/driver/__mocks__/react-native-maps.tsx` (même contenu que `packages/maps/__mocks__/`, adjacent
à `node_modules` donc appliqué automatiquement, sans `jest.mock()` explicite) referment le problème :
ces apps ne rendent aucune carte réelle dans leurs tests ce soir, elles n'ont besoin de rien de plus.

### Tests

`packages/navigation/test/AuthGate.test.tsx` (4 cas : chaque branche de session monte exactement ce
qu'elle doit, et la perte de session démonte le sous-arbre authentifié). Par app : `AppNavigator.
test.tsx` (session absente → connexion seule, critère 3 vérifié aussi par une tentative de
`navigate('Home')` qui échoue silencieusement — journalisée par React Navigation, jamais un crash ;
session valide → écrans métier directement ; connexion → apparition des écrans ; perte de session en
cours d'usage → retour à la connexion, critère 4), `transitions.test.ts` (forme exacte de `reset()`),
`types.test.ts` (un identifiant de course mal typé casse `tsc --noEmit`, critère 2 — deux
`@ts-expect-error` vérifiés significatifs en les retirant temporairement et en observant l'échec).
Côté Chauffeur, `AppNavigator.test.tsx` ajoute les quatre statuts de `driverStatus` (critère 5).

`npm run typecheck --workspaces`, `npm run lint --workspaces` : propres sur les onze paquets/apps.
Chaque paquet touché testé isolément (`packages/navigation`, `apps/client`, `apps/driver`) : 4 + 11 +
15 tests, 0 échec. `npm run build:web` (`apps/client`) : succès. **Suite complète du dépôt
(`npm test` racine) non relancée cette nuit** : elle enchaîne les suites de concurrence et
d'authentification contre une pile Odoo/Redis réelle (`test/concurrency`, `test/auth`), qui suppose
`make up` — non démarré ce soir, ces trois tâches ne touchant pas Odoo (voir la dernière section).

---

## Trois nouvelles dépendances, signalées

`@react-navigation/native` (^7.3.16), `@react-navigation/native-stack` (^7.18.8),
`react-native-screens` (^4.27.0) — dans `packages/navigation`, jamais directement dans les apps
(même discipline que `react-native-maps`/`react-native-keychain`, L6-01/L6-02).

**Plus, réservé à l'export web de `apps/client` seulement** (jamais dans `apps/driver`, D22) :
`react-native-web`, `react-dom` en dépendances, `webpack`/`webpack-cli`/`babel-loader` en
dépendances de développement — cinq paquets, tous scopés à un seul bundle de vérification, aucun ne
tourne sur un appareil. **Cumul de la semaine : trois hier (L6-01/L6-02), huit ce soir.** Aucun signe
que la batterie ou la mémoire de l'app native en souffrent — `native-stack` s'appuie sur les
contrôleurs natifs de la plateforme plutôt que sur une pile de gestes en JS, et le tronçon web
n'entre dans aucun bundle natif. À surveiller si le rythme se maintient : la discipline de `CLAUDE.md`
demande de le dire, pas de le limiter arbitrairement.

---

## L6-03 — Client API partagé

**`packages/api-client/src/http.ts` (un seul fichier, L0-03) devient `src/http/`** : `client.ts`
(le client lui-même), `errors.ts` (`ApiError`, catalogue de messages français, traduction),
`idempotency.ts` (génération de la clé), `rpc.ts` (JSON-RPC). `src/index.ts` n'a pas changé —
`export * from './http'` résout maintenant vers `http/index.ts`, aucun consommateur (`auth/
session.ts`, les deux apps) n'a eu à changer son import.

**Réessais avec temporisation croissante, jamais sur une erreur métier (critères 1 et 2).**
`isRetryableStatus` ne retient que le réseau (fetch qui lève avant toute réponse) et le serveur
(HTTP ≥ 500, `ROUTE_UNAVAILABLE` y compris) — jamais une erreur métier bien formée
(`DRIVER_ALREADY_TAKEN`, `NO_DRIVER_AVAILABLE`...), qui ne réussira jamais en la rejouant et
masquerait le vrai message à l'appelant (spécification, presque mot pour mot). `RATE_LIMITED`
(429) n'est délibérément pas retenu non plus : un réessai aveugle aggraverait la limitation plutôt
que de la respecter — absent des critères, tranché en écrivant le code, à mentionner ici plutôt que
deviné silencieusement. Délai doublé à chaque tentative (300 ms, 600 ms, 1200 ms par défaut, 3
réessais), `wait` injectable pour les tests — aucun test de ce paquet n'attend une vraie
temporisation.

**Une écriture porte toujours le même identifiant d'idempotence sur ses réessais internes, un
nouveau à chaque appel externe (critère 3).** Générée une fois par appel à `client.request(...)`,
avant la boucle de réessai — réutilisée pour les tentatives réseau/serveur de *cette même* boucle
(le doute porte sur ce que le serveur a reçu), mais un appel externe distinct
(`withTransparentRefresh`, L6-02, qui rejoue après un `TOKEN_EXPIRED`) en génère une nouvelle :
`TOKEN_EXPIRED` échoue à l'authentification, avant tout appel de méthode de transition — aucune
transition n'a donc pu être appliquée par la tentative précédente, réutiliser sa clé n'aurait rien
protégé. Seul un POST en porte une (`isWriteMethod`) — un GET est par nature rejouable, lui en
donner une n'aurait aucun effet, seulement du bruit dans `babana.idempotency.record`.

**Un défaut latent de L0-03, révélé en écrivant le premier test qui exerçait vraiment un GET avec
paramètres.** `nearbyDrivers` est le seul endpoint `GET` du catalogue avec un `requestSchema` non
nul (les coordonnées de recherche) ; l'implémentation d'origine validait `options.body` pour
*tout* endpoint pourvu d'un `requestSchema`, sans distinguer la méthode — un GET n'a jamais de
corps, ses paramètres vivent dans la requête (`options.query`, déjà posée sur l'URL par
`buildUrl`). Personne ne l'avait remarqué parce qu'aucun appelant n'existait encore pour
`nearbyDrivers` (le premier, `apps/client/src/screens/HomeScreen.tsx`, est L6-06 -- pas encore
écrit). Le test qui l'a révélé (`client.test.ts`, "une lecture ne porte pas d'identifiant
d'idempotence") est resté, corrigé pour refléter le bon comportement plutôt que supprimé
(CLAUDE.md, "ne jamais adapter un test au code" -- ici c'est le code qui s'est aligné sur ce que le
test attendait à juste titre). Corrigé : un GET valide ses paramètres de requête contre
`requestSchema` sans jamais les sérialiser dans un corps.

**Chaque code du catalogue C-01 a sa phrase en français, écrite une seule fois (critère 4, D20).**
`USER_MESSAGES` (`errors.ts`), `satisfies Record<http.ErrorCode, string>` — si le catalogue gagne
un code, ce fichier ne compile plus tant qu'il n'a pas sa phrase, même discipline que les suites
générées depuis des données (CLAUDE.md). Distinct d'`ERROR_DESCRIPTION` (`@babana/contracts`, déjà
existant) : celui-là documente le contrat pour un développeur (« Le compte chauffeur n'est pas
encore validé par le back-office »), celui-ci s'adresse à l'utilisateur final, sans jargon ni
code — testé explicitement (aucune phrase ne contient « back-office », « idempotence », « HTTP »,
« API » ou « JSON »). Un code inconnu du client (**critère 5**, un serveur plus récent que
l'app) produit le message générique et une remontée technique (`reportMetric`), jamais le code
brut affiché.

**JSON-RPC pour les lectures secondaires (spécification, hors des cinq critères d'acceptation) —
posé, pas prouvé de bout en bout.** `01-architecture.md` §5 réserve JSON-RPC natif aux lectures
secondaires (historique, factures, profil), les chemins critiques restant sur des contrôleurs
explicites. `createJsonRpcClient` (`rpc.ts`) enveloppe l'appel dans la forme JSON-RPC 2.0 standard
avec le jeton applicatif en en-tête `Authorization: Bearer` — testé contre un point de terminaison
simulé. **Ce qu'il ne peut pas encore prouver, et qui n'est pas un défaut de cette tâche :**
le JSON-RPC natif d'Odoo authentifie par session de cookie ou par `(db, uid, password)` explicites
dans les arguments (`/jsonrpc`, `service: 'object'` — la forme qu'utilise déjà
`test/concurrency/helpers/odoo-session.ts` pour préparer des fixtures, avec des identifiants de
service, pas ceux d'un utilisateur mobile) ; ni l'un ni l'autre ne comprend le jeton Bearer que ce
client construit. **Aucun contrôleur Odoo n'expose aujourd'hui de pont JSON-RPC authentifié par ce
jeton.** Pas un écart à arbitrer maintenant — rien ne consomme encore ce client (L6-10, historique
et factures, n'est pas ouvert) — mais à vérifier avant que L6-10 ne suppose ce pont acquis : à
signaler ce soir-là s'il manque toujours.

**`endpoints/` du plan de fichiers, non créé — choix d'implémentation non spécifié, décidé.** Le
détail des requêtes/réponses vit déjà dans `@babana/contracts` (D17, jamais redéclaré) ; un dossier
`endpoints/` n'aurait pu contenir que des fonctions d'enrobage par ressource
(`createRide(client, params)` plutôt que `client.request('createRide', {...})`) dont aucun écran ne
profite encore ce soir (le lot L6 n'ouvre aucun écran métier) — les écrire par anticipation aurait
été de l'abstraction sans consommateur (CLAUDE.md, « pas d'abstraction prématurée »). Le premier
écran qui en aurait vraiment besoin (probablement L6-07, l'estimation, avec son enchaînement
`/quote` → `/rides` → `/rides/{id}/select-driver`) le posera à ce moment, avec un vrai appelant pour
juger la forme utile.

**Tests** (`packages/api-client/test/http/`, nouveaux) : `client.test.ts` (7 cas — réessai
serveur avec délais croissants vérifiés valeur par valeur, réessai réseau, arrêt à `maxRetries`,
aucun réessai sur erreur métier, identifiant d'idempotence présent sur une écriture/absent sur une
lecture, même identifiant réutilisé sur un réessai interne) ; `errors.test.ts` (le catalogue est
complet et sans jargon, traduction d'un code connu, message générique sur un code inconnu) ;
`rpc.test.ts` (forme de l'enveloppe, en-tête Bearer, erreur JSON-RPC distincte d'un résultat vide).

`npm run typecheck`, `npm run lint --workspaces`, `npm test` (`-w @babana/api-client`) : propres,
27 tests (14 déjà existants + 13 nouveaux), 0 échec. `npm run build` (`@babana/api-client`)
relancé pour que `dist/` (consommé par les deux apps et par le bundle web de `apps/client`) reflète
le nouveau `http/` — vérifié en relançant `npm run typecheck --workspaces` (onze paquets/apps,
propre), les suites des deux apps (26 tests, 0 échec) et `npm run build:web` (`apps/client`,
succès) après coup plutôt que supposé sans risque.

---

## L6-04 — Client WebSocket partagé

**`packages/api-client/src/realtime.ts` (un seul fichier, L0-03) devient `src/realtime/`** :
`connection.ts` (le client lui-même), `queue.ts` (file d'actions persistante), `reconnect.ts`
(politique de délai et gigue), `handlers.ts` (validation défensive, état de connexion). Même
mouvement que L6-03 pour `http/`, même raison : l'export minimal de L0-03 devient ce que la
spécification demande réellement.

**Gigue aléatoire, pas seulement une temporisation croissante (critère 1, L3-11).** La
spécification le dit texto : sans elle, mille chauffeurs se reconnectent en même temps après une
coupure d'antenne et achèvent le service. `computeReconnectDelayMs` plafonne l'exponentielle
*avant* d'appliquer la gigue (±30 % par défaut) — plafonner après aurait laissé le pire cas
dépasser le plafond voulu. Testé sur les bornes (délai croissant à gigue nulle, plafond respecté,
gigue non nulle et jamais négative), pas seulement sur l'appel de la fonction.

**Le jeton WebSocket ferme la connexion avec un code distinct selon qu'il est invalide ou expiré
(critère 1, L3-01) — vérifié dans le dépôt, pas supposé.** `WS_CLOSE_UNAUTHENTICATED` (4401) et
`WS_CLOSE_TOKEN_EXPIRED` (4402) existaient déjà, mais **codés en dur dans
`services/realtime/src/ws/auth.ts`**, sans consommateur côté client pour les avoir jamais rendus
partageables. Les recopier ici aurait reproduit exactement l'incident du 15 août que
`01-architecture.md` §5 raconte : deux services d'accord sur rien, aucune suite ne l'aurait vu
parce que chacun fabrique sa propre valeur pour se tester. **Déplacés dans `@babana/contracts`**
(`packages/contracts/src/realtime/close-codes.ts`, D17), `auth.ts` les ré-exportant pour que
`connection.ts` (service) et ses tests n'aient rien à changer. `services/realtime` en dépendait déjà
(`realtime.ServerToClientMessageSchema`, `auth.AccessTokenClaimsSchema`) — aucune nouvelle
dépendance, seulement une valeur qui a enfin son unique définition. Suite du service relancée après
coup (112 tests, 1 échec) : le même flake déjà documenté au rapport de J12
(`DisconnectGraceTimers`, sensible au temps réel écoulé sous charge combinée) — reconfirmé isolé
(3 tests, 0 échec) et sans rapport avec ce déplacement.

Côté client : `TOKEN_EXPIRED` prévient l'appelant (`onTokenExpired`, pour qu'il renouvelle via
`AuthClient.refresh()`, L6-02) puis une reconnexion automatique suit — elle relira un jeton frais
via `getAccessToken()`, sans que `connection.ts` ait besoin de savoir comment ce jeton se
renouvelle. `UNAUTHENTICATED` prévient l'appelant (`onUnauthenticated`, retour à la connexion, même
mécanisme qu'`onSessionLost`) et **n'entraîne aucune reconnexion automatique** : rejouer le même
jeton invalide ne peut pas réussir.

**File d'actions persistante, un mutex minimal découvert nécessaire en écrivant le test qui
compte (critères 2 et 3).** `AsyncStorage` (`@react-native-async-storage/async-storage`, nouvelle
dépendance -- voir plus bas), pas le trousseau sécurisé de L6-02 : ces actions ne sont pas des
secrets, et le trousseau est pensé pour une valeur unique, pas une liste qui grandit et rétrécit.
**Un vrai défaut trouvé par le premier test qui enchaînait deux `send()` sans `await` entre les
deux** (exactement le cas réel : un chauffeur qui tape accepter puis démarrer avant que le premier
ait fini de s'écrire) : `enqueue()` fait un `load()` puis un `save()` non atomiques, et le second
appel lisait l'état d'avant le premier `save()` -- la seconde action écrasait la première plutôt
que de s'y ajouter. Corrigé par un mutex minimal (une chaîne de promesses, `ActionQueue.tail`) qui
sérialise `enqueue`/`remove`/`list` -- pas une dépendance nouvelle pour ça, CLAUDE.md aurait raison
de le demander sinon.

**Les positions ne sont jamais mises en file, seule la dernière compte (critère 4).**
`connection.ts` les traite entièrement à part : `send('position.update', ...)` écrase
`latestPosition` en mémoire hors connexion, l'envoie dès l'ouverture suivante, ne les fait jamais
transiter par la file persistante -- ce module n'a même pas besoin de savoir qu'une position
"expire" pour respecter le critère, il ne les file simplement jamais.

**`session.resync` avant le rejeu de la file, pas après (spécification C-02, "avant de rejouer la
file d'actions locale" -- déjà écrit dans `client-to-server.ts`).** À l'ouverture : `session.resync`
d'abord (avec `lastKnownRideId`), la dernière position ensuite si elle existe, puis la file rejouée
dans l'ordre, une action retirée de la file après chaque envoi réussi -- une reconnexion coupée en
plein rejeu ne perd que ce qui a déjà été envoyé, pas le reste (`remove()` par action, jamais un
`clear()` global).

**Ce que ce lot ne peut pas encore prouver de bout en bout, honnêtement signalé plutôt que tu.**
`services/realtime/src/ws/resync.ts` (L3-11, moitié serveur de cette même tâche) n'existe pas
encore -- `session.resync`/`session.synced` sont des types de message valides (C-02, déjà posés),
mais aucun code ne les traite aujourd'hui. Les tests de ce soir vérifient le client seul, contre un
`WebSocketLike` simulé (`FakeSocket`) -- la preuve d'un aller-retour réel contre un service qui
répond attend L3-11 côté serveur. Même situation que le pont JSON-RPC de L6-03 cette nuit : posé,
pas raccordé, à signaler de nouveau si L3-11 ou le premier écran qui consomme ce client (L6-06, les
chauffeurs à jour en direct) l'ouvre sans que ce pont existe.

**Une nouvelle dépendance, signalée : `@react-native-async-storage/async-storage` (^3.1.1).**
Peer dependencies permissives (`react: '*'`, `react-native: '*'`), aucun conflit. **Neuvième
dépendance nouvelle cette nuit** (trois hier, huit ce soir avant celle-ci) -- la discipline de
CLAUDE.md demande de le dire, pas de s'arrêter : c'est la seule brique qui manquait pour un
stockage clé-valeur non secret sur les deux plateformes, rien d'équivalent n'existait déjà dans le
dépôt (le trousseau de L6-02 est sémantiquement le mauvais outil pour une liste, pas seulement une
question de nommage).

**Tests** (`packages/api-client/test/realtime/`, nouveaux, 20 cas) : `reconnect.test.ts` (4 --
croissance, plafond, gigue non déterministe, bornes) ; `queue.test.ts` (3 -- ordre conservé,
retrait précis, persistance à travers une nouvelle instance) ; `handlers.test.ts` (3 -- message
conforme accepté, JSON malformé ignoré sans exception, forme inconnue du contrat ignorée) ;
`connection.test.ts` (10 -- resync avant rejeu, jeton en paramètre de requête, état de connexion
exposé, message entrant transmis, file rejouée dans l'ordre avec l'identifiant d'origine, positions
jamais mises en file, reconnexion sur coupure ordinaire, jeton expiré vs invalide traités
différemment, `disconnect()` sans reconnexion).

`npm run typecheck`, `npm run lint --workspaces`, `npm test` (`-w @babana/api-client`) : propres,
47 tests (27 déjà existants + 20 nouveaux), 0 échec. `npm run build` relancé (`dist/` à jour) ;
`npm run typecheck --workspaces` (onze paquets/apps), les suites des deux apps (26 tests) et
`npm run build:web` relancés après coup, propres.

---

## Ce que L6-06 devra encore écrire

Question posée en tête de nuit : une fois navigation, client API et carte posés, que reste-t-il à
faire pour l'écran d'accueil Client ?

**Ce qu'il n'aura pas à écrire, parce que c'est déjà fait :**
- Se soucier de la session — il vit sous `AuthGate`, jamais atteint sans elle.
- Construire un client HTTP ou WebSocket, ses réessais, ses messages d'erreur ou sa reconnexion —
  `../auth.ts` (`apiClient`) et `@babana/api-client` (`createRealtimeClient`) portent tout cela
  depuis ce soir (L6-03, L6-04).
- Choisir une bibliothèque de carte, gérer le SDK — `@babana/maps` expose `MapView`,
  `searchPlace`, `reverseGeocode` en trois imports.
- Décider où le bouton de connexion mène — déjà câblé, l'écran d'accueil n'existe que parce que la
  session existe.

**Ce qu'il devra écrire, et qui n'existe nulle part encore :**
1. **La position du client** — aucune capture de géolocalisation ponctuelle n'existe dans le dépôt
   (L6-05 capture la position du *chauffeur* en continu, un besoin différent : ici, une position
   unique au chargement de l'écran, pour centrer la carte et pré-remplir le départ). Permission
   `ACCESS_FINE_LOCATION`, refus géré sans bloquer l'écran.
2. **`GET /drivers/nearby` et `nearby.subscribe`, jamais appelés** — les deux contrats existent
   (C-01, C-02), aucun code client ne les invoque encore. `createRealtimeClient` porte déjà l'état
   de connexion et la validation des messages entrants ; ce sera sa première consommation réelle,
   mais le pont serveur (`session.resync`/`session.synced`, L3-11) n'existe pas encore côté
   `services/realtime` — L6-06 en aura besoin pour la resynchronisation, pas seulement pour le
   flux initial de chauffeurs proches.
3. **`PlacePicker` et le réticule** — le premier des deux moyens de désignation (déplacement de la
   carte sous un réticule fixe, prioritaire sur la recherche textuelle) n'a aucun précédent dans le
   dépôt : ni geste de carte suivi en continu, ni géocodage inverse déclenché au relâchement plutôt
   qu'à chaque frame (un géocodage par frame de déplacement de carte enverrait des centaines
   d'appels REST pour un seul geste).
4. **`DriverMarker`** — aucun composant de présentation n'existe encore dans les apps (seulement
   `Button`, `@babana/ui`). Prénom, note, gamme, mention « nouveau » (D30, champs nullables déjà
   posés côté contrat) : une carte visuelle, pas une donnée à transformer.
5. **L'état d'écran lui-même** — sélection en cours (départ/arrivée), résultats de recherche
   affichés, chauffeurs reçus par le canal temps réel : le premier écran du dépôt avec plus d'un ou
   deux champs de `useState`, sans précédent de state local plus riche à suivre.

Rien de tout cela n'est bloqué par ce que ce soir ferme (L6-03, L6-04) : la première vraie carte
tarifera la profondeur de ce state local et le pont serveur manquant de L3-11, pas l'intégration
réseau elle-même.

---

## Vérification finale

**Pas sur base fraîche : `make up` n'a pas été démarré cette nuit.** Les trois tâches du lot
(L6-00, L6-03, L6-04) ne touchent ni Odoo ni le service temps réel en tant que processus vivant —
`services/realtime/src/ws/auth.ts` a changé (déplacement des codes de fermeture), mais sa propre
suite (`tsx --test`) ne suppose pas d'infrastructure démarrée. Dit plutôt que passé sous silence
(CLAUDE.md) : `make reset` n'était pas dû, mais la suite Odoo (464 tests propres au module) et la
vérification d'infrastructure (`make verify`) n'ont donc pas été relancées cette nuit — rien dans
les trois tâches ne les touchait, mais ce n'est pas la même chose que de les avoir vues vertes ce
soir.

Chaque paquet touché testé isolément, plus l'ensemble du monorepo JS/TS :

- `@babana/navigation` : 4 tests, 0 échec.
- `@babana/api-client` : 47 tests, 0 échec (14 déjà existants + 13 de L6-03 + 20 de L6-04).
- `@babana/contracts` : 63 tests, 0 échec (inchangé, sauf l'ajout de `close-codes.ts` -- aucun
  test dédié : deux constantes numériques, déjà exercées indirectement par les tests de
  `services/realtime` qui vérifient les codes de fermeture réels).
- `@babana/realtime` (service, pas le paquet client) : 112 tests, 1 échec -- `DisconnectGraceTimers`,
  le même flake temporel déjà documenté au rapport de J12, reconfirmé isolé et sans rapport avec
  le déplacement des codes de fermeture (3 tests, 0 échec en isolation).
- `@babana/client`, `@babana/driver` : 11 et 15 tests, 0 échec.
- `@babana/concurrency-tests` : non relancé (suppose Odoo et Redis vivants -- `npm test` racine
  interrompu après un délai d'attente, aucune des trois tâches ne touchant à la concurrence ou à
  la réservation atomique).
- `npm run typecheck --workspaces` : propre sur les onze paquets/apps.
- `npm run lint --workspaces` : propre.
- `npm run build:web` (`apps/client`) : succès, relancé après chaque tâche qui touchait une
  dépendance du bundle (L6-00, L6-03).
- `tools/secret-scan/scan.sh` : `OK`, relancé après chaque tâche.

**Ce que cette vérification ne couvre pas, et qui reste à faire dès qu'une base sera relancée** :
la suite Odoo complète, `make verify`, et surtout le test de concurrence L4-11 -- sans rapport avec
les changements de cette nuit, mais jamais confirmé vert *ce soir*, contrairement aux nuits
précédentes qui le relançaient systématiquement. À faire en tête de la prochaine session avant
toute nouvelle tâche, pour ne pas laisser deux sessions sans cette confirmation.

---

## Ce qui reste ouvert pour la prochaine session

1. **Le pont serveur de L3-11 n'existe pas** (`services/realtime/src/ws/resync.ts`) — le client de
   L6-04 sait envoyer `session.resync` et rejouer sa file, mais aucun serveur ne répond encore par
   `session.synced`. À ouvrir avant ou avec L6-06 (premier écran qui aura besoin d'un
   aller-retour réel, pas seulement simulé).
2. **Le pont JSON-RPC authentifié par jeton Bearer n'existe pas côté Odoo** (L6-03) -- le client
   (`createJsonRpcClient`) est posé et testé contre un point de terminaison simulé, mais le
   JSON-RPC natif d'Odoo n'authentifie que par session de cookie ou par `(db, uid, password)`. À
   vérifier avant que L6-10 (historique, factures) ne suppose ce pont acquis.
3. **Douze nouvelles dépendances en deux nuits** (trois L6-01/L6-02 hier, neuf ce soir --
   `@react-navigation/*`/`react-native-screens` et l'outillage web de L6-00, puis
   `@react-native-async-storage/async-storage` pour L6-04). Aucun signe de coût réel constaté
   jusqu'ici (`native-stack` et l'AsyncStorage natif, pas de pile JS lourde ajoutée ; l'outillage
   web ne fait partie d'aucun bundle natif) -- à surveiller si le rythme se maintient au lot
   suivant, la mesure réelle restant L6-17.
4. **L3-12** — file persistante avec rejeu côté service temps réel. Inchangé depuis J10 -- à ne
   pas confondre avec la file de `packages/api-client/src/realtime/queue.ts` posée ce soir, qui
   est côté client, pas côté service.
5. **L4-06** — la facture. Inchangé.
6. **La validation du plan comptable** — trois questions à poser au comptable, inchangé.
7. **La vérification développeur Android** — inchangé.

Le lot L6 ferme ses quatre fondations partagées en deux nuits (L6-01/L6-02 hier, L6-00/L6-03/L6-04
ce soir). La prochaine session qui ouvre L6-06 trouve une arborescence, un client API traduit en
français, une carte, et un client temps réel avec sa politique de reconnexion -- mais aussi deux
ponts serveur qui restent à construire (L3-11, JSON-RPC authentifié) avant que les écrans qui en
dépendent ne puissent être vérifiés de bout en bout plutôt que contre un double.
