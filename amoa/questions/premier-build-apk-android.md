# Écart — le premier vrai build APK Android (les deux apps) n'avait jamais été tenté (7-8 septembre 2026)

Hors du protocole habituel de nuit numérotée : demande directe pour connecter un téléphone Android
physique (Samsung SM-J510FN, Android 7.1.1, API 25, armeabi-v7a), construire l'APK Chauffeur en
release pointé sur `https://api.babana.dev` (recette), et l'installer. Consigné ici plutôt que
seulement dans un message de session parce que les défauts trouvés touchent les deux apps mobiles
et ne se reverront pas tant que personne ne relance un vrai build Android.

## Constaté

Aucune des deux apps (Client, Chauffeur) n'avait jamais été construite en APK Android réel depuis
le début du projet — uniquement testées par Jest, et côté Client, exportées et vérifiées en web
(D38, L6-18). `D38` dit déjà « un artefact qui se construit n'est pas un artefact qui fonctionne » ;
ici, l'artefact n'avait même jamais atteint l'étape « se construit » côté Android natif.

Cinq défauts indépendants ont bloqué la construction ou l'exécution, un par un, chacun révélé
seulement une fois le précédent corrigé :

1. **`react-native-push-notification` (8.1.1, Chauffeur seulement) appelle `jcenter()`** dans son
   `android/build.gradle` (bloc `buildscript` ET bloc `allprojects`) — JCenter est fermé depuis 2022
   et la méthode a été retirée de `RepositoryHandler` dans les versions récentes de Gradle.
   *Corrigé* dans `apps/driver/android/build.gradle` : un `allprojects { beforeEvaluate { ... } }`
   pose une méthode `jcenter()` de secours (redirige vers `mavenCentral()`) sur les deux
   `RepositoryHandler` du sous-projet, avant que son propre script ne soit évalué.

2. **Classes dupliquées au dexing** : ce même paquet dépend encore de
   `com.android.support:support-compat` (l'ancienne Android Support Library, jamais migrée), qui
   entre en conflit avec `androidx.core`, tiré par tout le reste du projet. *Corrigé* :
   `android.enableJetifier=true` dans `apps/driver/android/gradle.properties` (Jetifier réécrit les
   classes de l'ancienne bibliothèque en leur équivalent AndroidX à la volée).

3. **`AndroidManifest.xml` référence `${usesCleartextTraffic}`, posé nulle part** — dans les DEUX
   apps (Client et Chauffeur), depuis toujours. Sans valeur, `ManifestMerger2` ne peut même pas
   parser le manifeste. *Corrigé* dans les deux `app/build.gradle` : dérivé de `BABANA_API_URL`
   plutôt que codé en dur (invariant 5) — `true` seulement si l'adresse commence par `http://`
   (développement local), `false` sinon (recette, production — jamais de repli permissif).

4. **Les commentaires XML des deux manifestes contiennent des doubles-tirets (`--`)** — convention
   typographique déjà utilisée partout ailleurs dans ce dépôt (Python, TypeScript, Markdown) comme
   substitut ASCII d'un tiret cadratin, mais **interdite par la spécification XML** dans un
   commentaire, n'importe où (pas seulement en fin). Un vrai parseur XML (celui du manifest merger
   Android) refuse le fichier entier. *Corrigé* : remplacés par le caractère `—` (tiret cadratin
   Unicode) dans les deux `AndroidManifest.xml`.

5. **Deux modules natifs jamais déclarés là où l'autolinking les cherche.**
   `@react-native-google-signin/google-signin` et `react-native-keychain` sont des dépendances de
   `packages/api-client` (le code partagé qui fait l'authentification), jamais des deux apps qui
   les utilisent réellement au runtime natif. L'autolinking React Native (Gradle) ne suit que les
   dépendances déclarées directement dans le `package.json` de l'app — jamais transitivement à
   travers un paquet interne du monorepo. Conséquence en deux temps :
   - `@react-native-google-signin/google-signin` n'était même pas hoisté à la racine de
     `node_modules` (installé seulement dans `packages/api-client/node_modules`, jamais résolu par
     `npm install` pour le reste du monorepo faute d'être déclaré ailleurs) : Metro résolvait quand
     même le module JS (il suit toute l'arborescence), mais aucun code natif Android n'était
     compilé ni lié — crash immédiat au premier écran (`TurboModuleRegistry.getEnforcing(...):
     'RNGoogleSignin' could not be found`).
   - `react-native-keychain`, lui, était bien hoisté à la racine mais pas davantage autolinké,
     bloquant silencieusement `authClient.restore()` (l'app restait figée sur l'écran de
     chargement de session, sans erreur visible).

   *Corrigé* : les deux paquets ajoutés comme dépendances directes de `apps/driver/package.json`
   ET `apps/client/package.json` (même version que `packages/api-client/package.json`), suivi d'un
   `npm install` à la racine pour hoister et régénérer `package-lock.json`.

## Vérifié, dans cet ordre, sur le vrai téléphone

`./gradlew assembleRelease` (Chauffeur) → succès. `adb install -r` → succès. Lancement → aucun
crash, écran de connexion rendu (« Se connecter avec Google », vrai bouton). Appui sur le bouton →
le **vrai** flux natif Google Sign-In se déclenche (`SignInActivity`, puis le sélecteur de compte
système `AccountPickerActivity`), sans `DEVELOPER_ERROR` — ce qui aurait été immédiat et visible
dans les journaux si le SHA-1 du certificat de debug ou l'identifiant client OAuth Android
n'avaient pas été reconnus côté Google Cloud Console.

## Pas vérifié, à savoir avant de compter ceci comme complet

- **Aucune connexion Google menée à son terme** : le sélecteur de compte s'est ouvert, aucun compte
  n'a été choisi (pas de compte de test disponible sur ce téléphone dans cette session). Le flux
  natif fonctionne jusqu'à ce point précis ; la suite (jeton reçu, vérifié côté serveur, session
  ouverte) reste à observer.
- **L'app Client n'a jamais été construite en APK réel non plus.** Les défauts 3, 4 et 5
  s'appliquaient identiquement aux deux apps et ont été corrigés dans les deux par cohérence
  (même cause, même correctif), mais **seul le Chauffeur a été réellement compilé et exécuté** ce
  soir. Un premier build du Client vérifierait que les mêmes correctifs suffisent aussi de son
  côté — pas garanti tant que ce n'est pas fait (ex. le défaut 1, spécifique à
  `react-native-push-notification`, n'existe que côté Chauffeur ; le Client pourrait porter un
  défaut différent, propre à ses propres dépendances natives, jamais rencontré).
- **Aucun scénario métier réel exercé** (GPS, proposition de course, encaissement) sur ce
  téléphone — seul l'écran de connexion a été atteint.

## Proposition

Le prochain lot qui touche `apps/client/android` ou `apps/driver/android` devrait commencer par un
build réel des deux apps (pas seulement celle qu'il modifie), précisément parce que ces cinq
défauts n'ont jamais été détectés avant faute d'avoir jamais été cherchés à cet endroit — la
définition de fini (`CLAUDE.md`, point 9 : « une tâche qui produit un écran n'est finie que si
quelqu'un l'a ouvert ») s'est appliquée jusqu'ici à l'export web du Client et aux vues back-office,
jamais à un APK Android natif.
