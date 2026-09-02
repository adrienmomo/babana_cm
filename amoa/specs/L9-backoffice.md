# L9 — Back-office et pilotage

CDC §V. C'est ici que le choix d'Odoo se rentabilise : l'essentiel est du paramétrage de vues standard, pas du développement d'interface.

**Deux tâches de ce lot ne sont pas du reporting mais des instruments de décision** : L9-08 dira s'il faut rouvrir D10, L9-09 s'il faut rouvrir D11.

---

## L9-01 — Vues chauffeurs

### Objectif

Gérer les chauffeurs depuis le back-office.

### Fichiers

```
services/odoo/addons/babana/views/babana_driver_views.xml
services/odoo/addons/babana/views/babana_menus.xml
```

### Spécification

Vue liste : nom, statut, en ligne, moto affectée, note, courses effectuées, solde, dernière activité.

Vue formulaire : informations, documents avec aperçu, moto, historique d'affectations, courses récentes, mouvements de caisse, boutons d'action de L1-06.

Filtres : par statut, en ligne, plafond atteint, documents expirant, sans moto affectée. Regroupements par statut.

**Correction du 10 septembre : « regroupement par zone d'activité » est retiré.** Un chauffeur n'a pas de zone — D6 le rattache durablement à une moto, jamais à un territoire, et `babana.zone` est un polygone de tarification, pas une affectation. « Zone d'activité » ne peut se calculer qu'a posteriori, depuis les courses : c'est une donnée d'analyse, du même ordre que les indicateurs de L9-07, et elle a besoin des données que le pilote produira. La fabriquer dans une vue de liste demanderait une recherche par ligne — exactement ce que L9-07 proscrit.

Le solde et le statut sont visibles **dans la liste**, pas seulement dans le formulaire : un superviseur doit voir d'un coup d'œil qui doit remettre.

Codes couleur sur les états critiques : plafond atteint, document expiré, suspendu.

### Critères d'acceptation

1. La liste montre solde et statut sans ouvrir le formulaire.
2. Tous les filtres listés fonctionnent.
3. Les documents sont consultables depuis le formulaire par URL signée.
4. Les actions de validation sont accessibles depuis le formulaire.
5. Les états critiques sont visuellement distincts.

---

## L9-02 — Vues flotte

### Objectif

Gérer les motos (D6).

### Fichiers

```
services/odoo/addons/babana/views/babana_motorcycle_views.xml
```

### Spécification

Liste : immatriculation, gamme, état, chauffeur affecté, échéance d'assurance.

Formulaire : caractéristiques, documents, historique d'affectations, courses effectuées.

Filtres : disponible, affectée, en maintenance, assurance expirant, assurance expirée.

Vue calendrier ou liste des échéances à venir (L1-10).

Action d'affectation et de fin d'affectation depuis le formulaire.

### Critères d'acceptation

1. Les échéances à venir sont visibles sans construire de filtre.
2. L'affectation se fait depuis le formulaire.
3. Une moto à l'assurance expirée est visuellement distincte.
4. L'historique d'affectations est consultable et non modifiable.

---

## L9-03 — Vues courses

### Objectif

Consulter et filtrer les courses.

### Fichiers

```
services/odoo/addons/babana/views/babana_ride_views.xml
```

### Spécification

Liste : référence, date, client, chauffeur, départ, arrivée, distance, montant, état, moyen de paiement.

Formulaire, en **lecture seule** : détail complet, détail tarifaire décomposé, **lien d'ouverture du tracé dans une carte externe**, chronologie des transitions, refus, incidents et litiges liés.

**Correction du 10 septembre : le tracé ne s'affiche pas dans le back-office, il s'ouvre.** Odoo Communauté n'a pas de widget carte — la vue `map` est une fonction Entreprise — et en embarquer un demanderait d'écrire un composant, de charger une bibliothèque de cartographie et d'appeler un serveur de tuiles depuis le back-office : un travail sans rapport avec une tâche dont la spécification dit elle-même qu'elle est « du paramétrage de vues standard ».

