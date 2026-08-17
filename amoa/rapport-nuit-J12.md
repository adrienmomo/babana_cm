# Rapport de nuit — J12

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-20.md` lu en entier avant d'ouvrir quoi que
ce soit — §1 de ce document est la correction la plus coûteuse de la semaine, arbitrée en D34.
Deux corrections d'abord (D34, l'endpoint manquant), puis la première pierre de L6 : abstraction
carte et navigation, connexion Google Sign-In. Pas d'écran métier cette nuit.

---

## D34 — la créance ne se solde qu'à hauteur du reçu

**Ce qui était faux.** `_babana_post_accounting_entry` (L5-05) créditait la créance chauffeur du
montant attendu **en entier** (`counted_amount + discrepancy_amount`), en reclassant l'écart sur
son propre compte à la même écriture. En comptabilité, un chauffeur qui remettait 40 000 sur
45 000 dus ne devait donc plus rien — alors que D29 et le compte courant (`babana.cash.movement`)
disaient encore 5 000 dus, et que ces 5 000 continuaient de peser sur son plafond. Deux systèmes
prétendant chacun dire la vérité, et la disant en sens opposé. La dérive se voyait à la remise
suivante : les 5 000 manquants remis, la créance créditée de 5 000 de plus, passage en **solde
créditeur** — les livres affirmant que l'entreprise devait de l'argent à un chauffeur qui lui en
devait.

**Le correctif** (`babana_cash_remittance.py`) :

- `_babana_post_accounting_entry` ne prend plus qu'un paramètre (`counted_amount`) et ne pose
  qu'**une seule paire** débit/crédit : caisse au débit, créance au crédit, pour le seul montant
  réellement compté. Aucune pièce du tout si `counted_amount` est nul (rien de reçu, rien à
  journaliser) — `move_id` reste alors vide, `action_validate` (déjà correct sur ce point) le
  gérait déjà pour le mouvement de compte courant, il fallait le même réflexe côté comptabilité.
- Nouvelle méthode `_babana_post_discrepancy_writeoff(amount)` : compte d'écart au débit, créance
  au crédit, pour le reliquat. Appelée **uniquement** depuis
  `babana_cash_discrepancy.py::action_close`, et seulement quand la décision n'est pas
  `left_on_balance` — c'est-à-dire seulement au moment où une décision humaine (ajustement,
  retenue) éteint réellement la dette. Le traitement par défaut de D29 (ne rien décider) ne pose
  toujours aucune écriture, exactement comme il ne pose toujours aucun mouvement de compte
  courant : ne rien décider, c'est laisser la dette où elle est, dans les deux systèmes à la fois.
- Nouveau champ `babana.cash.discrepancy.write_off_move_id`, symétrique de
  `adjustment_movement_id` : vide pour le défaut D29, référence la pièce d'extinction pour un
  traitement explicite. Ajouté à la vue formulaire à côté de son symétrique.

**Deux tests qui comptent, ajoutés à `test_remittance_accounting.py` :**

- `test_the_accounting_shortfall_matches_the_running_balance` — le reliquat non crédité en
  comptabilité (`expected_amount - credited`) égale exactement `driver.cash_balance` tant
  qu'aucune décision n'a été prise. Les deux systèmes se vérifient l'un l'autre au lieu de se
  contredire, comme le demande le critère 3 réécrit de L5-05.
- `test_two_successive_partial_remittances_never_leave_the_receivable_in_a_credit_balance` — le
  scénario exact de l'arbitrage : 45 000 dus, 40 000 remis, puis 5 000 remis. `driver.cash_balance`
  tombe à 0 après la seconde remise (jamais négatif), et le total réellement crédité sur le compte
  de créance (`account.move.line`, sommé sur les deux pièces) vaut 45 000, pas plus. La seconde
  remise nait avec `expected_amount = 5000` (le solde restant à l'instant de sa création), pas
  45 000 — gel déjà correct depuis L5-03, vérifié ici dans le nouveau contexte.

Complété par `test_the_validation_move_never_touches_the_discrepancy_account` (renommé et réécrit
depuis l'ancien `test_a_discrepancy_produces_a_distinct_line_on_the_discrepancy_account` : la
validation ne doit plus jamais produire de ligne sur le compte d'écart), et côté
`test_discrepancy.py`, `test_an_explicit_adjustment_writes_off_the_remaining_receivable` (la pièce
d'extinction existe, est postée, et le total crédité sur la créance atteint 45 000 une fois la
dette éteinte) et son contrôle négatif `test_the_default_treatment_posts_no_write_off_move`.

`make test` ciblé (`TestRemittanceAccounting`, `TestCashDiscrepancy`) contre la pile déjà en
marche : 24 tests, 0 échec. Vérification complète sur base fraîche en fin de session (voir
dernière section).

**Le plan comptable.** Rien à faire ici — l'arbitrage (comptes provisoires conservés, validation
par un comptable entrée dans les prérequis) a déjà été déposé la nuit dernière dans
`01-architecture.md` §7 et `05-prerequis-et-simulation.md` §5, avant le début de cette session.

---

## `GET /drivers/me/cash` — le trou signalé la nuit dernière

Le contrat C-01 (`settlement.ts`) prévoit l'endpoint depuis le début, mais aucune tâche du
découpage ne le demandait explicitement — signalé comme tel dans le rapport de J11
(`REPONSES-2026-08-20.md` §4). Pas de tâche dédiée dans `amoa/specs/` : décision d'implémentation
non spécifiée (nommage, emplacement), tranchée et avancée plutôt que bloquée, comme le permet
`CLAUDE.md`.

**Placé dans `controllers/driver.py`** (`DriverController`), à côté de `/drivers/me/availability`
plutôt que dans un fichier calqué sur le nom du contrat (`settlement.ts` porte aussi
`POST /rides/{id}/settle`, déjà dans `RideController`) — les deux routes `/drivers/me/*`
partagent l'authentification et le même contrôleur logique côté chauffeur. Route `GET`, pas de
`readonly=False` : cet endpoint ne modifie rien, le défaut d'Odoo 18 convient déjà.

**`balance` et `limit`** : lecture directe de `driver.cash_balance` / `driver.cash_limit`, déjà
calculés (L5-01, L5-02) — aucune règle nouvelle. **`collectedToday`** : nouvelle méthode
`babana_driver.py::_babana_cash_collected_today`, somme des mouvements `collection` du jour
(le seul type qui correspond à « courses réglées du jour », L5-07). `fields.Date.context_today`,
pas `fields.Date.today()` — cas explicitement réservé par `code/docs/odoo-pitfalls.md` : un
chauffeur qui regarde son écran dans son propre fuseau horaire, pas un cron ni une valeur par
défaut sans utilisateur connecté.

**Tests** (`test_driver_cash_controller.py`, nouveau, même patron que
`TestRemittanceController` — jeton réel via `_issue_access_token`, pas le parcours Google mock
complet) : solde/plafond/encaissé corrects sur plusieurs encaissements, une déclaration de remise
seule ne modifie pas l'encaissé du jour (seule la validation touche le compte courant, L5-04),
chauffeur non approuvé rejeté (`DRIVER_NOT_APPROVED`), jeton absent rejeté (`UNAUTHORIZED`),
forme de la réponse limitée aux trois champs du contrat. Module enregistré dans
`tests/__init__.py` (oublié une fois, corrigé en vérifiant que la suite ciblée trouvait bien les
tests — 0 test chargé silencieusement la première fois, jusqu'à l'ajout).

`make test` ciblé (`TestDriverCashController`) : 5 tests, 0 échec. `code/docs/contracts/
http-api.md` mis à jour : la mention « Non implémenté (L4-03) » en tête de la section Caisse
était stale depuis L4-05/L5-05 (le règlement de course est implémenté depuis longtemps) —
retirée.

---

## L6-01 — Abstraction carte et navigation

**La frontière est le but de la tâche, pas un effet de bord.** `packages/maps/src/index.ts`
(placeholder de L0-03, `NotYetImplementedMapProvider` qui levait volontairement à chaque appel)
est remplacé par une vraie implémentation, structurée en fournisseurs derrière une interface
`MapProvider` unique : `MapView` (composant), `openNavigation`, `searchPlace`, `reverseGeocode`.

**Deux fournisseurs, un seul branché.** `providers/google/` (réel, v1) implémente les quatre
capacités avec `react-native-maps` (nouvelle dépendance, cf. ci-dessous) pour la carte, un lien
profond `Linking.openURL` vers Google Maps pour la navigation (D12), et les API REST Google
Places/Geocoding pour la recherche et le géocodage inverse. `providers/empty/` implémente le même
contrat sans importer quoi que ce soit du SDK — c'est le critère d'acceptation 5, « le vrai test » :
si cette seconde implémentation ne compilait pas, l'abstraction serait un habillage autour d'une
seule implémentation, pas une vraie frontière. `activeProvider.ts` est le seul fichier qui choisit
le fournisseur actif (`googleMapProvider` aujourd'hui) — c'est aussi le seul fichier que L6-18
touchera pour brancher un fournisseur web (critère d'acceptation 6), jamais un écran.

**`openNavigation`, signature indépendante de l'implémentation (critère 3).** V1 ouvre un lien
profond et approxime la fin du guidage par le retour de l'app au premier plan après l'avoir
quittée pour Google Maps (`AppState`, aucun rapport d'arrivée réel n'existe derrière un lien
profond) — un aller-retour complet est exigé (quitter puis revenir), pas seulement un événement
`active` isolé, pour ne pas déclencher `onComplete` sur un signal parasite. V2 (SDK embarqué)
remplacera uniquement `providers/google/navigation.ts`, avec la même signature
`openNavigation(destination, { onComplete })`.

**Aucun type du SDK dans l'interface publique (critère 1) — vérifié par le lint, pas seulement par
revue (critère 2, et la phrase de spécification qui va plus loin : interdit aussi hors de
`providers/`).** Nouvel override dans `.eslintrc.cjs` : `packages/maps/src/**` (hors
`src/providers/`) ne peut importer aucun des quatre paquets déjà blacklistés pour `apps/*`
(`react-native-maps`, `react-native-google-maps`, `expo-maps`, `@react-native-mapbox-gl/maps`).
Vérifié en écrivant un fichier sonde (`import 'react-native-maps'` à la racine de `src/`) : erreur
de lint immédiate, supprimé aussitôt après. Pour que cette règle s'exécute réellement (elle ne
l'aurait jamais fait : aucun script `lint` n'existait sur ce paquet, contrairement à `apps/client`
et `apps/driver`), `packages/maps` reçoit sa propre config ESLint locale (`.eslintrc.js`, même
patron que les apps — `root: true` retiré pour se combiner avec la config racine) et son script
`lint`.

**`react-native-maps` (^1.29.0), nouvelle dépendance — signalée, pas ajoutée en silence
(`CLAUDE.md`, « dépendance nouvelle »).** C'est la bibliothèque que le lint de L0-03 anticipait
déjà nommément (première de la liste blacklistée pour `apps/*`), et le SDK que le comparatif
`02-comparatif-cartographie.md` désigne pour le rendu de carte natif Android/iOS. Compatible React
19.2.3 / React Native 0.86.2 (peer dependencies vérifiées avant l'ajout). Le rendu natif réel
(clé API dans `AndroidManifest.xml`/`Info.plist`) n'est pas câblé cette nuit : aucun écran
cartographique n'existe encore pour l'exercer, et la clé Google Maps est un prérequis déjà suivi
(`05-prerequis-et-simulation.md` §5, « avant L6-06 ») — câblage natif à faire au moment de L6-06,
pas avant.

**La clé pour les appels REST (Places, Geocoding) est injectée, jamais lue depuis
`process.env` par le paquet lui-même.** `apps/*/config.ts` inline les variables d'environnement
au moment du bundle Babel (`babel-plugin-transform-inline-environment-variables`, L0-03) — mais
`@babana/maps` est prébuilt en `dist/` par `tsc`, sans passe Babel, donc `process.env` n'y est
jamais substitué. `configureMapsProvider({ apiKey })`, exporté par le paquet, doit être appelé une
fois au démarrage de l'app (pas fait ce soir, aucun point d'entrée d'écran n'existe encore pour
l'appeler légitimement) ; tant qu'il ne l'est pas, `searchPlace`/`reverseGeocode` lèvent une erreur
explicite plutôt que d'échouer silencieusement sur une clé vide.

**Testable sans SDK réel (critère 4).** `navigation.ts` (Linking/AppState mockés) et `places.ts`
(`fetch` mocké) ne chargent jamais `react-native-maps`. Un seul fichier de test le charge
réellement — `MapView.test.tsx`, contre un double (`__mocks__/react-native-maps.tsx`, activé
explicitement par `jest.mock`), pour un test de rendu fumée. `packages/maps` recevait son propre
`jest.config.js`/`babel.config.js` pour la première fois (même patron RN que `apps/client`) — la
spécification demandait un dossier `test/`, il n'existait aucune infrastructure pour l'exécuter.

**Tests** (`packages/maps/test/`, 4 fichiers, 14 cas) : lien profond vers la bonne destination,
`onComplete` jamais déclenché sur un événement `AppState` parasite, `onComplete` déclenché sur un
aller-retour réel, échec silencieux côté utilisateur si aucune app Maps n'est disponible ;
recherche de lieu traduite en résultats propres au paquet, `ZERO_RESULTS` sans erreur, statut
Google en erreur explicite, géocodage inverse et son cas `null` ; fournisseur vide qui échoue
explicitement sur chacune des quatre capacités (et compile contre `MapProvider`, la vraie
preuve) ; rendu de `<GoogleMapView>` sans lever d'erreur.

`npm run typecheck`, `npm run lint`, `npm test` (`-w @babana/maps`) : propres, 14 tests. Suite
élargie (`npm run typecheck --workspaces`, `npm run lint --workspaces`) : propre sur les neuf
paquets/apps, aucune régression des placeholders `@babana/maps` déjà en place ailleurs (aucune app
ne l'importait encore réellement, seulement en commentaire de `App.tsx` — vérifié par recherche
plutôt que supposé).

**Ce qu'un écran importera** — la question posée pour calibrer le reste du lot, voir la dernière
section de ce rapport.

---

## L6-02 — Connexion Google

**Toute la logique dans `packages/api-client/src/auth/`, rien dans les écrans (invariant 3).**
Quatre fichiers : `tokenStorage.ts` (stockage sécurisé), `googleSignIn.ts` (obtention de l'ID
token, chemin natif), `session.ts` (`AuthClient`, échange, renouvellement, déconnexion), et
`index.ts` (barrel). `packages/api-client/src/metrics.ts`, nouveau, un seul point d'accroche
minimal — voir plus bas.

**Jetons dans le trousseau, jamais dans un stockage clé-valeur ordinaire (critère 1).**
`tokenStorage.ts` enveloppe `react-native-keychain` (nouvelle dépendance, signalée : pas d'API
Keychain/Keystore native sans bibliothèque tierce) derrière une interface `TokenStorage` à trois
méthodes (`save`/`load`/`clear`) — l'injection permet de tester `AuthClient` sans jamais toucher
le trousseau réel (`session.test.ts` utilise un stockage en mémoire).

**Renouvellement transparent, un seul réessai (critères 2 et 3).** `withTransparentRefresh(base,
auth)` enveloppe n'importe quel `HttpClient` (`createHttpClient`, L0-03) : une requête qui échoue
en `TOKEN_EXPIRED` déclenche `auth.refresh()` puis un réessai unique de la même requête — jamais
une boucle, jamais un second réessai sur le réessai (test explicite : un second `TOKEN_EXPIRED`
après renouvellement remonte tel quel à l'appelant). Si `refresh()` échoue à son tour (jeton de
renouvellement révoqué), `AuthClient.handleRefreshFailure()` efface la session locale puis appelle
`onSessionLost` — dans cet ordre, l'app ne doit jamais voir le rappel avant que la session ne soit
réellement effacée — et l'erreur `TOKEN_EXPIRED` d'origine est relancée, jamais l'échec du
renouvellement lui-même : l'appelant reçoit toujours un code qu'il sait déjà interpréter.

C'est un morceau de ce que L6-03 (client API partagé, pas commencé) devra généraliser à toute
erreur métier et à la temporisation croissante — ici, seulement le renouvellement transparent
qu'exigent les critères propres à L6-02, pas la totalité de L6-03 par anticipation.

**Un seul point d'échange, quel que soit le chemin d'obtention (critère 6).**
`AuthClient.exchangeGoogleIdToken(idToken, role)` appelle `POST /auth/google` et persiste la
session ; `googleSignIn.ts` (natif) ne fait que produire un `idToken` et ne connaît rien de
l'échange. `webGoogleSignIn.ts` (L6-18, flux OAuth web, hors de ce lot) n'aura donc rien à
dupliquer — seulement produire un `idToken` à son tour.

**Absence de Google Play Services, gérée explicitement (critère 4, risque É1).**
`GoogleSignin.hasPlayServices()` est appelé avant tout `signIn()` ; son échec avec le code
`PLAY_SERVICES_NOT_AVAILABLE` est traduit en `GooglePlayServicesUnavailableError` (message clair,
distinct d'une annulation) et remonte une métrique (`reportMetric('auth.google_play_services_
unavailable')`) — c'est cette mesure qui dira s'il faut rouvrir D4. **`metrics.ts` est provisoire
et documenté comme tel** : aucun collecteur ni endpoint de télémétrie n'existe encore dans le
dépôt (L6-17, hors de ce lot) ; pour ce soir, un seul point d'accroche (`console.warn`) pour que
L6-17 n'ait qu'un seul endroit à brancher sur un vrai collecteur plutôt que de retrouver des
`console.warn` épars dans chaque appelant.

**Un chauffeur `pending` reçoit une session, jamais une erreur (critère 5).** Rien à construire
côté serveur (`AuthSessionSchema.user.driverStatus`, déjà porté par L1-01) : `SignInScreen.tsx`
transmet la session entière à `onSignedIn`, `driverStatus` y compris. Le routage vers l'écran de
suivi de dossier (L6-15, pas commencé) n'est donc pas câblé ce soir — vérifié qu'aucune navigation
n'existe encore dans le dépôt avant d'écrire cette limite plutôt que de la deviner — mais la
donnée dont ce routage aura besoin est déjà là, testée (`test('critère d'acceptation 5...')`,
`apps/driver/src/screens/__tests__/SignInScreen.test.tsx`).

**Deux nouvelles dépendances, signalées.** `react-native-keychain` (^10.0.0) et
`@react-native-google-signin/google-signin` (^16.1.4) — compatibilité React 19.2.3 / React Native
0.86.2 vérifiée avant l'ajout (peer dependencies). Toutes deux dans `packages/api-client`, jamais
dans les apps directement (même discipline que `react-native-maps` dans `@babana/maps`, L6-01) :
les apps ne savent pas qu'elles existent, elles importent `@babana/api-client`.

**L'empreinte de signature Android — documentée, pas supposée faite.** Trois identifiants OAuth
distincts dans Google Cloud Console, aucun ne se substitue à un autre :
1. Un identifiant **Web** (`BABANA_GOOGLE_WEB_CLIENT_ID`, nouvelle variable
   `infra/env/.env.example`) — c'est lui qui devient l'audience (`aud`) de l'ID token, et doit
   donc être l'un des identifiants déjà listés dans `GOOGLE_OAUTH_CLIENT_IDS` (vérifié côté
   serveur, `controllers/auth.py`) : une valeur absente de cette liste produit une connexion
   Google qui réussit visuellement puis un `INVALID_GOOGLE_TOKEN` côté serveur.
