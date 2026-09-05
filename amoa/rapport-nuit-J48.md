# Rapport — nuit J48 (5 septembre 2026)

Périmètre : finir L6-18 (export web du Client), commitée `(part)` il y a quatre semaines
(`amoa/01-architecture.md` §9 sexdecies, D74). Trois pièces manquantes : le stockage de session
web (D39), le flux OAuth web, le fournisseur de carte web.

Lu en entier avant d'écrire du code : `CLAUDE.md`, `amoa/01-architecture.md` §9 sexdecies et le
registre du §13, `amoa/specs/L6-mobile.md` (spécification L6-18 en entier), `amoa/
09-recette-babana-dev.md`.

---

## 0. Un prérequis manquant, signalé avant d'écrire du code

`amoa/PROMPT-NUIT-J48.md` demandait un projet Google Cloud (identifiant OAuth Web + clé Maps
JavaScript) déposé dans `infra/env/.env` avant cette nuit. Vérifié dans le fichier, jamais dans
le prompt : toujours les valeurs factices de `.env.example`. Signalé immédiatement plutôt que de
construire un contournement de développement ; les deux valeurs ont été fournies en cours de
session et déposées dans `infra/env/.env` (jamais commité, `.gitignore` vérifié avant et après).
Détail et implications dans `amoa/questions/L6-18-verification-navigateur.md`.

## 1. Le stockage de session web (D39)

`packages/api-client/src/auth/tokenStorage.web.ts` — résolu à la place du fichier natif par
l'extension `.web.ts` (même mécanisme que `location.web.ts`/`config.web.ts`, étendu ici à un
paquet prébuilt). Aucune persistance : une variable de module, effacée avec l'onglet. Le
contournement du 24 août (`webpack-stubs/react-native-keychain.web.js`, clair dans
`localStorage`) est supprimé, avec son alias dans `webpack.config.js`.

Deux fichiers de configuration TypeScript par paquet web (`tsconfig.json` exclut les `*.web.ts`,
`tsconfig.web.json` les compile séparément avec la lib DOM) — pattern répété pour les trois
pièces, expliqué en commentaire dans chaque `tsconfig.web.json` : sans lui, `document`/`window`
ne typaient pas, et les inclure dans le projet natif aurait masqué un usage DOM accidentel dans
un fichier natif (même raisonnement que le commentaire déjà présent sur `index.web.tsx`).