La réponse est celle que D12 a déjà retenue pour la navigation du chauffeur : **ne pas embarquer une carte, passer la main à une carte.** Un lien qui ouvre le tracé dans Google Maps depuis la fiche de course. Le superviseur qui instruit un litige y retrouve un outil qu'il connaît, et le back-office n'acquiert aucune dépendance cartographique.

Le formulaire est en lecture seule y compris pour un administrateur : les modifications passent par les transitions (L4-02). Une course modifiable à la main détruit la valeur du journal d'audit.

Filtres : par état, période, chauffeur, client, zone de départ, écart de distance signalé, courses annulées par acteur.

Vue liste avec regroupements : par jour, par chauffeur, par zone, par état.

### Critères d'acceptation

1. Le formulaire est en lecture seule, y compris en administrateur.
2. Le tracé s'ouvre dans une carte externe depuis la fiche de course, en un clic.
3. La chronologie des transitions est complète.
4. Tous les filtres listés fonctionnent.
5. Les courses à écart signalé sont filtrables.

---

## L9-04 — Vues tarification et promotions

### Objectif

Paramétrer les tarifs sans développeur.

### Fichiers

```
services/odoo/addons/babana/views/babana_fare_rule_views.xml
services/odoo/addons/babana/views/babana_zone_views.xml
services/odoo/addons/babana/views/babana_promotion_views.xml
```

### Spécification

Vue des règles tarifaires avec leur priorité et leur fenêtre de validité. **Avertissement visuel quand deux règles se recouvrent** : c'est l'erreur de paramétrage la plus probable, et elle produit des tarifs incompréhensibles.

Simulateur de tarif : saisir un départ, une arrivée, une heure, une gamme, et voir le montant et la règle appliquée. Indispensable — sans lui, la seule façon de vérifier un paramétrage est de commander une course.

Vue des zones avec leur polygone sur une carte, éditable.

Vue des promotions avec compteurs d'usage en temps réel et taux de conversion.

Modifier une règle en cours d'utilisation crée une version (L2-01) : l'interface doit le dire clairement, pas laisser croire à une modification en place.

### Critères d'acceptation

1. Le recouvrement de deux règles produit un avertissement.
2. Le simulateur renvoie montant et règle appliquée.
3. Les polygones de zone sont éditables sur carte.
4. Les compteurs d'usage des promotions sont à jour.
5. La création de version lors d'une modification est explicite dans l'interface.

---

## L9-05 — Vues remises de caisse

### Objectif

Valider les remises et traiter les écarts.

### Fichiers

```
services/odoo/addons/babana/views/babana_remittance_views.xml
services/odoo/addons/babana/views/babana_discrepancy_views.xml
```

### Spécification

Liste des remises : référence, chauffeur, montant attendu, déclaré, compté, écart, état, superviseur.

Formulaire de validation : montant attendu figé, saisie du montant compté, écart calculé automatiquement, courses couvertes.

Vue dédiée des écarts en attente, triée par ancienneté, avec l'historique d'écarts du chauffeur concerné visible dans le même écran. C'est cette juxtaposition qui permet de repérer une série — un écart isolé ne dit rien, trois écarts dans le même sens disent quelque chose.

Tableau de bord de caisse : total détenu par la flotte, chauffeurs au plafond, chauffeurs proches du plafond, remises en attente de validation.

Le total détenu par la flotte est l'indicateur le plus important du pilote : c'est l'exposition financière de l'entreprise à un instant donné.

### Critères d'acceptation

1. Le formulaire de validation calcule l'écart, il ne le fait pas saisir.
2. L'historique d'écarts du chauffeur est visible depuis l'écart courant.
3. Le tableau de bord affiche le total détenu par la flotte.
4. Les remises en attente sont triées par ancienneté.
5. Une série d'écarts de même sens est visuellement repérable.

---

## L9-06 — Paramétrage du dispatch

### Objectif

Aucune valeur de dispatch codée en dur.

### Contexte

Chaque valeur codée en dur est un déploiement à faire pour changer un chiffre qu'on ajustera dix fois pendant le pilote.

