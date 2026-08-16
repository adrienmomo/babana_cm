# L5 — Caisse et recette

**Point absent du cahier des charges, et risque numéro un du pilote.** Un chauffeur salarié qui encaisse des espèces détient des fonds appartenant à l'entreprise. Sans traçabilité, il n'existe aucun moyen de savoir si la recette rentre.

Décisions : D5 (salariat), D8 (compte courant et plafond), D9 (espèces uniquement). Écart É6 (recette encaissée, pas revenus).

---

## L5-01 — Compte courant chauffeur

### Objectif

Suivre ce que chaque chauffeur doit à l'entreprise.

### Fichiers

```
services/odoo/addons/babana/models/babana_cash_movement.py
services/odoo/addons/babana/models/babana_driver.py
services/odoo/addons/babana/tests/test_cash_balance.py
```

### Spécification

Modèle `babana.cash.movement` : chauffeur, type (`collection` ou `remittance` ou `adjustment`), montant signé, course ou remise à l'origine, horodatage, auteur.

**Le solde n'est jamais écrit directement** : il est calculé par somme des mouvements. Un solde écrit librement peut diverger de son historique, et c'est exactement ce qu'on cherche à empêcher.

Chaque encaissement (L4-05) crée un mouvement `collection` positif. Chaque remise validée (L5-04) crée un mouvement `remittance` négatif. Les ajustements sont réservés au back-office, motif obligatoire, et tracés.

Les mouvements sont **immuables** : ni modification, ni suppression, y compris pour un administrateur. Une erreur se corrige par un mouvement d'ajustement inverse, jamais par réécriture. C'est ce qui rend le journal opposable.

Le solde ne peut pas devenir négatif par un mouvement de type `collection` ou `remittance` : une remise supérieure au solde signale une erreur de saisie, à traiter en écart (L5-06). Seul un ajustement explicite peut produire un solde négatif, et il doit alerter.

### Critères d'acceptation

1. Le solde est calculé, jamais stocké librement.
2. Un mouvement ne peut être ni modifié ni supprimé.
3. Un encaissement crée exactement un mouvement.
4. Une remise supérieure au solde est refusée et orientée vers le traitement d'écart.
5. Un ajustement exige un motif et un auteur.
6. La somme des mouvements égale toujours le solde affiché.

---

## L5-02 — Plafond d'encaisse bloquant

### Objectif

Empêcher un chauffeur de détenir plus qu'un montant configuré.

### Contexte

**Le plafond est le seul mécanisme de contrôle de la recette**, puisque D7 supprime la clôture de service. Il doit bloquer à deux endroits, sinon il se contourne.

### Fichiers

```
services/odoo/addons/babana/models/babana_driver.py
services/realtime/src/driver/cash-guard.ts
services/odoo/addons/babana/tests/test_cash_limit.py
```

### Spécification

**Corrigé le 18 août (D28) : plafond fixe pour toute la flotte, pas par chauffeur.** Un montant unique, réglé par un paramètre système (L9-06), jamais un plafond individuel réglable par un gestionnaire — ce que cette section prévoyait à l'origine créait une inégalité entre chauffeurs qu'il aurait fallu justifier à voix haute, et un plafond en nombre de courses aurait été décorrélé du risque réel. Voir `01-architecture.md` §7.

**Deux points de blocage, tous deux obligatoires** :

1. **Sélection par le client** — un chauffeur au plafond n'apparaît pas dans `nearby.drivers` (L3-03).
2. **Acceptation par le chauffeur** — un chauffeur au plafond ne peut pas accepter une proposition, même s'il en reçoit une par un chemin résiduel.

Le second point n'est pas redondant : sans lui, une proposition émise juste avant le franchissement du plafond serait acceptable.

Seuil d'alerte à un pourcentage configurable du plafond, qui déclenche une notification (L7-05) : le chauffeur doit pouvoir organiser sa remise avant d'être bloqué en pleine journée.

Le franchissement du plafond met hors ligne **immédiatement**, dans la même transaction que l'encaissement qui l'a provoqué (L4-05).

Une course en cours n'est jamais interrompue par le franchissement du plafond : le passager est prioritaire.

### Critères d'acceptation

1. Un chauffeur au plafond n'apparaît pas dans les chauffeurs proches.
2. Un chauffeur au plafond ne peut pas accepter une proposition — test explicite du second point de blocage.
3. Le franchissement met hors ligne dans la même transaction que l'encaissement.
4. Une course en cours n'est pas interrompue.
5. Le seuil d'alerte déclenche une notification avant le blocage.
6. Le plafond par défaut vient de la configuration, jamais du code.

