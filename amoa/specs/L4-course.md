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
| Tarif | **référence** vers la règle appliquée, règle figée par valeur, détail décomposé, montant final, promotion, remise |
| Zones | zone de départ, zone d'arrivée — ajoutées par L2-04 (`babana.zone` n'existait pas à l'écriture de L4-01) |
| Paiement | moyen (`cash` en v1), facture, horodatage d'encaissement |
| Cycle | horodatages de chaque transition, motif d'annulation, auteur de l'annulation |
| Refus | liste des refus sur cette course, avec chauffeur, motif et horodatage |
| Notation | note, commentaire |

**La règle tarifaire est figée sur la course**, pas seulement référencée. Une facture doit rester explicable après modification de la grille.

**Et elle est aussi référencée** (ajout du 13 août). Les deux ne s'opposent pas, ils répondent à deux besoins distincts : le gel par valeur rend la facture explicable pour toujours, la référence dit **quelle** règle a servi. Sans la référence, il n'existe aucun moyen de savoir si une règle donnée a été utilisée — ce qui obligeait à rendre **toutes** les règles immuables, y compris celles jamais servies, et donc à créer une version pour corriger une faute de frappe. La référence lève cette contrainte et sert aussi la traçabilité de L9.

La référence peut pointer vers une règle supprimée ou archivée sans que la facture en souffre : c'est le gel par valeur qui fait foi pour le montant.

Index sur `state`, sur le chauffeur, sur le client, sur la date de création. Ce sont les axes de toutes les requêtes de L9.

Contraintes de base de données, pas seulement applicatives. **Les états actifs diffèrent selon la partie** — correction du 11 août, l'énoncé initial appliquait la même liste aux deux :

| Partie | États actifs | Pourquoi |
|---|---|---|
| Chauffeur | `proposed`, `assigned`, `in_progress` | En `requested`, aucun chauffeur n'est encore désigné — l'état ne le concerne pas |
| Client | `requested`, `proposed`, `assigned`, `in_progress` | Dès la demande, le client a une course en cours ; deux demandes simultanées du même client n'ont aucun sens métier |

C'est une garantie de dernier recours si une transition est contournée. L'écart entre les deux listes explique pourquoi un contrôle applicatif seul ne suffisait pas côté client.

### Critères d'acceptation

1. La référence est générée par séquence et unique.
2. Un second enregistrement de course active pour le même chauffeur échoue au niveau base, avec la liste d'états propre au chauffeur.
2 bis. Un second enregistrement de course active pour le même client échoue au niveau base, **`requested` compris**.
3. La règle tarifaire figée survit à la modification de la règle d'origine, **et à sa suppression**.
3 bis. La course porte une référence vers la règle appliquée, exploitable pour savoir quelles règles ont servi.
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

**Verrouillage de l'enregistrement** pendant la transition. Après l'obtention du verrou, **invalider le cache du recordset** : une transaction qui a attendu relirait sinon l'état depuis le cache rempli avant la mise en attente, donc une valeur périmée.

**La vérification applicative qu'un chauffeur n'a pas déjà une course active n'est pas une garantie.** Elle verrouille la course, pas le chauffeur : deux clients proposant le même chauffeur sur deux courses différentes verrouillent chacun la sienne et passent tous deux le contrôle. La garantie réelle est l'index unique partiel de L4-01 ; le contrôle Python n'est qu'un chemin rapide pour le cas courant. **L4-03 doit traduire la violation d'index en `DRIVER_ALREADY_TAKEN`**, sinon l'erreur remonte en défaut technique brut.

**Verrouillage de l'enregistrement** pendant la transition, pour empêcher deux transitions concurrentes sur la même course. Deux appels simultanés à `action_accept` ne doivent pas produire deux affectations.

Le mécanisme est implémenté ici ; sa **preuve** est portée par L4-11. Ne pas écrire de test de concurrence dans le harnais Odoo : `TransactionCase` enveloppe le test dans une transaction annulée à la fin, si bien qu'une seconde connexion réelle ne voit jamais les lignes créées ou attend un verrou qui ne se libère qu'à la fin du test. Le test paraît alors instable alors que le mécanisme est correct — constaté pendant la nuit du 10 au 11 août.

Surcharger `write` **et `create`** pour interdire toute écriture directe de `state` hors des méthodes de transition. C'est le point qui rend l'invariant réel plutôt que conventionnel.

**`create` compte autant que `write`** (correction du 13 août — ma spécification ne mentionnait que `write`, et la revue de la branche a montré le trou). Sans garde sur la création, `create({'state': 'settled', ...})` fait naître une course déjà encaissée sans qu'aucune transition n'ait eu lieu. L'invariant 2 serait alors vrai en modification et faux en création — et `settled` est précisément l'état qui alimente le compte courant chauffeur et la facturation.

Toute création hors du chemin de transition force `state = 'requested'`, ou échoue si un autre état est demandé.