### Fichiers

```
services/odoo/addons/babana/models/res_config_settings.py
services/odoo/addons/babana/views/res_config_settings_views.xml
```

### Spécification

Paramètres exposés dans les réglages Odoo :

| Paramètre | Valeur par défaut |
|---|---|
| Délai d'acceptation par le chauffeur | 30 secondes |
| Rayon de recherche initial | À calibrer en pilote |
| Palier d'élargissement du rayon | À calibrer |
| Rayon maximum | À calibrer |
| Nombre de chauffeurs proposés | 5 (D14) |
| Plafond d'encaisse par défaut | À définir |
| Seuil d'alerte de plafond, en pourcentage | — |
| Durée de validité d'une estimation | — |
| Pas d'arrondi du tarif | — |
| Seuil d'écart de distance signalé | — |
| Fréquences de capture GPS par état | — |
| Précision d'arrondi des positions diffusées | — |
| Durée de vie du lien de partage après la course | — |

**Le service temps réel lit ces valeurs depuis Odoo**, avec un cache court et un rechargement à chaud. Un changement de paramètre ne doit demander aucun redémarrage.

Chaque paramètre porte une aide expliquant son effet et les conséquences d'une valeur extrême.

Les modifications sont journalisées (L8-09) : qui a changé quoi, quand.

### Critères d'acceptation

1. Tous les paramètres listés sont dans les réglages.
2. Le service temps réel prend en compte un changement sans redémarrage.
3. Aucune de ces valeurs n'apparaît en dur dans le code — vérifié par recherche.
4. Chaque paramètre a une aide.
5. Les modifications sont journalisées.

---

## L9-07 — Tableau de bord

### Objectif

Piloter l'activité (CDC §V.2).

### Fichiers

```
services/odoo/addons/babana/views/babana_dashboard.xml
services/odoo/addons/babana/models/babana_ride_report.py
```

### Spécification

Vue d'analyse sur les courses, avec agrégations par jour, semaine, mois.

Indicateurs :

- Courses par période, par état
- Recette générée, totale et par chauffeur
- Distance moyenne, montant moyen
- Zones les plus actives (CDC §V.2)
- Heures de pointe observées
- Taux d'annulation par acteur
- Délai moyen entre demande et affectation
- Taux de refus des chauffeurs

Implémenter en vue SQL matérialisée ou en modèle de rapport, pas en calcul Python sur des enregistrements : le calcul en boucle s'effondrera dès quelques milliers de courses.

**Les heures de pointe observées sont à comparer aux plages configurées** dans les règles tarifaires : si elles divergent, le coefficient s'applique au mauvais moment. Le rapprochement doit être visible sur le tableau de bord, pas laissé à l'initiative de quelqu'un.

### Critères d'acceptation

1. Les indicateurs listés sont disponibles.
2. Le calcul est en SQL, pas en boucle Python.
3. Les zones actives sont visualisables.
4. Les heures de pointe observées sont comparables aux plages configurées.
5. Le tableau de bord reste réactif sur un volume simulé de plusieurs dizaines de milliers de courses.

---

## L9-08 — Indicateur d'équité

### Objectif

Détecter les chauffeurs salariés que personne ne sélectionne.

### Contexte

**Ce n'est pas du reporting, c'est un instrument de décision.** C2c : avec D10, les chauffeurs bien notés seront choisis et les nouveaux ne démarreront jamais. Sur un modèle à la commission ce serait leur problème ; avec D5, c'est l'entreprise qui paie des salariés que personne ne sélectionne. **C'est cet indicateur qui dira s'il faut rouvrir D10 et réintroduire une attribution automatique.**

### Fichiers

```
services/odoo/addons/babana/models/babana_driver_equity.py
services/odoo/addons/babana/views/babana_equity_views.xml
```

### Spécification

Par chauffeur et par période : courses effectuées, heures en ligne, **courses par heure en ligne**, nombre de fois affiché dans une liste de 5, nombre de fois sélectionné, taux de sélection quand affiché.