4 tests (`test/tokenStorage.web.test.ts`) : sauvegarde, lecture, effacement, et non-persistance
entre deux imports du module (équivalent d'un nouvel onglet).

## 2. Le flux OAuth web

`packages/api-client/src/auth/googleSignIn.web.ts` — Google Identity Services (GIS) chargé à la
demande, un recouvrement plein écran hébergeant le vrai bouton Google (`renderButton`), jamais un
bouton maison. Mêmes exports que le fichier natif (`configureGoogleSignIn`,
`signInWithGoogleNative`, `GoogleSignInCancelledError`, `GooglePlayServicesUnavailableError`) :
`SignInScreen.tsx` n'a pas changé d'une ligne, `index.ts` ne sait pas lequel des deux fichiers a
été résolu.

**Écart de nommage, non bloquant** : la spécification nomme `web.ts` ; livré sous
`googleSignIn.web.ts` pour rester cohérent avec le mécanisme d'extension déjà en place, sans
fichier `index.web.ts` supplémentaire. Détaillé dans le fichier d'écart (§3).

**Vérifié dans node_modules avant d'écrire ce fichier** : `@react-native-google-signin/
google-signin` ne fournit pas de web gratuit (`lib/module/signIn/GoogleSignin.web.js` lève
« Web support is only available to sponsors » pour tout appel) — `webpack.config.js` l'anticipait
à tort ; ce paquet n'est plus référencé nulle part dans le graphe du bundle web.

`packages/api-client/src/auth/google.web.d.ts` : surface minimale de types pour GIS, pas
`@types/google.accounts` (poids non nécessaire pour une poignée de méthodes).

6 tests (`test/googleSignIn.web.test.ts`), sans jsdom ni SDK réel (même discipline que le reste du
paquet) : chargement du script une seule fois, initialisation avec l'identifiant configuré,
résolution avec le credential reçu, annulation (aucun credential, et clic sur Annuler), réemploi
du script déjà chargé pour une seconde tentative.

## 3. Le fournisseur de carte web

`packages/maps/src/providers/web/` — troisième implémentation derrière `MapProvider`, Google Maps
JavaScript chargé à la demande (`loadGoogleMaps.ts`), avec la même clé que les appels REST
(`configureMapsProvider`, aucune configuration nouvelle). `searchPlace`/`reverseGeocode` sont
réimportés tels quels depuis `providers/google/places.ts` (pur REST, aucun SDK) plutôt que
dupliqués. `activeProvider.web.ts` choisit ce fournisseur par extension, jamais par
`Platform.OS` lu à l'exécution — c'est ce qui permet à `react-native-maps` de ne plus jamais
apparaître dans le graphe du bundle web (vérifié : `grep -c react-native-maps dist-web/bundle.js`
→ 0).

`packages/maps/src/index.ts::configureMapsProvider` pointait vers le barrel du fournisseur
Google (`./providers/google`), qui importe `MapView.tsx` donc `react-native-maps` dès son
évaluation — changé pour pointer directement vers `./providers/google/config`, qui n'a aucune
dépendance native. Correction minimale, valable pour les deux plateformes, qui rend l'alias
`react-native-maps$` de `webpack.config.js` inutile.

**Piège trouvé en écrivant `MapView.tsx` (web), corrigé par le test avant le commit** : les
effets de synchronisation des marqueurs/tracé lisaient `window.google?.maps` avant de vérifier
`ready`/`map` — si `window` lui-même n'existe pas (dégradation complète, script jamais chargé),
`window.google` lève une `ReferenceError` au lieu de rendre silencieusement rien. Le test
« ne lève pas si la carte ne peut pas se charger » l'a fait échouer avant tout commit ; corrigé en
réordonnant les gardes.

13 tests répartis sur quatre fichiers (`webMarkerIcon`, `webLoadGoogleMaps`, `webNavigation`,
`webMapView`) — ce dernier utilise `createNodeMock` (react-test-renderer) pour obtenir un
conteneur factice, faute de quoi un ref vers un composant hôte résout toujours à `null` en test :
construction de la carte centrée sur la position initiale (jamais recentrée si `center` change
après coup, même sémantique que `initialRegion` côté natif), marqueur par entrée, polyligne posée
et retirée.

## 4. Dégradations signalées

`apps/client/src/components/WebDemoBanner.tsx` — un seul `Platform.OS === 'web'`, dans ce fichier,
jamais dans un écran. Bandeau permanent, monté dans `src/navigation/index.tsx` **avant** la garde
d'authentification (visible dès l'écran de connexion — c'est justement là que « session non
persistée » doit se comprendre avant de fermer l'onglet). Quatre limites nommées : notifications
push, capture de position en arrière-plan, lien profond de navigation (`providers/web/
navigation.ts` : nouvel onglet, `onComplete` jamais rappelé, aucune tentative de deviner un retour
par `visibilitychange` — un faux positif aurait été pire qu'une absence assumée), session non
persistée. 2 tests.

## 5. Vérification navigateur réelle (point 9)

**Ce que j'ai vu, dans cet ordre, dans un vrai navigateur :**

1. `http://localhost:8080/` (voir §6 pour le certificat) : écran de connexion, bandeau de
   démonstration visible immédiatement.
2. Clic sur « Se connecter avec Google » → recouvrement avec le **vrai** bouton Google (rendu par
   `renderButton`, pas une image) → clic → **connexion réelle aboutie** avec l'identifiant client
   web fourni cette nuit → navigation directe vers l'écran d'accueil.
3. **Une vraie carte Google Maps**, interactive, avec les vrais noms de quartiers de Douala
   (Bonamoussadi, Ndogpassi, PK10/PK11, Bassa), attribution « Google » et « Données
   cartographiques ©2026 » visibles en bas de carte.
4. Glissé la carte : le champ « Arrivée » s'est mis à jour en direct avec les coordonnées du
   nouveau centre (`onRegionChange` réellement câblé jusqu'à l'écran, sans qu'aucun écran n'ait
   changé).
5. « Suivant » → un vrai devis calculé côté serveur (`641 350 FCFA`, distance et durée cohérentes
   avec les deux points choisis — la distance aberrante vient du point de départ réel du
   navigateur, en Europe, pas d'un défaut de code) → « Aucun chauffeur n'est disponible pour le
   moment » (aucun chauffeur en ligne dans cette fenêtre de vérification, voir §6).
6. **Fermé l'onglet, rouvert la même adresse : déconnecté, écran de connexion.** D39 vérifié pour
   de vrai, pas seulement par un test qui appelle `secureTokenStorage.clear()`.

Point de départ affiché en coordonnées européennes : `navigator.geolocation` du poste de test,
sans rapport avec le code de cette nuit — le point d'arrivée, lui, désigné par glissement de
carte, est correct et cohérent avec la vraie carte affichée.

## 6. Deux blocages d'infrastructure, résolus, consignés

Détail complet dans `amoa/questions/L6-18-verification-navigateur.md` :

- **Certificat local de Caddy non approuvé par ce Chrome** — même blocage que J19
  (`amoa/rapport-nuit-J19.md`). Résolu cette fois par un bloc HTTP temporaire dans
  `infra/caddy/Caddyfile` (`http://localhost:8080`, mono-origine, jamais une réponse au problème
  CORS/D46) — retiré avant ce commit, `git status`/`git diff` vérifiés après coup.
- **`GOOGLE_JWKS_URL` n'a qu'une seule source à la fois** — un jeton réellement signé par Google
  (le flux web) et les jetons de `mock-google-identity` (chauffeurs de démonstration, tests) ne
  peuvent pas être vérifiés en même temps par le même Odoo. Basculé temporairement vers le vrai
  point de vérification Google (surcharge Compose locale, jamais committée) pour la fenêtre de
  vérification du navigateur, remis sur le simulateur juste après. C'est ce qui a empêché de
  compléter le cycle jusqu'à l'acceptation par un chauffeur ce soir — le devis, lui, est réel.
  Proposition pour le pilote dans le fichier d'écart.

## 7. Écart hors périmètre, trouvé en vérifiant `make test` en entier

`amoa/questions/L2-01-weekday-mask-midnight-boundary.md` : `test_weekday_mask_restricts_
applicability` (L2-01, tarification) rouge entre 23h00 et 23h59 UTC — le test construit son
« lundi » à partir de l'heure courante sans fixer l'heure du jour, et la conversion UTC→Douala
(UTC+1, comportement voulu de `_find_applicable_rule`) fait franchir minuit à la date locale dans
cette fenêtre précise. Diagnostiqué avec certitude (`date -u` au moment de l'échec : 23:33:37,
dans la fenêtre prédite), pas corrigé (hors périmètre, aucun rapport avec l'export web). Même
famille que `L5-collected-today-timezone-boundary.md`, déjà connu sous un autre module. Attendu
que la fenêtre UTC passe (moins de trente minutes) plutôt que de toucher un fichier hors
périmètre : `make test` a ensuite tourné entièrement vert, voir §9.

Aucun autre écart : pas d'invariant violé, pas de spécification contradictoire sur les trois
pièces de ce soir.

## 8. Passe de clôture — mise à jour de `amoa/rapport-nuit-J41.md`

Rien à rouvrir parmi les quatre tests instables déjà catalogués (aucun rejoué cette nuit, hors
périmètre). Une entrée s'éteint dans « Ce qui est vert mais que personne n'a jamais exercé pour de
vrai » : l'export web du Client, jusqu'ici vérifié seulement jusqu'à l'écran d'accueil (D38), l'est
maintenant jusqu'à un vrai devis et une vraie déconnexion (§5 ci-dessus). Le registre du §13 de
`amoa/01-architecture.md` (L6-18, D74) n'a pas été touché — la numérotation d'une clôture de
décision n'appartient pas à une session de nuit (CLAUDE.md) ; le débrief du lendemain la reprendra.

## 9. `make reset`, `make seed`, `make test`

Dans cet ordre, sur l'infrastructure réelle :

- `make reset` : volumes réellement supprimés.
- `make up` : neuf services sains (`--wait`).
- `make seed` : `== seed babana : OK ==` — zones=6, chauffeurs en ligne=5, courses réglées=8.
- `make test`, en entier : premier passage, un seul échec — `test_weekday_mask_restricts_
  applicability` (§7, hors périmètre, fenêtre UTC). **Deuxième passage, après le passage de
  minuit UTC : 820 tests Odoo, 0 échec, 0 erreur.** `npm test` (tous les paquets, plus les deux
  scripts de vérification de contrat) : vert — `@babana/api-client` 100 tests (17 suites, +10
  cette nuit), `@babana/maps` 33 tests (8 suites, +13 cette nuit), `@babana/client` 112 tests
  (20 suites, +2 cette nuit).
- `npm run lint` (`@babana/maps`, `@babana/client`) et `npm run typecheck` (les trois paquets
  touchés, natif et web séparément) : propres, aucun avertissement restant.

Point 3 de la définition de fini satisfait sur cet état neuf.

---

## L6-18 reste partielle sur deux critères — les deux hors périmètre de cette nuit, pas oubliés

Relu contre les 7 critères d'acceptation de `amoa/specs/L6-mobile.md` pour ne pas répéter le
défaut du 25 septembre (une tâche comptée finie sans relire sa propre spécification jusqu'au
bout) :

- **Critères 1 à 5 : satisfaits**, vérifiés en direct (§5). Le critère 1 (« le parcours complet »)
  s'arrête ce soir à l'écran de devis, faute de chauffeur accepté dans la fenêtre de vérification
  (§6) — le code de suivi et de résumé (`TrackingScreen`, `RideSummaryScreen`) n'a pas changé
  cette nuit et reste couvert par ses propres tests, y compris `webMapView.test.tsx` pour le rendu
  des marqueurs et du tracé qu'ils utilisent.
- **Critères 6 et 7 (« pointe sur la recette, pas la production », « chaque branche produit une
  prévisualisation ») : ni satisfaits ni traités.** Ils décrivent le déploiement lui-même
  (Vercel, prévisualisation par branche), explicitement hors périmètre de cette nuit
  (`amoa/09-recette-babana-dev.md` porte cette suite, pas encore lancée). Le mentionner ici plutôt
  que de laisser L6-18 se refermer sur un compte-rendu qui ne cite que les critères satisfaits.

**Donc : L6-18 n'est pas encore totalement close.** Les trois pièces manquantes nommées par le
prompt de cette nuit le sont ; le déploiement qui rendrait les critères 6 et 7 vérifiables reste à
faire, comme prévu, par la suite déjà écrite dans `amoa/09-recette-babana-dev.md`.

---

## Ce qui laisse un doute pour quelqu'un de réel

**Le flux OAuth web n'a jamais été vu depuis un compte Google autre que celui utilisé ce soir, ni
depuis un navigateur avec des cookies tiers désactivés ou un profil sans FedCM.** Le recouvrement
avec le vrai bouton Google a fonctionné du premier coup ici — je n'ai aucune preuve de son
comportement si Google décide de proposer le One Tap silencieux plutôt que d'attendre un clic sur
le bouton rendu, ou si un navigateur bloque l'iframe de compte. La spécification ne demande rien
de plus que « obtenir un ID token » ; ce recouvrement est mon choix d'implémentation, pas une
exigence — et c'est la pièce la moins éprouvée des trois, faute d'un second compte ou d'un second
navigateur à essayer ce soir.

**`GOOGLE_JWKS_URL` à source unique (§6) n'est pas qu'une gêne de vérification** : si le pilote
doit un jour montrer une vraie connexion web ET des chauffeurs simulés dans le même environnement
(exactement le scénario d'une démonstration client), l'architecture actuelle ne le permet pas
sans un second Odoo. Je ne l'ai pas résolu — je l'ai contourné pour ce soir et documenté comme un
point à trancher avant que quelqu'un d'autre ne le découvre en salle de démonstration.

**Le point de départ réel affiché (une coordonnée européenne) restera tant que ce poste de
vérification n'a pas de vrai GPS Douala** — sans conséquence pour le code, mais à garder en tête
pour la prochaine vérification navigateur : ne pas confondre un artefact de géolocalisation de la
machine avec un défaut du fournisseur de carte.
