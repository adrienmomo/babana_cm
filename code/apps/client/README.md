# Babana — app Client

React Native, Android et export web (D22). Voir `../../README.md` pour l'ensemble du dépôt.

## Lancer

```bash
make client          # bundler (port 8081)
make client-app      # bundler + installation sur l'émulateur
make client-web      # bundle web dans dist-web/ (servi par Caddy)
# émulateur : adb reverse des ports 8081, 8069, 3000, 4001 et 9000 (photos des chauffeurs)
```

## Ce que fait l'app

| Écran ou fonction | Où |
|---|---|
| Connexion par SMS | `screens/SignInScreen.tsx` |
| Accueil : position GPS comme départ, arrivée par la carte, la recherche ou les trajets habituels ; toucher Départ ou Arrivée amène la carte sur ce point ; motos disponibles dans 3 km | `screens/HomeScreen.tsx` |
| Devis et commande (prix fixé par le serveur) | `screens/QuoteScreen.tsx` |
| Attente : la course part au chauffeur disponible le plus proche | `screens/WaitingScreen.tsx` |
| Suivi : moto en direct, tracé du chauffeur, nom complet et photo, appel, messages, partage, urgence ; carte du trajet quand le chauffeur arrive | `screens/TrackingScreen.tsx` |
| Fin de course retrouvée au retour d'arrière-plan ou après une coupure | `screens/TrackingScreen.tsx` (`GET /rides/{id}/outcome`) |
| Suivi rouvert après une relance de l'app | `rideResume.ts` |
| Résumé, notation, facture, historique | `screens/` |
| Notifications push : chauffeur affecté, arrivé, course terminée | `push.ts`, `../../docs/firebase.md` |
| Thèmes : téléphone, clair, sombre, noir (« Mon compte ») | `appearance.tsx`, `@babana/ui` |
| Écran allumé tant qu'une carte est affichée | `keepAwake.ts` |

## Tests

```bash
npx jest            # depuis apps/client
npx tsc --noEmit -p .
npm run lint
```
