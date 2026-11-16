# Babana — code

Application de moto-taxi à Douala : une app **Client**, une app **Chauffeur** (« Babana Pro »),
un back-office **Odoo 18** et un **service temps réel** (WebSocket, Redis). Ce dossier est le
monorepo ; les décisions et spécifications vivent dans `../amoa/`, la méthode de travail dans
`../CLAUDE.md`.

## Arborescence

```
apps/client/        app Client (React Native, Android et export web)
apps/driver/        app Chauffeur (React Native, Android)
packages/contracts/ contrats HTTP et temps réel (zod) -- la source unique des types (D17)
packages/api-client client HTTP, temps réel, session, file hors connexion, push
packages/maps/      carte (OpenStreetMap / Google), recherche, itinéraires, thème de carte
packages/ui/        composants partagés et thèmes (clair, sombre, noir)
packages/navigation garde d'authentification, identifiants typés
services/odoo/      module Odoo `babana` : courses, tarifs, chauffeurs, caisse, back-office
services/realtime/  service temps réel : positions, vivier, propositions, suivi
services/mocks/     services tiers simulés (Google, cartes) -- tout tourne sans compte (D19)
infra/              docker compose, Caddy, serveur de développement, production
test/               concurrence, contrat HTTP, bout en bout, résilience
docs/               documentation technique (contrats, pièges Odoo, Firebase, exploitation)
```

## Démarrer

```bash
make up            # toute l'infrastructure (Odoo, temps réel, PostgreSQL, Redis, MinIO…)
make seed          # données de démonstration (chauffeurs, courses, photos, soldes)
make client-app    # app Client sur un émulateur Android
make driver-app    # app Chauffeur sur un émulateur Android
make test          # toutes les suites (Odoo, paquets, apps, concurrence, résilience)
make lint && make typecheck
```

Comptes de démonstration : client `+237699450102`, chauffeur `+237690110201`, code OTP `000000`
en développement.

### Émulateurs Android

Les émulateurs ne joignent pas `api.localhost` : lancer les bundlers avec
`BABANA_API_URL=http://10.0.2.2:8069 BABANA_REALTIME_WS_URL=ws://10.0.2.2:3000/rt/ws`, puis
`adb reverse` des ports 8069, 3000, 4001 et 9000 (photos signées MinIO). La position se simule
par les fournisseurs de test (`cmd location providers set-test-provider-location …`).

### Notifications push

`make firebase-config` génère la configuration Firebase des deux apps (jamais versionnée) ; le
serveur se configure dans `infra/env/.env`. Détail : `docs/firebase.md`.

## Ce que fait l'app (15 novembre 2026)

- **Client** : position GPS comme départ, recherche ou carte pour l'arrivée ; tarif fixé par le
  serveur ; la course part au chauffeur disponible le plus proche ; suivi en direct (moto qui
  glisse, tracé du chauffeur, « Sur place », carte du trajet à l'arrivée du chauffeur) ; nom
  complet et photo du chauffeur ; résumé, notation, facture ; reprise du suivi après une relance
  ou un retour d'arrière-plan ; notifications push (chauffeur affecté, arrivé, course terminée) ;
  thèmes clair, sombre, noir.
- **Chauffeur** : inscription avec permis, pièce d'identité et photo de profil ; en ligne avec
  service de premier plan (propositions reçues app fermée, positions toutes les 3 à 15 s),
  sonnerie en boucle d'une proposition, icône flottante app en arrière-plan ; déroulé de course sur
  la carte ; encaissement, caisse, remises ; selfie de contrôle toutes les 24 h ; solde prépayé
  (recharge à l'agence, commission par course) ; un seul téléphone connecté par compte ; thèmes.
- **Back-office (Odoo)** : dossiers chauffeurs et pièces, selfies à vérifier, recharges du solde,
  courses, caisse et remises, tarifs et zones, journal d'audit.

Les règles qui gouvernent tout ceci sont les décisions numérotées de
`../amoa/01-architecture.md` ; les ajouts du 15 novembre sont décrits, avec leurs propositions de
décision, dans `../amoa/rapport-2026-11-15.md`.