---

## L5-03 — Modèle de remise de caisse

### Objectif

Enregistrer la remise d'espèces à un superviseur.

### Fichiers

```
services/odoo/addons/babana/models/babana_cash_remittance.py
services/odoo/addons/babana/tests/test_remittance_model.py
```

### Spécification

Modèle `babana.cash.remittance` : référence par séquence, chauffeur, montant attendu figé à la création, montant déclaré par le chauffeur, montant compté par le superviseur, écart calculé, état (`draft`, `declared`, `validated`, `disputed`), superviseur, horodatages, motif d'écart, écriture comptable liée.

**Le montant attendu est figé à la création**, égal au solde à cet instant. Sans ce gel, une course encaissée pendant que la remise est en cours fausserait le rapprochement.

Les courses couvertes par la remise sont référencées explicitement : on doit pouvoir dire quelles courses ont été réglées par quelle remise.

Une remise validée est immuable.

### Critères d'acceptation

1. Le montant attendu est figé à la création et ne bouge plus.
2. Une course encaissée après la création de la remise n'y est pas incluse.
3. L'écart est calculé, jamais saisi.
4. Une remise validée ne peut plus être modifiée.
5. Les courses couvertes sont référencées.

---

## L5-04 — Validation de la remise

### Objectif

Le superviseur compte, valide, le solde repart à zéro.

### Fichiers

```
services/odoo/addons/babana/models/babana_cash_remittance.py
services/odoo/addons/babana/views/babana_remittance_views.xml
services/odoo/addons/babana/controllers/remittance.py
services/odoo/addons/babana/tests/test_remittance_validation.py
```

### Spécification

Parcours en deux temps, délibérément :

1. **Le chauffeur déclare** depuis son app : il annonce le montant qu'il remet. État `declared`.
2. **Le superviseur compte et valide** depuis le back-office : il saisit le montant réellement compté. État `validated` si les montants concordent, `disputed` sinon.

La double saisie est ce qui rend l'écart détectable. Une validation en un seul geste par le superviseur ne prouverait rien.

La validation réservée à `group_babana_supervisor`. **Un chauffeur ne peut jamais valider sa propre remise**, même s'il possède aussi un rôle de superviseur — contrôle explicite, pas seulement par les groupes.

À la validation : mouvement `remittance` négatif du montant compté, solde recalculé, écriture comptable (L5-05), chauffeur débloqué s'il était au plafond.

### Critères d'acceptation

1. Une remise ne peut être validée que par un superviseur.
2. Un chauffeur ne peut pas valider sa propre remise, même avec le rôle de superviseur.
3. La concordance produit `validated`, la discordance `disputed`.
4. La validation remet le solde à zéro, au montant compté près.
5. Un chauffeur bloqué au plafond est débloqué après validation.
6. Une remise déclarée mais non validée ne modifie pas le solde.

---

## L5-05 — Écriture comptable

### Objectif

Traduire la remise en comptabilité.

### Fichiers

```
services/odoo/addons/babana/models/babana_cash_remittance.py
services/odoo/addons/babana/data/accounting_config.xml
services/odoo/addons/babana/tests/test_remittance_accounting.py
```

### Spécification

À la validation, générer une pièce comptable qui solde la créance sur le chauffeur et enregistre l'entrée en caisse.

Comptes et journaux **paramétrables** : compte de créance sur les chauffeurs, compte de caisse, journal de caisse, compte d'écart. Le plan comptable OHADA en usage au Cameroun a ses propres numéros — les coder en dur rendrait le module inutilisable après le premier audit.

Un écart génère une écriture distincte sur le compte d'écart, pour rester visible en comptabilité. Un écart absorbé dans le montant principal est invisible au contrôle.

La pièce référence la remise, et la remise référence la pièce.

### Critères d'acceptation

1. La validation produit une pièce comptable équilibrée.
2. Comptes et journaux viennent de la configuration.
3. Un écart produit une écriture distincte sur le compte d'écart.
4. La pièce et la remise se référencent mutuellement.
5. Annuler une pièce validée est impossible sans passer par un mécanisme d'extourne tracé.

---

## L5-06 — Traitement des écarts

### Objectif

Rendre visible toute différence entre attendu et remis.

### Contexte

**Un écart silencieusement absorbé est une fraude rendue invisible.**

### Fichiers

