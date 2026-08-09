# L7 — Notifications

CDC §III.4 et §IV.1. Firebase Cloud Messaging.

**Règle transverse du lot** : une notification n'est jamais un canal unique. Tout état notifié doit être relisible depuis le serveur à l'ouverture de l'app.

---

## L7-01 — Intégration Firebase Cloud Messaging

### Objectif

Enregistrer et maintenir les jetons d'appareil.

### Fichiers

```
services/odoo/addons/babana/models/babana_device_token.py
services/odoo/addons/babana/services/push.py
packages/api-client/src/push/
services/odoo/addons/babana/tests/test_push.py
```

### Spécification

Modèle `babana.device.token` : utilisateur, jeton, plateforme, date d'enregistrement, date de dernier usage, actif.

Enregistrement à la connexion et à chaque rotation du jeton par Firebase. Un même utilisateur peut avoir plusieurs appareils — ne pas écraser, ajouter.

**Nettoyage des jetons invalides** : Firebase signale les jetons révoqués dans sa réponse. Les désactiver immédiatement. Sans ce nettoyage, la table grossit indéfiniment et le taux d'échec d'envoi devient ininterprétable.

`services/push.py` est une abstraction avec deux implémentations : Firebase réel, et une implémentation de développement qui écrit la notification dans les journaux. Aucun compte Firebase requis pour développer.

Envoi asynchrone : un envoi lent ne doit jamais ralentir une transition de course. La notification est déclenchée après validation de la transaction, jamais à l'intérieur.

### Critères d'acceptation

1. Plusieurs appareils par utilisateur sont supportés.
2. Un jeton signalé invalide est désactivé automatiquement.
3. L'envoi est asynchrone et ne bloque aucune transition.
4. L'implémentation de développement permet un parcours complet sans Firebase.
5. Un échec d'envoi ne fait échouer aucune transaction métier.

---

## L7-02 — Notifications de course

### Objectif

Informer le client aux moments clés (CDC §III.4).

### Fichiers

```
services/odoo/addons/babana/models/babana_ride_notifications.py
services/odoo/addons/babana/data/notification_templates.xml
services/odoo/addons/babana/tests/test_ride_notifications.py
```

### Spécification

| Événement | Destinataire | Contenu |
|---|---|---|
| Chauffeur affecté | Client | Prénom, gamme, immatriculation, ETA |
| Chauffeur arrivé au point de départ | Client | Le chauffeur vous attend |
| Course démarrée | Client | Destination et durée estimée |
| Course terminée | Client | Distance, montant à régler |
| Course annulée par le chauffeur | Client | Motif, invitation à resélectionner |

Les libellés sont dans des modèles traduisibles, pas en dur dans le code.

Chaque notification porte une donnée de routage qui ouvre l'app **sur l'écran concerné**. Une notification qui ouvre l'accueil oblige l'utilisateur à retrouver son chemin.

Aucune notification ne contient de donnée sensible dans son texte visible sur écran verrouillé : ni nom complet, ni adresse précise, ni montant du solde. L'écran verrouillé est lisible par un tiers.

### Critères d'acceptation

1. Chaque événement du tableau déclenche sa notification.
2. Les libellés sont dans des modèles traduisibles.
3. Le routage ouvre le bon écran.
4. Aucune donnée sensible n'apparaît sur écran verrouillé — revue explicite des textes.
5. Une notification non reçue ne bloque aucun parcours (L7-06).

---

## L7-03 — Notification de validation de dossier

### Objectif

Informer le chauffeur de l'acceptation ou du rejet (CDC §IV.1).

### Fichiers

```
services/odoo/addons/babana/models/babana_driver.py
services/odoo/addons/babana/tests/test_driver_notifications.py
```

### Spécification

Trois cas : dossier approuvé, dossier rejeté avec motif, document rejeté individuellement.

Le rejet indique **quel document** et **pourquoi**. Un rejet sans motif renvoie le chauffeur au support, ce qui coûte plus cher que la notification.

Le routage ouvre l'écran de suivi de dossier (L6-15) sur le document concerné.

La suspension notifie également, avec son motif.

### Critères d'acceptation

1. Les trois cas déclenchent une notification.
2. Le rejet nomme le document et le motif.
3. Le routage ouvre le bon document.
4. La suspension notifie avec motif.