Rendre immuables les champs figés selon l'état : après `completed`, distance et montant ne changent plus ; après `settled`, plus rien ne change. Interdit au niveau du modèle, y compris pour un administrateur.

Le champ `state` porte les transitions autorisées depuis l'état courant, exposé à l'app pour qu'elle n'affiche pas des actions impossibles.

### Critères d'acceptation

1. **Chaque** transition valide de C-03 a un test qui passe.
2. **Chaque** transition interdite de C-03 a un test qui échoue avec `RIDE_INVALID_TRANSITION`.
3. Une écriture directe de `state` par `write` échoue.
3 bis. Une création avec un `state` autre que `requested` échoue, **y compris via `sudo()`**.
4. Deux `action_accept` concurrents ne produisent qu'une affectation. **Ce critère est vérifié par L4-11, pas ici** — un test de concurrence a besoin de transactions réellement validées, ce que le harnais Odoo ne permet pas (voir L4-11).
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
| `rejected` | Client | **Abandon après refus.** Aucune réservation à libérer — elle l'a été en entrant dans `rejected`. Motif non obligatoire, mais la course porte une **catégorie d'annulation dédiée** (`abandon_after_rejection`) et le rang du refus au moment de l'abandon |
| `in_progress` | Client | Interdit — le trajet a commencé, il se termine ou fait l'objet d'un incident (L8-04) |

**Sur la catégorie `abandon_after_rejection`** : L9-09 mesure le taux d'abandon après un ou plusieurs refus, et c'est cet indicateur qui décidera s'il faut rouvrir D11. Traiter cette annulation comme une annulation ordinaire priverait l'indicateur de son signal principal et obligerait à le reconstituer en croisant l'historique des refus — fragile et coûteux. La catégorie et le rang du refus sont donc enregistrés au moment de l'annulation, pas déduits après coup.

**Aucun frais d'annulation en v1.** Le mécanisme serait mal accepté au lancement et compliquerait la comptabilité pour un enjeu faible au volume du pilote. Les annulations sont comptées pour préparer une éventuelle politique ultérieure.

Une annulation en `in_progress` par le chauffeur laisse une course sans encaissement : elle doit apparaître distinctement dans les indicateurs, pas être noyée dans les courses terminées.

### Critères d'acceptation

1. Chaque combinaison état × acteur du tableau est testée, `rejected` compris.
1 bis. Une annulation depuis `rejected` porte la catégorie `abandon_after_rejection` et le rang du refus, exploitables par L9-09 sans reconstitution.
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

---

## L4-11 — Test de concurrence sur les transitions

### Objectif

Prouver que deux transitions concurrentes sur la même course n'en produisent qu'une.

### Contexte

**Extrait de L4-02 le 11 août 2026.** Le mécanisme de verrouillage a été implémenté et vérifié manuellement, mais le test qui devait le prouver vivait dans le harnais Odoo, où il prenait 60 à 185 secondes et échouait par intermittence.

La cause est structurelle : `TransactionCase` enveloppe chaque test dans une transaction annulée à la fin. Une seconde connexion réelle ne voit pas les lignes créées par la première, ou attend un verrou qui ne se libérera qu'à la fin du test. **Le harnais était en cause, pas le mécanisme.**

Même raisonnement que L3-13 pour la réservation atomique : un test de concurrence a besoin de transactions réellement validées, donc d'un environnement réel.

### Fichiers

```
test/concurrency/
├── ride-transitions.test.ts
└── helpers/odoo-session.ts
```

### Spécification

Contre la pile démarrée par `make up`, pas contre le harnais Odoo.

**Scénario 1 — acceptation concurrente.** N sessions authentifiées appellent `action_accept` sur la même course `proposed`, réellement simultanément. Exactement un succès, N−1 échecs avec un code d'erreur explicite. Répéter un grand nombre de fois : une fenêtre de course étroite ne se manifeste pas au premier essai.

**Scénario 2 — transitions divergentes.** Un client annule pendant qu'un chauffeur accepte. Une seule des deux transitions gagne, l'état final est cohérent, et le perdant reçoit une erreur compréhensible plutôt qu'un état intermédiaire.

**Scénario 3 — encaissement concurrent.** Deux `action_settle` simultanés sur la même course. Un seul mouvement de compte courant, une seule facture.

Chaque scénario vérifie l'état final en base, pas seulement les codes de retour.

### Critères d'acceptation

1. Les tests s'exécutent contre une pile réelle, avec des transactions validées.
2. Sur toutes les itérations, exactement un succès par scénario.
3. L'état final en base est cohérent à chaque itération.
4. Le temps d'exécution est stable — pas de variation d'un facteur trois entre deux exécutions.
5. Une implémentation volontairement naïve, sans verrouillage, fait échouer les trois scénarios. À vérifier une fois, sinon le test ne prouve rien.
6. Le test tourne en intégration continue.

### Piège

Le critère 5 est ce qui distingue un test utile d'un test décoratif — même exigence que L3-13. Un test de concurrence qui passerait aussi sans verrou ne teste rien.