2. Un identifiant **Android**, par empreinte SHA-1 du certificat de signature — **une pour le
   certificat de développement, une seconde pour celui de publication**. Jamais passé en
   configuration côté code : Google le retrouve depuis le nom de package et l'empreinte au moment
   de l'appel. Oublier la seconde empreinte produit une connexion qui fonctionne en développement
   et échoue en production — documenté dans `googleSignIn.ts` et `infra/env/.env.example`, pas
   seulement dans `05-prerequis-et-simulation.md` (déjà à jour depuis la nuit dernière).
3. (iOS) Un identifiant **iOS** (`BABANA_GOOGLE_IOS_CLIENT_ID`) et l'URL scheme correspondant dans
   `Info.plist` — non câblé côté `Info.plist` ce soir (aucun compte Google réel, D19 ; à faire au
   moment des tests sur appareil réel, déjà dans les prérequis).

**Un écran très mince (73 lignes, `SignInScreen.tsx`), plus 30 lignes de bootstrap
(`src/auth.ts`).** Voir la dernière section de ce rapport pour le détail de ce que ça révèle sur
la suite du lot.

**Deux pièges Jest rencontrés en écrivant les tests, documentés dans les fichiers de
configuration eux-mêmes plutôt que dans ce seul rapport :**
- `@react-native-google-signin/google-signin` ne publie qu'un **build ESM** (`exports.default`
  pointe sur `lib/module/`, aucune condition `require`) — le préréglage Jest de React Native ne
  transpile que `react-native`/`@react-native(-community)` par défaut, il a fallu étendre
  `transformIgnorePatterns` dans les trois `jest.config.js` concernés (`packages/api-client`,
  `apps/client`, `apps/driver`).
