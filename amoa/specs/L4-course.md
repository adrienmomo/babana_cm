# L4 — Boucle de course

Le cœur du domaine. Dépend de C-03, qui doit être terminé avant toute ligne de code de ce lot.

---

## L4-01 — Modèle `babana.ride`

### Objectif

La course, avec ses contraintes d'intégrité.

### Fichiers

```
services/odoo/addons/babana/models/babana_ride.py
services/odoo/addons/babana/security/ir.model.access.csv
services/odoo/addons/babana/tests/test_ride_model.py
```

### Spécification

Champs principaux :

| Groupe | Champs |
|---|---|
| Identité | référence lisible générée par séquence, `state` |
| Parties | client, chauffeur, moto |
| Géographie | latitude et longitude de départ et d'arrivée, libellés, zone de départ, zone d'arrivée |
| Estimation | estimation référencée, montant estimé, distance de référence, durée estimée corrigée |
| Réalisé | distance parcourue, durée écoulée, tracé, écart entre parcouru et référence |
| Tarif | règle appliquée figée, détail décomposé, montant final, promotion, remise |
| Paiement | moyen (`cash` en v1), facture, horodatage d'encaissement |
| Cycle | horodatages de chaque transition, motif d'annulation, auteur de l'annulation |
| Refus | liste des refus sur cette course, avec chauffeur, motif et horodatage |
| Notation | note, commentaire |

**La règle tarifaire est figée sur la course**, pas seulement référencée. Une facture doit rester explicable après modification de la grille.

Index sur `state`, sur le chauffeur, sur le client, sur la date de création. Ce sont les axes de toutes les requêtes de L9.

Contraintes de base de données, pas seulement applicatives : un chauffeur ne peut avoir qu'une course dans un état actif — `proposed`, `assigned`, `in_progress`. Un client de même. C'est une garantie de dernier recours si une transition est contournée.

### Critères d'acceptation

1. La référence est générée par séquence et unique.
2. Un second enregistrement de course active pour le même chauffeur échoue au niveau base.
3. La règle tarifaire figée survit à la modification de la règle d'origine.
4. Les index existent et sont utilisés par les requêtes de L9.
5. Les refus sont portés par la course, pas par des courses distinctes.

---

## L4-02 — Machine à états

### Objectif

Implémenter C-03 : les transitions sont les **seules** portes d'écriture.

### Contexte

**La tâche la plus structurante du lot.** Si les transitions ne sont pas les seules portes d'écriture, l'invariant se perd et toutes les garanties de l'architecture tombent avec lui.

### Fichiers

```
services/odoo/addons/babana/models/babana_ride_state.py
services/odoo/addons/babana/tests/test_ride_state_machine.py
```

### Spécification

Une méthode par transition, nommée d'après l'action, pas d'après l'état cible : `action_request`, `action_propose`, `action_accept`, `action_reject`, `action_start`, `action_complete`, `action_settle`, `action_cancel`.

Chaque méthode, dans cet ordre :

1. Vérifie l'état source ; sinon `RIDE_INVALID_TRANSITION`
2. Vérifie les préconditions de C-03
3. Vérifie que l'acteur est autorisé pour cette transition
4. Applique les effets et écrit l'état
5. Journalise (L8-09)

**Verrouillage de l'enregistrement** pendant la transition, pour empêcher deux transitions concurrentes sur la même course. Deux appels simultanés à `action_accept` ne doivent pas produire deux affectations.

Surcharger `write` pour **interdire l'écriture directe de `state`** hors des méthodes de transition. C'est le point qui rend l'invariant réel plutôt que conventionnel.

Rendre immuables les champs figés selon l'état : après `completed`, distance et montant ne changent plus ; après `settled`, plus rien ne change. Interdit au niveau du modèle, y compris pour un administrateur.

Le champ `state` porte les transitions autorisées depuis l'état courant, exposé à l'app pour qu'elle n'affiche pas des actions impossibles.

### Critères d'acceptation