Le taux de sélection quand affiché est l'indicateur clé : il isole le choix du client de la disponibilité du chauffeur. Un chauffeur peu sollicité parce qu'il travaille peu n'est pas le même problème qu'un chauffeur souvent affiché et jamais choisi.

Cela impose que **le service temps réel remonte les affichages**, pas seulement les sélections. C'est un compteur agrégé, pas un événement par affichage — il ne s'agit pas de contredire la règle de partition, mais de remonter un compteur périodique.

Vue de comparaison entre chauffeurs, avec écart-type et identification des extrêmes.

**Alerte automatique** quand un chauffeur approuvé et actif reste sous un seuil de courses par heure en ligne sur une période. C'est le déclencheur de la décision.

Corrélation entre note affichée et taux de sélection : elle dira si le choix se fait sur la note ou sur la proximité.

### Critères d'acceptation

1. Le taux de sélection quand affiché est calculé par chauffeur.
2. Le service temps réel remonte les affichages de façon agrégée, sans violer la règle de partition.
3. L'alerte se déclenche sur le seuil configuré.
4. La comparaison entre chauffeurs identifie les extrêmes.
5. La corrélation note / sélection est disponible.

---

## L9-09 — Indicateur d'abandon

### Objectif

Mesurer l'abandon après refus.

### Contexte

**Instrument de décision.** D11 retient le retour à la sélection manuelle sans filet. **C'est cet indicateur qui dira s'il faut rouvrir D11 et ajouter un repli automatique.**

### Fichiers

```
services/odoo/addons/babana/models/babana_funnel.py
services/odoo/addons/babana/views/babana_funnel_views.xml
```

### Spécification

Entonnoir mesuré à chaque étape : estimation demandée, course créée, chauffeur sélectionné, chauffeur accepté, course démarrée, course terminée, course encaissée.

Pour les abandons après refus, mesurer précisément :

- Rang du refus auquel le client abandonne — premier, deuxième, troisième
- Délai écoulé depuis la demande initiale au moment de l'abandon
- Nombre de sélections avant abandon
- Cas où aucun chauffeur n'était disponible

Les abandons sont remontés par l'app (L6-08), puisqu'un client qui ferme l'app ne produit aucun appel serveur.

Segmentation par zone, tranche horaire, et nouveau client contre client récurrent. Un nouveau client abandonne plus vite : ne pas mélanger les deux populations, ce serait masquer le signal.

**Seuil d'alerte** au-delà duquel D11 doit être rouverte, défini avant la mise en service — pas après avoir vu les chiffres.

### Critères d'acceptation

1. Chaque étape de l'entonnoir est mesurée.
2. Le rang de refus au moment de l'abandon est enregistré.
3. La segmentation nouveau contre récurrent est disponible.
4. Le seuil de réouverture de D11 est défini et documenté avant la mise en service.
5. Les abandons remontés par l'app sont fiables même si l'app est fermée brutalement.

---

## L9-10 — Rapports exportables

### Objectif

Exporter en PDF et Excel (CDC §V.2).

### Fichiers

```
services/odoo/addons/babana/report/
├── ride_report.xml
├── revenue_report.xml
└── cash_report.xml
```

### Spécification

Rapports : activité par période, recette par chauffeur, état de caisse, courses par zone, écarts de caisse.

Export Excel via le mécanisme standard d'Odoo, PDF via QWeb.

Les rapports comportent leur **période, la date de génération et l'auteur**. Un rapport sans période exporté puis partagé devient ininterprétable.

Le rapport de recette par chauffeur porte le libellé « recette encaissée », pas « revenus » (É6) — même contrainte que L5-07, et elle vaut aussi pour les documents exportés qui circuleront hors de l'application.

Rapports planifiables et envoyables par email.

### Critères d'acceptation

1. Les cinq rapports existent en PDF et en Excel.
2. Chaque rapport porte période, date de génération et auteur.
3. Aucun rapport n'utilise le terme « revenus » pour la recette chauffeur.
4. La planification et l'envoi par email fonctionnent.
5. Les montants des rapports concordent avec le tableau de bord.