- Son module natif appelle `TurboModuleRegistry.getEnforcing()` **au chargement du module**, pas
  seulement à l'appel d'une fonction — même un test qui se contente d'importer
  `@babana/api-client` (`jest.requireActual`, pour composer un mock partiel) a donc besoin du
  double officiel du module natif que la bibliothèque fournit elle-même
  (`jest/build/jest/setup.js`), chargé par chemin de fichier direct dans
  `packages/api-client/node_modules` (la seule copie installée dans ce monorepo — vérifié, pas
  hoistée à la racine) : une résolution par spécificateur de paquet échoue, sa carte `exports` ne
  publie pas ce sous-chemin.

**Tests** (18 cas au total) : `packages/api-client/test/` (14 cas — `tokenStorage.test.ts` avec un
double en mémoire du trousseau nommé hors de la convention `__mocks__/<module>` pour éviter une
récursion infinie constatée en écrivant le test ; `googleSignIn.test.ts` contre le double officiel
de la bibliothèque ; `session.test.ts`, échange/renouvellement/déconnexion et les quatre scénarios
de `withTransparentRefresh`) ; `apps/client` et `apps/driver`, trois tests chacun
(`SignInScreen.test.tsx` — échange avec le bon rôle, message Play Services, et pour le chauffeur,
le critère 5 explicitement nommé).