1. **Chaque** transition valide de C-03 a un test qui passe.
2. **Chaque** transition interdite de C-03 a un test qui échoue avec `RIDE_INVALID_TRANSITION`.
3. Une écriture directe de `state` par `write` échoue.
4. Deux `action_accept` concurrents ne produisent qu'une affectation.
5. Modifier le montant d'une course `completed` échoue.
6. Modifier quoi que ce soit sur une course `settled` échoue.
7. `rejected → proposed` conserve l'historique des refus.

### Piège

Surcharger `write` casse souvent les mécanismes internes d'Odoo, qui écrit lui-même des champs lors des calculs et des chargements de données. L'interdiction doit cibler `state` et les champs figés, en laissant passer le contexte d'appel des méthodes de transition. Un blocage trop large rendra le module ininstallable.

---

## L4-03 — Endpoints du cycle de vie

### Objectif

Exposer les transitions au mobile, selon C-01.

### Fichiers

```
services/odoo/addons/babana/controllers/ride.py
services/odoo/addons/babana/tests/test_ride_controller.py
```

### Spécification

Un endpoint par transition, conforme à C-01. Chacun :

- Valide la requête contre le schéma JSON généré depuis `@babana/contracts`
- Vérifie que l'appelant est bien partie à la course — le client pour les actions client, le chauffeur affecté pour les actions chauffeur
- Appelle la méthode de transition
- Renvoie l'état complet de la course

**Aucune règle métier dans le contrôleur.** Le contrôleur traduit HTTP en appel de méthode, rien de plus. Une condition métier écrite ici sera contournée par le back-office, qui appelle la méthode directement.

`POST /rides` référence une estimation (L2-04) plutôt que de recalculer. Estimation expirée : `QUOTE_EXPIRED`.

`POST /rides/{id}/select-driver` appelle le service temps réel pour la réservation atomique (L3-06) **avant** la transition Odoo. Réservation échouée : `DRIVER_ALREADY_TAKEN`, sans transition.

**Idempotence** : chaque endpoint accepte un identifiant d'idempotence fourni par le client. Un appel répété avec le même identifiant renvoie le résultat du premier sans réappliquer la transition. Indispensable avec un réseau intermittent — l'app rejouera (L3-11).

### Critères d'acceptation

1. Une requête non conforme au schéma est rejetée avant tout traitement.
2. Un client tentant une action sur la course d'un autre est rejeté.
3. Un chauffeur non affecté tentant `accept` est rejeté.
4. Une estimation expirée est refusée.
5. Une réservation échouée ne produit aucune transition.
6. Un appel rejoué avec le même identifiant d'idempotence renvoie le même résultat sans double effet.
7. Aucune condition métier n'est implémentée dans le contrôleur.

---

## L4-04 — Consolidation de fin de course

### Objectif

Figer distance, durée, tracé et montant définitif.

### Contexte

