# Contrats préalables — C-01 à C-03

Ces trois tâches ne produisent pas de fonctionnalité. Elles produisent les artefacts sans lesquels backend, temps réel et mobile ne peuvent pas avancer en parallèle sans produire du travail à jeter.

**Elles passent avant tout code, y compris avant le socle technique.** C-03 en particulier n'a aucune dépendance : c'est de la conception, faisable immédiatement.

---

## C-03 — Machine à états de la course

*À faire en premier. Bloque tout le domaine.*

### Objectif

Produire la table de transitions exhaustive de `babana.ride`, qui servira de référence à L4-02 et à tous les endpoints du cycle de vie.

### Contexte

`01-architecture.md` §6 : les transitions sont les **seules portes d'écriture** sur la course. Toute écriture directe de champ contournant une transition est un bug de conception.

Décisions contraignantes : D10 (le client choisit son chauffeur, d'où l'état `proposée`), D11 (le refus ramène à la sélection sans créer de nouvelle course), D9 (paiement espèces uniquement en v1).

### Fichiers

`docs/contracts/ride-state-machine.md`

### Spécification

États : `draft`, `requested`, `proposed`, `assigned`, `in_progress`, `completed`, `settled`, `cancelled`, `rejected`.

Pour **chaque** transition, documenter :

| Colonne | Contenu |
|---|---|
| Depuis / Vers | États source et cible |
| Déclencheur | Action ou événement |
| Acteur | Client, chauffeur, système, superviseur |
| Préconditions | Ce qui doit être vrai avant |
| Effets | Écritures, appels sortants, notifications |
| Irréversible | Oui ou non |

Transitions à couvrir au minimum :

- `draft → requested` — le client valide l'estimation
- `requested → proposed` — le client sélectionne un chauffeur ; réservation atomique côté temps réel (L3-06)
- `proposed → assigned` — le chauffeur accepte
- `proposed → rejected` — le chauffeur refuse ou le délai expire
- `rejected → proposed` — le client sélectionne un autre chauffeur, **sur la même course** (D11)
- `assigned → in_progress` — le chauffeur démarre la course
- `in_progress → completed` — le chauffeur termine ; consolidation distance, durée, montant
- `completed → settled` — encaissement confirmé
- `requested → cancelled`, `proposed → cancelled`, `assigned → cancelled` — annulations, règles distinctes selon l'état

Documenter également la **liste des transitions interdites** et la raison de chacune. Notamment : rien ne sort de `settled` ; `completed` ne revient jamais à `in_progress` ; une course ne passe jamais de `requested` à `assigned` sans passer par `proposed`.

Préciser pour chaque état **quels champs deviennent immuables**. Après `completed`, la distance et le montant ne changent plus. Après `settled`, plus rien ne change.

### Critères d'acceptation

1. Chaque état de la liste apparaît au moins une fois en source et une fois en cible, sauf `draft` (jamais cible) et `settled` (jamais source).
2. L'historique des refus est explicitement porté par la course, pas par une nouvelle course à chaque refus.
3. Les quatre moments d'écriture Odoo de la règle de partition sont identifiables dans la colonne Effets, et il n'y en a pas un cinquième.
4. Un développeur qui lit ce document peut implémenter L4-02 sans poser de question.

### Piège

La tentation sera de simplifier en supprimant `proposed` et en passant directement de `requested` à `assigned`. Ne pas le faire : c'est cet état qui rend le refus traçable et qui matérialise la réservation atomique de L3-06. Sans lui, un chauffeur peut être « réservé » sans qu'aucune donnée ne l'atteste.

---

## C-01 — Contrat d'API mobile ↔ Odoo

### Objectif

Spécifier les endpoints REST critiques, sous forme de types TypeScript et de schémas de validation dans `@babana/contracts`, plus une documentation lisible.

### Contexte

`01-architecture.md` §5 : les chemins critiques passent par des contrôleurs explicites ; les lectures secondaires (historique, factures, profil) passent en JSON-RPC natif et **ne sont pas dans ce contrat**.

D17 : le contrat est du code, pas un document que quelqu'un oublie de mettre à jour.

### Fichiers

```
packages/contracts/src/http/
├── auth.ts
├── quote.ts
├── ride.ts
├── settlement.ts
├── remittance.ts
├── errors.ts
└── index.ts
docs/contracts/http-api.md        # généré ou rédigé, lisible
```

### Spécification

Préfixe commun `/api/v1`. Authentification par jeton applicatif en en-tête `Authorization: Bearer`, sauf sur `/auth/google`.

Endpoints à spécifier :

| Méthode | Chemin | Rôle |
|---|---|---|
| POST | `/auth/google` | Échange d'un ID token Google contre un jeton applicatif |
| POST | `/auth/refresh` | Renouvellement |
| POST | `/auth/logout` | Révocation |
| POST | `/quote` | Estimation : départ, arrivée, promo éventuelle → montant, distance, ETA |
| POST | `/rides` | Création d'une demande à partir d'une estimation |
| POST | `/rides/{id}/select-driver` | Sélection d'un chauffeur parmi les 5 proposés |
| POST | `/rides/{id}/accept` | Acceptation par le chauffeur |
| POST | `/rides/{id}/reject` | Refus par le chauffeur |
| POST | `/rides/{id}/start` | Démarrage |
| POST | `/rides/{id}/complete` | Fin, consolidation |
| POST | `/rides/{id}/settle` | Encaissement espèces |
| POST | `/rides/{id}/cancel` | Annulation |
| POST | `/rides/{id}/rate` | Notation par le client |
| GET | `/drivers/nearby` | Les 5 chauffeurs les plus proches (D14) |
| POST | `/drivers/me/availability` | Bascule en ligne / hors ligne |
| GET | `/drivers/me/cash` | Solde courant, plafond, encaissé du jour |
| POST | `/remittances` | Déclaration de remise par le chauffeur |
| POST | `/phone/verify/start` | Envoi de l'OTP de rattachement |
| POST | `/phone/verify/confirm` | Confirmation de l'OTP |