`npm run typecheck --workspaces`, `npm run lint --workspaces` : propres. `npm test`
(`-w @babana/api-client -w @babana/client -w @babana/driver`) : 18 + 4 + 4 = 26 tests, 0 échec.
Suite complète du monorepo relancée en fin de session (voir dernière section).

---

## À quoi ressemble un écran, concrètement

La question posée en tête de nuit. Réponse depuis `SignInScreen.tsx` (73 lignes, JSX et styles
compris) et son bootstrap `src/auth.ts` (30 lignes) — le seul écran construit ce soir, mais le
patron vaut pour n'importe quel écran à venir, y compris cartographique.

**Ce qu'un écran importe.** Trois sources, jamais un SDK directement :
- `@babana/ui` pour les primitives d'interface (`Button` ici ; `MapView` viendra de `@babana/maps`
  le jour où un écran affiche une carte — même règle, `import { MapView } from '@babana/maps'`,
  jamais `react-native-maps`).
- `@babana/api-client` pour l'action et ses types (`signInWithGoogleNative`, les classes d'erreur,
  `AuthState`).
- Un fichier local à l'app, pas dans `screens/` (`../auth.ts` ici) : la construction du singleton
  (session, client HTTP authentifié) qui a besoin de la configuration de build (`config.ts`,
  clés). Chaque écran qui a besoin du réseau importera ce même fichier, jamais
  `@babana/api-client` directement pour se construire son propre client.

