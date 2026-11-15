# Babana Pro — app Chauffeur

React Native, Android. Voir `../../README.md` pour l'ensemble du dépôt.

## Lancer

```bash
make driver          # bundler (port 8083)
make driver-app      # bundler + installation sur l'émulateur
# émulateur : adb reverse tcp:8081 tcp:8083, puis 8069, 3000, 4001
```

Une construction native est nécessaire après un changement de dépendance native :
`ANDROID_SERIAL=emulator-5554 ./gradlew installDebug -PreactNativeDevServerPort=8083` dans
`android/`.

## Ce que fait l'app

| Écran ou fonction | Où |
|---|---|
| Connexion par SMS, un seul téléphone par compte (« Votre compte a été connecté sur un autre téléphone ») | `screens/SignInScreen.tsx`, `sessionReplaced.ts` |
| Inscription : profil, permis, pièce d'identité, photo de profil (appareil photo) | `screens/onboarding/` |
| Carte, interrupteur en ligne / hors ligne, recette du jour, solde prépayé | `screens/HomeScreen.tsx`, `components/AvailabilityToggle.tsx` |
| Selfie de contrôle demandé au passage en ligne | `selfie.ts` |
| En ligne app fermée : service de premier plan, positions, propositions | `onlineTask.ts`, `location/`, `proposalWatch.ts` |
| Proposition : sonnerie en boucle (volume alarme), retour au premier plan | `proposalAlert.ts`, `ringtone.ts`, `floatingBubble.ts` |
| Icône flottante app en arrière-plan | `floatingBubble.ts`, `android/.../bubble/` |
| Course sur la carte : approche, « Sur place », trajet, fin | `rideFlow/` |
| Encaissement, caisse, remises, historique | `screens/` |
| Notifications push (Firebase) | `push/firebase.ts`, `../../docs/firebase.md` |
| Thèmes : téléphone, clair, sombre, noir (« Mon compte ») | `theme.ts`, `appearance.tsx` |

## Fichiers à fournir

- `android/app/src/main/res/raw/proposal_ringtone.mp3` : la sonnerie des propositions (un son
  provisoire est en place).
- `android/app/google-services.json` : `make firebase-config` (jamais versionné).

## Tests

```bash
npx jest            # depuis apps/driver
npx tsc --noEmit -p .
npm run lint
```
