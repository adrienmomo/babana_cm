# Mise en place du poste de développement

Complète `05-prerequis-et-simulation.md` §4 bis, qui dit **quoi** installer. Ce document dit **comment**.

Rédigé pour macOS avec Homebrew, l'environnement observé pendant la nuit du 9 août. Comptez une trentaine de minutes, dont l'essentiel en téléchargement.

---

## 1. Node 22.11 ou plus

React Native 0.86 l'exige (`engines` du paquet). Node 20 a suffi jusqu'ici pour Metro, TypeScript et les tests, mais rien ne garantit qu'un build natif passe.

**Par nvm, pas par Homebrew.** Un Node installé globalement casse les autres projets de la machine le jour où l'un d'eux exige une version différente. nvm isole par projet.

```bash
brew install nvm
mkdir -p ~/.nvm
```

Ajouter à `~/.zshrc` :

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$(brew --prefix)/opt/nvm/nvm.sh" ] && . "$(brew --prefix)/opt/nvm/nvm.sh"
```

Puis, dans un nouveau terminal :

```bash
nvm install 22
nvm alias default 22
node -v          # doit afficher v22.x, avec x >= 11
```

**Épingler la version dans le dépôt.** Depuis `babana.cm/code/` :

```bash
node -v | sed 's/^v//' > .nvmrc
```

`nvm use` dans `code/` sélectionnera désormais la bonne version automatiquement. C'est ce qui évite qu'un futur contributeur revive le même problème.

**Après la mise à niveau, reconstruire l'arbre de dépendances.** Certains paquets compilent du natif contre la version de Node présente à l'installation :

```bash
cd code
rm -rf node_modules
npm install
npm test
```

Si `npm test` passe encore, la mise à niveau est propre.

---

## 2. JDK 17

React Native 0.86 exige Java 17. Ni plus ancien, ni forcément plus récent — Gradle est sensible à cette version.

```bash
brew install openjdk@17
sudo ln -sfn "$(brew --prefix)/opt/openjdk@17/libexec/openjdk.jdk" \
  /Library/Java/JavaVirtualMachines/openjdk-17.jdk
```

Ajouter à `~/.zshrc` :

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
```

Vérifier : `java -version` doit annoncer 17.

---

## 3. SDK Android, ligne de commande

Android Studio complet n'est pas nécessaire — plusieurs gigaoctets pour une interface que vous n'ouvrirez pas.

```bash
brew install --cask android-commandlinetools
```

Ajouter à `~/.zshrc` :

```bash
export ANDROID_HOME="$(brew --prefix)/share/android-commandlinetools"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

Dans un nouveau terminal, accepter les licences puis installer le socle :

```bash
sdkmanager --licenses          # répondre y à chaque invite
sdkmanager "platform-tools" "build-tools;36.0.0" "platforms;android-36"
```

**Sur les numéros de version** : `36` correspond aux gabarits de React Native 0.86. Plutôt que de deviner, vérifiez ce que le projet demande réellement :

```bash
grep -rE "compileSdk|buildToolsVersion|targetSdk" code/apps/*/android/build.gradle
```

Installez exactement ces versions. Gradle sait aussi télécharger ce qui manque une fois les licences acceptées — s'il se plaint d'un composant absent, `sdkmanager` le fournira.

---

## 4. Vérification avant de lancer la nuit

Dans un terminal neuf, depuis `babana.cm/` :

```bash
node -v                              # v22.11.0 ou plus
java -version 2>&1 | head -1         # 17.x
echo $ANDROID_HOME                   # non vide
sdkmanager --list_installed | head   # platform-tools, build-tools, platforms

cd code
npm install
npm test                             # doit rester vert après la montée de version
cd apps/client/android && ./gradlew assembleRelease
```

Le dernier point est le vrai test : c'est le critère d'acceptation 4 de L0-03, invérifiable hier. Il produit un APK sous `apps/client/android/app/build/outputs/apk/release/`. Répétez pour `apps/driver`.

**Le premier `assembleRelease` est long** — Gradle télécharge sa distribution et ses dépendances. Plusieurs minutes, une seule fois.

---

## 5. Si ça coince

**`SDK location not found`** — `ANDROID_HOME` n'est pas visible du shell qui lance Gradle. Ouvrir un nouveau terminal, ou créer `code/apps/client/android/local.properties` avec `sdk.dir=/chemin/vers/le/sdk`. Ce fichier est local à la machine et ne doit pas être committé.

**`Unsupported class file major version`** — mauvaise version de Java. Vérifier `JAVA_HOME`, pas seulement `java -version` : Gradle lit la variable.

**`Failed to install the following SDK components`** — licences non acceptées. Relancer `sdkmanager --licenses`.

**`EBADENGINE` persistant après la mise à niveau** — le `node_modules` a été construit avec l'ancienne version. `rm -rf node_modules && npm install`.

---

## 6. L'intégration continue a les mêmes besoins

L0-05 construit un APK en release à chaque commit. L'agent d'intégration continue doit donc disposer du même outillage — sinon la chaîne échouera à l'étape de build alors que tout fonctionne en local.

Sur GitHub Actions, trois actions suffisent : `actions/setup-node` en version 22, `actions/setup-java` en 17 avec la distribution `temurin`, et `android-actions/setup-android`. À prévoir au moment d'écrire la chaîne, pas après l'avoir vue échouer.

---

## Ce que ça débloque

| Tâche | État actuel | Après installation |
|---|---|---|
| L0-03 | Partielle — critère 4 invérifiable | Clôturable |
| L0-05 | Non commencée, bloquée | Faisable |
| L0-09 | Dépend de L0-05 | Faisable |
| L10-07 | Publication Play Store | Débloquée pour plus tard |

Ces trois premières referment le jalon J1.