```
services/odoo/addons/babana/models/babana_cash_discrepancy.py
services/odoo/addons/babana/tests/test_discrepancy.py
```

### Spécification

Tout écart non nul crée un enregistrement dédié : remise, chauffeur, montant, sens, motif, statut de traitement, décision.

Motifs proposés : appoint manquant, erreur de comptage, course contestée, autre avec commentaire obligatoire.

**Traitement par défaut, arbitré le 17 août (D29) : l'écart reste au solde du chauffeur.** La remise est acceptée pour le montant réellement remis ; la différence demeure au compte courant et **continue de compter dans le plafond d'encaisse**. Ce n'est pas un choix de commodité :

- Le logiciel enregistre un fait — il manque tel montant — et ne prend aucune décision de ressources humaines. Sur des chauffeurs salariés, c'est la seule position tenable.
- L'écart pèse là où le chauffeur le sent, sur sa capacité à travailler, et le plafond bloquant l'empêche de croître indéfiniment. Un écart sorti du compte courant serait un écart que plus personne ne regarde.
- Refuser la remise tant que le compte n'y est pas produirait l'effet inverse de celui recherché : un chauffeur bloqué au plafond pour 500 FCFA manquants ne peut plus travailler, donc plus rembourser.

Les autres traitements — ajustement avec justification, retenue selon la politique de l'entreprise — restent possibles, mais ce sont des **décisions humaines explicites** prises dans le back-office, jamais le comportement par défaut du système. Chaque traitement produit un mouvement de compte courant tracé (L5-01).

**Alerte automatique** au-delà d'un seuil d'écart cumulé par chauffeur sur une période glissante. Un écart isolé est banal ; une série d'écarts dans le même sens ne l'est pas. C'est le seul mécanisme qui détectera un détournement progressif.

Vue back-office listant les écarts en attente, triés par ancienneté.

### Critères d'acceptation

1. Un écart non nul crée systématiquement un enregistrement.
1 bis. **Une remise partielle est acceptée, et le reliquat demeure au solde du chauffeur** — vérifié sur le solde, pas seulement sur l'enregistrement d'écart. Un chauffeur qui remet 40 000 sur 45 000 dus repart avec 5 000 au compte courant, qui pèsent sur son plafond.
2. Aucun écart ne peut être clos sans motif.
3. Le traitement produit un mouvement de compte courant tracé.
4. Le seuil d'écart cumulé déclenche une alerte.
5. Une série d'écarts de même sens chez un chauffeur est détectée et signalée.

---

## L5-07 — Écran de recette dans l'app Chauffeur

### Objectif

Le chauffeur voit ce qu'il a encaissé et ce qu'il doit.

### Contexte

**É6 — le libellé est « recette encaissée », jamais « revenus ».** Un chauffeur salarié n'a pas de revenu variable par course : ce qu'il voit est l'argent de l'entreprise qu'il détient. Un libellé « revenus » créerait un malentendu sur la nature de la somme, et il alimenterait la contestation le jour où le chauffeur comparera ce chiffre à sa fiche de paie.

### Fichiers

```
apps/driver/src/screens/CashScreen.tsx
apps/driver/src/api/cash.ts
apps/driver/src/screens/__tests__/CashScreen.test.tsx
```

### Spécification

Affichage :

- **Recette encaissée aujourd'hui** — somme des courses réglées du jour
- **Solde à remettre** — compte courant actuel
- **Plafond et marge restante** — avec un indicateur visuel de proximité
- **Historique des remises** — date, montant, superviseur, statut
- **Bouton de déclaration de remise** (L5-04)

Aucune mention de « revenus », « gains », « salaire » ou « bénéfice » dans l'interface. À vérifier par un test qui recherche ces termes dans les libellés.

L'approche du plafond est visible avant le blocage : un chauffeur bloqué en pleine journée sans avertissement est un chauffeur qui perd des heures de travail.

Les données sont lues côté serveur à chaque affichage, jamais calculées localement — le solde est une donnée financière, l'app ne la dérive pas.

### Critères d'acceptation

1. Aucun libellé ne contient « revenus », « gains », « salaire » ou « bénéfice » — test automatisé sur les chaînes.
2. La marge restante avant plafond est visible.
3. Le solde vient du serveur, il n'est pas calculé dans l'app.
4. L'historique des remises affiche le statut, y compris `disputed`.
5. La déclaration de remise fonctionne hors connexion et se rejoue à la reconnexion (L6-16).