Pour chaque endpoint : schéma de requête, schéma de réponse, codes HTTP, erreurs possibles.

**Codes d'erreur** — un catalogue nommé, stable, indépendant du HTTP. Au minimum : `DRIVER_ALREADY_TAKEN`, `CASH_LIMIT_REACHED`, `RIDE_INVALID_TRANSITION`, `NO_DRIVER_AVAILABLE`, `QUOTE_EXPIRED`, `PHONE_ALREADY_VERIFIED`, `TOKEN_EXPIRED`, `DRIVER_NOT_APPROVED`.

**Versionnement** — le préfixe `/v1` est figé. Toute rupture de compatibilité crée `/v2`, elle ne modifie pas `/v1`. Documenter cette règle explicitement : une app installée sur le téléphone d'un chauffeur ne se met pas à jour à la demande.

**Durée de validité de l'estimation** — une estimation a une date d'expiration. Passée cette date, `/rides` la refuse avec `QUOTE_EXPIRED`. Sinon un client peut faire estimer à 6h du matin et commander à 18h au tarif creux.

### Critères d'acceptation

1. `@babana/contracts` compile et exporte un type et un schéma de validation par requête et par réponse.
2. Des schémas JSON sont générés dans `packages/contracts/dist/json-schema/`, consommables par les contrôleurs Odoo en Python.
3. Chaque endpoint a au moins un exemple de requête et un exemple de réponse.
4. Le catalogue d'erreurs est exhaustif : aucun endpoint ne peut renvoyer une erreur non listée.

---

## C-02 — Contrat d'événements temps réel

### Objectif

Spécifier les messages WebSocket dans les deux sens, plus la politique de reconnexion et de rattrapage d'état.

### Contexte

D16 : le service temps réel est en TypeScript, donc ce contrat est importé à l'identique par les apps et par le serveur. Un message mal formé devient une erreur de compilation.

`01-architecture.md` §2 : tout ce qui transite ici est éphémère. Aucun message ne porte une décision métier définitive — la vérité reste dans Odoo.

### Fichiers

```
packages/contracts/src/realtime/
├── client-to-server.ts
├── server-to-client.ts
├── envelope.ts
└── index.ts
docs/contracts/realtime-events.md
```

### Spécification

**Enveloppe commune** : type du message, identifiant unique, horodatage d'émission. L'identifiant sert à l'idempotence côté réception — un message rejoué après reconnexion ne doit pas produire deux effets.

**Chauffeur vers serveur** : `position.update` (latitude, longitude, précision, vitesse, cap), `availability.set`, `proposal.accept`, `proposal.reject`, `ride.start`, `ride.complete`.

**Client vers serveur** : `nearby.subscribe` (position, rayon), `nearby.unsubscribe`, `ride.track` (abonnement au suivi d'une course).

**Serveur vers chauffeur** : `proposal.new` (course, départ, arrivée, montant, distance, délai restant), `proposal.expired`, `ride.cancelled`, `cash.limit.warning`.

**Serveur vers client** : `nearby.drivers` (les 5 plus proches, position arrondie), `ride.proposed`, `ride.assigned`, `ride.rejected`, `driver.position` (suivi), `ride.started`, `ride.completed`.

**Politique de reconnexion** — à spécifier précisément, c'est ce qui sera oublié sinon :

- Reconnexion avec temporisation croissante et gigue aléatoire, pour éviter que mille chauffeurs se reconnectent en même temps après une coupure réseau.
- À la reconnexion, le client envoie son dernier état connu ; le serveur répond par un message de resynchronisation complet plutôt que par un différentiel.
- Les actions émises hors connexion sont mises en file locale et rejouées à la reconnexion, dans l'ordre, avec leur identifiant d'origine pour que le serveur puisse les dédupliquer.
- Une position vieille de plus de N secondes est ignorée par le serveur, pas rejouée : rejouer une position obsolète est pire que la perdre.

**Précision des positions diffusées aux clients** — les positions envoyées dans `nearby.drivers` sont arrondies. Spécifier la précision retenue : assez fine pour que l'affichage soit crédible, assez grossière pour que la flotte ne soit pas cartographiable (C2b).

### Critères d'acceptation

1. Chaque message a un nom, un schéma de validation et **un émetteur unique** — aucun message n'est envoyable dans les deux sens.
2. La politique de reconnexion est écrite, y compris le comportement des messages en file d'attente.
3. Le schéma de `nearby.drivers` ne contient aucune donnée personnelle au-delà du prénom, de la photo, de la note et de la gamme de moto. Ni nom complet, ni téléphone, ni immatriculation.
4. Les paquets `apps/client`, `apps/driver` et `services/realtime` importent tous ce contrat ; aucun ne définit ses propres types de message.

### Piège

Le point 3 est facile à violer sans y penser, en renvoyant l'objet chauffeur complet parce que c'est plus simple. Le schéma doit décrire exactement les champs autorisés et la validation doit rejeter le surplus, pas seulement le champ manquant.