**Ce dont il dépend, au sens le plus étroit.** De rien d'autre : pas de state global (Redux,
Zustand, contexte React maison), pas de couche de données. `useState` local pour `pending`/
`error`, un `async` dans le gestionnaire de bouton. Toute la logique métier (obtention du jeton,
échange, persistance, renouvellement) vit une couche plus bas ; l'écran orchestre trois appels et
affiche trois états (repos, en cours, erreur).

**Combien de lignes pour un bouton et un résultat.** ~50 lignes de logique et de JSX, ~20 de
styles `StyleSheet.create` — la moitié du fichier est de la mise en forme, pas de la logique.
Un écran avec une carte ajoutera peu : `<MapView center={...} markers={...} />` est une balise,
pas un abonnement à gérer (L6-01 a déjà posé la mise à jour de la position sous forme de props,
`onRegionChange`) — le coût réel d'un écran cartographique sera dans la gestion d'état de l'écran
lui-même (sélection en cours, réticule, résultats de recherche affichés), pas dans l'intégration
de la carte.

**Ce qui manque, et qui pèsera sur tout le reste du lot : aucune navigation n'existe encore.**
`App.tsx` (L0-03) n'a pas été touché ce soir — il n'affiche toujours que le squelette d'origine,
`SignInScreen` n'est câblé dans aucun des deux `App.tsx`. `SignInScreen` reçoit un callback
(`onSignedIn: (session) => void`) plutôt qu'une prop de navigation typée, faute d'un `NavigationContainer`
pour lui en fournir une — choix d'implémentation non spécifié, tenu volontairement minimal. Ce
choix ne survivra pas à un second écran : dès que deux écrans doivent s'enchaîner (connexion →
accueil, ou accueil → estimation), il faut soit une bibliothèque de navigation (`@react-navigation/
native`, la plus standard pour React Native, compatible React Native Web pour D22), soit un
routeur maison. **Aucune tâche du découpage L6 ne pose cette fondation explicitement** — L6-06
(écran d'accueil Client) et L6-08 (attente/refus) la supposent implicitement en s'enchaînant. À
trancher avant d'ouvrir L6-06 : soit une tâche dédiée (une « L6-00 » de navigation), soit
l'absorber dans L6-06 elle-même, au prix d'un lot plus lourd que les autres de ce découpage.