Une des écritures de la règle de partition (§2 de l'architecture).

### Fichiers

```
services/odoo/addons/babana/models/babana_ride.py
services/odoo/addons/babana/tests/test_ride_completion.py
```

### Spécification

À la transition `in_progress → completed`, le service temps réel fournit distance parcourue, durée écoulée et tracé (L3-10).

Odoo enregistre ces valeurs, **archive le tracé en une seule écriture**, et calcule l'écart entre distance parcourue et distance de référence.

**Le montant final est calculé sur la distance de référence** (L2-05), pas sur la distance parcourue. C'est la décision par défaut, à confirmer par L10-05 sur données de pilote. La raison : la distance de référence est reproductible et connue du client à l'avance ; la distance parcourue dépend des raccourcis du chauffeur et de la qualité du GPS.

Un écart au-delà d'un seuil configurable est **signalé**, pas corrigé automatiquement : il peut révéler un détour abusif, un problème GPS, ou une adresse mal saisie. Le back-office traite.

Le montant final peut différer du montant estimé si une promotion est devenue invalide entre-temps. Toute différence est explicitée dans le détail décomposé.

### Critères d'acceptation

1. Le tracé est écrit en une seule opération.
2. Le montant final est calculé sur la distance de référence.
3. Un écart au-delà du seuil produit un signalement sans bloquer la fin de course.
4. Distance et montant sont immuables après `completed`.
5. Toute différence entre estimé et final est explicitée dans le détail.

---

## L4-05 — Encaissement espèces

### Objectif

Enregistrer le paiement en espèces (D9).

### Fichiers

```
services/odoo/addons/babana/models/babana_ride.py
services/odoo/addons/babana/controllers/ride.py
services/odoo/addons/babana/tests/test_settlement.py
```

### Spécification

Le chauffeur confirme avoir reçu le montant. Transition `completed → settled`.

Effets, dans une transaction unique :

1. Horodatage d'encaissement, moyen `cash`
2. Incrément du compte courant du chauffeur (L5-01)
3. Génération de la facture (L4-06)
4. Contrôle du plafond d'encaisse (L5-02) : si atteint, le chauffeur passe hors ligne

Si un de ces effets échoue, **rien n'est appliqué**. Un encaissement sans incrément de compte courant est de l'argent qui disparaît des comptes.

Le montant encaissé est le montant final, sans saisie libre : un chauffeur ne saisit pas ce qu'il a reçu, il confirme ce qui est dû. Autoriser une saisie ouvrirait la sous-déclaration.

Un écart réel — le client n'a pas l'appoint — se traite en remise de caisse (L5-06), pas ici.

### Critères d'acceptation

1. L'encaissement incrémente le compte courant du montant exact.
2. L'échec d'un effet annule tous les autres.
3. Un double encaissement est impossible.
4. Le chauffeur ne peut pas saisir un montant différent.
5. Le passage au plafond met hors ligne dans la même transaction.

---

## L4-06 — Facture

### Objectif

Générer la facture Odoo (CDC §III.3).

### Fichiers

```
services/odoo/addons/babana/models/babana_ride_invoice.py
services/odoo/addons/babana/report/babana_invoice_template.xml
services/odoo/addons/babana/tests/test_invoice.py
```

### Spécification

Réutiliser `account.move`, pas un modèle maison : la numérotation légale, le PDF et l'envoi par email sont alors acquis.

À l'encaissement, créer la facture au nom du client, avec une ligne par composante du détail décomposé — prise en charge, distance, coefficient, remise. Une facture d'une seule ligne « course » est inexplicable en cas de contestation.

Le modèle de document mentionne : référence de course, date, départ, arrivée, distance, chauffeur, immatriculation, détail du calcul, total. En français.

Envoi par email à la demande du client (CDC §III.3), pas automatiquement — un email par course serait subi.

Le journal comptable et le compte de produit sont paramétrables, pas codés en dur.

### Critères d'acceptation

1. La facture est un `account.move` avec une numérotation légale.
2. Une ligne par composante du détail ; la somme des lignes égale le montant final.
3. Le PDF se génère et contient toutes les mentions listées.
4. L'envoi par email fonctionne, vérifié via Mailpit.
5. Le journal et le compte sont paramétrables.

---

## L4-07 — Annulations

### Objectif

Annuler une course, avec des règles distinctes selon l'état.

### Fichiers

```
services/odoo/addons/babana/models/babana_ride_cancel.py
services/odoo/addons/babana/tests/test_cancellation.py
```

### Spécification

| Depuis | Par | Effet |
|---|---|---|
| `requested` | Client | Annulation simple, aucun effet |
| `proposed` | Client | Libère la réservation (L3-06), le chauffeur réintègre le pool |
| `assigned` | Client | Libère le chauffeur ; motif enregistré ; comptabilisé |
| `assigned` | Chauffeur | Libère le chauffeur ; motif obligatoire ; comptabilisé sur le chauffeur |
| `in_progress` | Chauffeur | Cas exceptionnel : panne, incident. Motif obligatoire, signalement au back-office |
| `in_progress` | Client | Interdit — le trajet a commencé, il se termine ou fait l'objet d'un incident (L8-04) |

**Aucun frais d'annulation en v1.** Le mécanisme serait mal accepté au lancement et compliquerait la comptabilité pour un enjeu faible au volume du pilote. Les annulations sont comptées pour préparer une éventuelle politique ultérieure.

Une annulation en `in_progress` par le chauffeur laisse une course sans encaissement : elle doit apparaître distinctement dans les indicateurs, pas être noyée dans les courses terminées.

### Critères d'acceptation

1. Chaque combinaison état × acteur du tableau est testée.
2. L'annulation en `in_progress` par le client est refusée.
3. Une annulation en `proposed` libère effectivement la réservation côté temps réel.
4. Le motif est obligatoire quand le tableau l'exige.
5. Les annulations sont comptées par acteur et par état.

---

## L4-08 — Historique et factures

### Objectif

Le client et le chauffeur consultent leurs courses passées.

### Contexte

Lecture secondaire : passe en JSON-RPC natif, pas par un contrôleur REST (architecture §5).

### Fichiers

```
services/odoo/addons/babana/models/babana_ride.py
services/odoo/addons/babana/tests/test_ride_history.py
```

### Spécification

Exposer les champs nécessaires en lecture via JSON-RPC, protégés par les règles d'enregistrement de L8-01.

**Le filtrage repose sur les règles d'enregistrement, pas sur un paramètre de requête.** Un client qui demanderait l'historique d'un autre doit obtenir un ensemble vide par construction, pas parce que le code a pensé à filtrer.

Pagination obligatoire, avec une taille de page plafonnée côté serveur.

Le chauffeur voit ses courses avec le montant encaissé. Il ne voit ni le nom complet ni le téléphone du client au-delà de la fenêtre de la course — passée celle-ci, il n'a plus besoin de joindre le passager.

### Critères d'acceptation

1. Un client ne récupère que ses courses, même en modifiant les paramètres.
2. Un chauffeur ne récupère que les siennes.
3. La pagination est plafonnée côté serveur.
4. Le chauffeur n'accède plus aux coordonnées du client après la course — test explicite.
5. La facture est téléchargeable par le client concerné uniquement.

---

## L4-09 — Notation et avis

### Objectif

Le client note le chauffeur après la course (CDC §II.5).

### Fichiers

```
services/odoo/addons/babana/models/babana_rating.py
services/odoo/addons/babana/tests/test_rating.py
```

### Spécification

Note de 1 à 5, commentaire optionnel, sur une course `settled` dont le client est l'auteur. Une seule note par course, non modifiable après un court délai.

Recalcul de `rating_avg` et `rating_count` sur le chauffeur.

**Un chauffeur nouvellement approuvé n'a pas de note.** Afficher « nouveau » plutôt qu'une note nulle ou une moyenne par défaut : une note de zéro condamnerait un chauffeur avant sa première course, et D10 l'expose directement au choix du client (C2c).

La note affichée dans `nearby.drivers` (L3-05) tient compte d'un nombre minimum d'avis avant d'être significative. En dessous, afficher le statut « nouveau ».

Un commentaire n'est jamais affiché aux autres clients en v1 — modération non prévue. Il est visible du back-office uniquement.

### Critères d'acceptation

1. Une note ne peut être posée que sur une course `settled` par son client.
2. Une seconde note sur la même course est refusée.
3. La moyenne se recalcule correctement.
4. Un chauffeur sans avis suffisants est marqué « nouveau », pas noté zéro.
5. Les commentaires ne sont pas exposés aux apps.

---

## L4-10 — Tests de la machine à états

### Objectif

Prouver l'exhaustivité de L4-02.

### Fichiers

```
services/odoo/addons/babana/tests/test_ride_state_machine.py
services/odoo/addons/babana/tests/fixtures/transitions.json
```

### Spécification

Générer les tests depuis la table de transitions de C-03, exportée en données. Chaque ligne produit un test de transition valide ; chaque combinaison absente de la table produit un test de transition interdite.

Cette génération garantit qu'aucune transition n'est oubliée quand la table évolue — un test écrit à la main dérive de la spécification.

Couvrir en plus :

- Double encaissement impossible
- Fin de course sans démarrage impossible
- Écriture directe de `state` impossible
- Modification après `settled` impossible
- Transitions concurrentes sur la même course

### Critères d'acceptation

1. Les tests sont générés depuis la table de transitions.
2. Ajouter une transition à la table sans l'implémenter fait échouer la suite.
3. Toutes les combinaisons état × action sont couvertes, valides comme interdites.
4. Les cinq cas supplémentaires sont testés.
