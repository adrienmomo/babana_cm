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

## Ce que L6-06 devra encore écrire

Question posée en tête de nuit : une fois navigation, client API et carte posés, que reste-t-il à
faire pour l'écran d'accueil Client ?

**Ce qu'il n'aura pas à écrire, parce que c'est déjà fait :**
- Se soucier de la session — il vit sous `AuthGate`, jamais atteint sans elle.
- Construire un client HTTP ou WebSocket — `../auth.ts` (`apiClient`) est déjà là ; L6-03 ce soir lui
  donne ses réessais et ses messages d'erreur.
- Choisir une bibliothèque de carte, gérer le SDK — `@babana/maps` expose `MapView`,
  `searchPlace`, `reverseGeocode` en trois imports.
- Décider où le bouton de connexion mène — déjà câblé, l'écran d'accueil n'existe que parce que la
  session existe.

**Ce qu'il devra écrire, et qui n'existe nulle part encore :**
1. **La position du client** — aucune capture de géolocalisation ponctuelle n'existe dans le dépôt
   (L6-05 capture la position du *chauffeur* en continu, un besoin différent : ici, une position
   unique au chargement de l'écran, pour centrer la carte et pré-remplir le départ). Permission
   `ACCESS_FINE_LOCATION`, refus géré sans bloquer l'écran.
2. **`GET /drivers/nearby`, jamais appelé** — le contrat existe (C-01), aucun code client ne
   l'invoque. Et sa mise à jour « en direct » (critère 3 de L6-06) passe par le canal temps réel
   (`nearby.drivers`, C-02) — c'est le client WebSocket (L6-04, ce soir) qui portera l'abonnement,
   mais aucun écran ne le consomme encore : ce sera la première consommation réelle du client
   WebSocket construit cette nuit.
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

Rien de tout cela n'est bloqué par ce qui manque encore côté L6-03/L6-04 (qui ferment ce soir) : la
première vraie carte tarifera la profondeur de ce state local, pas l'intégration réseau.

---