---

## L7-04 — Notification de proposition au chauffeur

### Objectif

Atteindre le chauffeur même app fermée.

### Contexte

C'est la notification la plus critique du système : une proposition manquée est une course perdue et un délai d'attente pour le client.

### Fichiers

```
services/realtime/src/proposal/notify.ts
apps/driver/src/push/handlers.ts
```

### Spécification

Notification de **haute priorité**, envoyée en parallèle du message WebSocket — jamais à sa place. Si le chauffeur est connecté, le WebSocket arrive en premier et l'app ignore la notification redondante, dédupliquée par l'identifiant de proposition.

Contenu minimal : une course est proposée, avec le temps restant. Le détail vient de l'app une fois ouverte : une notification peut arriver après l'expiration, et afficher un montant pour une course déjà attribuée serait trompeur.

L'ouverture affiche l'écran de proposition (L6-12), qui **revalide auprès du serveur** que la proposition est toujours active avant d'afficher les boutons.

Le délai entre l'émission de la proposition et l'affichage doit être mesuré : c'est lui qui détermine si le délai d'acceptation de 30 secondes est réaliste.

### Critères d'acceptation

1. La notification part en parallèle du WebSocket, pas à sa place.
2. La déduplication empêche un double affichage.
3. Une notification ouverte après expiration affiche un message clair, pas les boutons.
4. Le délai d'acheminement est mesuré et exposé en métrique.

---

## L7-05 — Alerte de plafond d'encaisse

### Objectif

Prévenir le chauffeur avant qu'il soit bloqué.

### Fichiers

```
services/odoo/addons/babana/models/babana_driver.py
services/odoo/addons/babana/tests/test_cash_notifications.py
```

### Spécification

Deux notifications : approche du seuil configuré, et franchissement du plafond avec passage hors ligne.

L'alerte d'approche doit laisser une marge suffisante pour organiser une remise — un chauffeur prévenu au dernier moment perd des heures de travail.

La notification ne contient **pas** le montant du solde : elle indique qu'une remise est nécessaire. Un montant sur écran verrouillé indique à un tiers combien d'espèces le chauffeur transporte.

Le routage ouvre l'écran de recette (L5-07).

Une seule alerte d'approche par franchissement de seuil, pas à chaque course : une notification répétitive sera désactivée par le chauffeur, et il perdra aussi les propositions.

### Critères d'acceptation

1. L'alerte d'approche est envoyée une seule fois par franchissement.
2. La notification ne contient aucun montant.
3. Le blocage produit une notification distincte.
4. Le routage ouvre l'écran de recette.

---

## L7-06 — Aucune notification n'est un canal unique

### Objectif

Garantir qu'une notification perdue ne laisse personne bloqué.

### Contexte

Exigence transverse. Les notifications se perdent : appareil éteint, économiseur de batterie agressif fréquent sur les terminaux d'entrée de gamme, réseau coupé, autorisation refusée.

### Fichiers

```
apps/client/src/state/resync.ts
apps/driver/src/state/resync.ts
services/odoo/addons/babana/controllers/state.py
test/e2e/no-push.test.ts
```

### Spécification

Endpoint de récupération d'état : pour l'utilisateur authentifié, l'état courant complet — course en cours et son état, proposition active, solde, statut de dossier.

Appelé à chaque ouverture de l'app, à chaque retour au premier plan, et à chaque reconnexion WebSocket.

**Test de bout en bout avec les notifications entièrement désactivées** : le parcours complet doit rester réalisable. C'est le seul moyen de prouver l'exigence.

Si l'autorisation de notification est refusée, l'app reste utilisable et le signale, sans écran bloquant.

Pour le chauffeur, l'écran d'accueil affiche une proposition active retrouvée à l'ouverture, même si aucune notification n'a été reçue.

### Critères d'acceptation

1. L'endpoint renvoie l'état complet pour l'utilisateur.
2. Il est appelé à l'ouverture, au retour au premier plan et à la reconnexion.
3. **Le parcours complet est réalisable notifications désactivées** — test de bout en bout.
4. Le refus d'autorisation ne bloque aucun écran.
5. Une proposition active est retrouvée à l'ouverture sans notification.
