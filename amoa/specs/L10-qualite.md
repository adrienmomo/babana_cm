# L10 — Qualité et préparation du pilote

Le lot qui décide si le pilote Bonanjo produit des décisions ou seulement des impressions.

---

## L10-01 — Scénario de bout en bout automatisé

### Objectif

Un test qui parcourt la boucle complète, exécuté en intégration continue.

### Fichiers

```
test/e2e/
├── full-ride.test.ts
├── fixtures/
└── helpers/
```

### Spécification

Contre l'environnement complet démarré par `make up` : Odoo, service temps réel, Redis, PostgreSQL.

Scénario nominal, de bout en bout :

1. Créer un chauffeur, le faire approuver, lui affecter une moto
2. Le chauffeur se connecte et passe en ligne
3. Le client se connecte et demande une estimation
4. Le client crée la course et sélectionne le chauffeur
5. Le chauffeur accepte
6. Émission de positions, vérification du suivi côté client
7. Démarrage puis fin de course
8. Encaissement espèces
9. Vérification : facture générée, solde chauffeur incrémenté, journal d'audit complet

Scénarios complémentaires, à traiter comme des variantes du même harnais :

- Refus puis nouvelle sélection puis acceptation
- Annulation par le client après affectation
- Franchissement du plafond d'encaisse et blocage
- Remise de caisse validée, solde remis à zéro
- **Notifications entièrement désactivées** (L7-06)

Les apps mobiles ne sont pas pilotées : le test appelle les API et les WebSocket directement. Une automatisation d'interface mobile coûterait plus qu'elle ne rapporterait à ce stade.

### Critères d'acceptation

1. Le scénario nominal passe contre l'environnement complet.
2. Les cinq variantes passent.
3. Le test tourne en intégration continue.
4. L'échec indique clairement l'étape en cause.
5. Le test est rejouable sans nettoyage manuel.

---

## L10-02 — Mesure cartographique

### Objectif

Mesurer l'écart entre ce que le routeur annonce et ce qu'une moto fait réellement.

### Contexte

**À planifier dès le début du pilote, pas après.** Elle conditionne L10-03 et L10-05, donc la crédibilité de l'ETA et la formule de facturation. Menée trop tard, elle impose de refaire la tarification en pleine exploitation.

É8 : ni Google ni Mapbox ne calculent d'itinéraire deux-roues au Cameroun. Tous les itinéraires sont calculés sur un modèle voiture.

### Fichiers

```
docs/measurements/map-comparison.md
tools/map-benchmark/
```

### Spécification

**Volet 1 — itinéraires et durées.** Trente couples départ–arrivée réels à Douala, issus de trajets moto observés, répartis entre heures creuses et heures de pointe, et entre zones denses et zones fluides.

Pour chacun : distance et durée annoncées par Google, distance et durée annoncées par Mapbox, distance et durée réellement observées par une moto sur le terrain.

Calculer, par tranche horaire et par zone : rapport entre durée annoncée et durée observée, rapport entre distance annoncée et distance parcourue.

**Volet 2 — recherche de lieu.** Cinquante repères d'usage courant à Douala, tels qu'un habitant les nommerait — carrefours, stations, marchés, écoles, quartiers. Mesurer le taux de résolution correcte dans chaque base.

Le volet 2 est celui qui tranchera si D13 était le bon choix : c'est la couverture des points d'intérêt qui a fait pencher pour Google.

Rapport versionné, avec les données brutes, pas seulement les conclusions.

### Critères d'acceptation

1. Trente couples couvrant les deux tranches horaires et les deux types de zone.
2. Durées réellement observées relevées sur le terrain, pas estimées.
3. Cinquante repères testés dans les deux bases.
4. Les rapports par tranche horaire et par zone sont calculés.
5. Données brutes versionnées dans le dépôt.

---

## L10-03 — Facteur de correction d'ETA

### Objectif

Afficher une durée crédible malgré É8.

### Fichiers

```
services/odoo/addons/babana/services/eta_correction.py
services/odoo/addons/babana/models/babana_eta_factor.py
services/odoo/addons/babana/tests/test_eta_correction.py
```

### Spécification

Modèle de facteurs de correction paramétrable par zone et tranche horaire, alimenté par L10-02.

Application à toute durée renvoyée au client : estimation (L2-04) et ETA d'approche (L3-09).

**Réévaluation continue** : les durées réellement observées par le service temps réel (L3-10) alimentent le calcul, ce qui permet d'affiner les facteurs sans nouvelle campagne de terrain. Le recalcul est périodique et proposé à validation, pas appliqué automatiquement — un facteur qui dérive tout seul est ingérable.

Tableau de bord de la précision d'ETA : écart moyen et distribution entre durée annoncée corrigée et durée réelle. Un ETA systématiquement pessimiste détruit la crédibilité de l'app aussi sûrement qu'un ETA optimiste.

Le facteur ne s'applique **jamais au tarif** — D15 a retiré le terme temps. Il ne concerne que l'affichage.

### Critères d'acceptation

1. Le facteur est paramétrable par zone et tranche horaire.
2. Il s'applique à l'estimation et à l'ETA d'approche.
3. Il ne s'applique à aucun calcul tarifaire — vérifié par test.
4. Les durées observées alimentent une proposition de réévaluation.
5. Le tableau de bord de précision est disponible.

---

## L10-04 — Devis Google pour la v2

### Objectif

Lever l'inconnue de coût de la navigation embarquée.

### Contexte

Le tarif du SKU « Navigation Request » n'est pas publié. La fourchette générale des SKU Google va de 2 à 40 dollars pour mille requêtes, soit un facteur vingt d'incertitude sur cette ligne.

### Fichiers

```
docs/decisions/navigation-cost.md
```

### Spécification

Obtenir le tarif par destination du SKU « Navigation Request », par le calculateur de tarifs ou un contact commercial Google.

Projeter le coût mensuel à trois volumes : pilote, cinquante chauffeurs, deux cents chauffeurs.

Comparer au coût Mapbox équivalent en forfait illimité, sur les mêmes volumes.

**Seuil de bascule** : au-delà de quel coût mensuel D13 doit être rouverte en faveur de Mapbox. Le définir avant d'avoir le devis, pas après.

Vérifier que l'abstraction de L6-01 permet effectivement la bascule, en écrivant un fournisseur Mapbox minimal qui compile contre l'interface.

### Critères d'acceptation

1. Le tarif est obtenu et documenté avec sa source et sa date.
2. Les projections à trois volumes sont calculées.
3. Le seuil de bascule était défini avant l'obtention du devis.
4. Un fournisseur Mapbox minimal compile contre l'interface de `packages/maps`.

---

## L10-05 — Distance facturée

### Objectif

Trancher entre distance calculée et distance parcourue.

### Contexte

L4-04 retient par défaut la distance de référence, parce qu'elle est reproductible et connue du client à l'avance. É8 signale que l'écart entre calculé et parcouru sera plus élevé que dans une app voiture, le chauffeur prenant des raccourcis qu'une voiture ne peut pas prendre.

### Fichiers

```
docs/decisions/billed-distance.md
```

### Spécification

Sur les données de L10-02 et sur les premières courses du pilote, analyser la distribution de l'écart entre distance de référence et distance parcourue.

Trois questions à trancher :

1. L'écart est-il systématiquement dans le même sens ? Si la moto parcourt systématiquement moins que le calculé, facturer le calculé surfacture tout le monde.
2. L'écart est-il assez stable pour justifier un coefficient correctif appliqué à la distance de référence ?
3. Le seuil de signalement d'écart de L4-04 est-il calibré, ou produit-il trop de faux signalements pour être exploitable ?

Trois options, avec leurs conséquences :

- **Distance de référence** — reproductible, annonçable d'avance, mais peut surfacturer si l'écart est systématique
- **Distance parcourue** — plus juste sur le trajet réel, mais non annonçable d'avance et sensible à la qualité GPS, donc contestable
- **Distance de référence corrigée d'un coefficient** — compromis, à condition que l'écart soit stable

Décision documentée avec ses données, et seuil de signalement recalibré.

### Critères d'acceptation

1. La distribution de l'écart est mesurée sur des données réelles.
2. Les trois questions sont tranchées avec leurs données.
3. La décision est documentée avec sa justification.
4. Le seuil de signalement est recalibré.

---

## L10-06 — Test de charge

### Objectif

Connaître le point de saturation avant que le pilote le trouve.

### Fichiers

```
test/load/
├── positions.load.ts
├── selection.load.ts
└── README.md
```

### Spécification

**Scénario 1 — émission de positions.** Nombre croissant de chauffeurs simulés émettant à la fréquence de course. Mesurer : latence d'ingestion, occupation mémoire Redis, charge du service, point de dégradation.

**Scénario 2 — sélections concurrentes.** Nombre croissant de clients sélectionnant simultanément dans un pool restreint. Mesurer la latence de la réservation atomique (L3-06) et vérifier qu'aucune double attribution n'apparaît sous charge — c'est le seul contexte où le défaut de L3-06 se manifesterait.

**Scénario 3 — file d'attente Odoo.** Simuler une indisponibilité d'Odoo pendant que des courses se terminent, vérifier que la file de L3-12 absorbe et rejoue sans perte.

Cibles à définir **avant** la mesure : nombre de chauffeurs simultanés visé au pilote, puis à six mois.

Résultats versionnés, avec le point de saturation identifié et les leviers d'optimisation par ordre de rendement.

### Critères d'acceptation

1. Les trois scénarios sont exécutés.
2. Les cibles étaient définies avant la mesure.
3. Aucune double attribution n'apparaît sous charge.
4. La file absorbe une indisponibilité d'Odoo sans perte.
5. Le point de saturation est identifié et documenté.

---

## L10-07 — Publication en canal fermé

### Objectif

Distribuer les apps aux participants du pilote.

### Fichiers

```
docs/operations/release.md
.github/workflows/release.yml
```

### Spécification

Publication sur Google Play en test fermé, deux applications distinctes.

Fiches de magasin en français, avec captures. Politique de confidentialité publiée sur `https://babana.cm/confidentialite` et accessible sans authentification — obligatoire pour une app qui collecte la localisation en arrière-plan, et fréquemment cause de rejet.

**Liens d'application Android** : `https://babana.cm/.well-known/assetlinks.json` doit déclarer les deux applications avec leurs empreintes de signature. Sans ce fichier, les notifications qui ouvrent l'app sur le bon écran (L7-02) déclencheront un sélecteur d'application au lieu d'ouvrir babana. À vérifier avec l'outil de test des liens d'application avant la première distribution.

**Déclaration de collecte de données** conforme à ce que l'app fait réellement, notamment la localisation en arrière-plan (L6-05). Une déclaration inexacte fait rejeter la mise à jour, souvent au pire moment.

Comptes de test pour les chauffeurs pilotes, procédure d'installation documentée en une page qu'un chauffeur peut suivre seul.

**Taille du paquet — mesurée le 13 août, à corriger ici.** Le premier APK release de l'app Client pèse 51 Mo, dont 45 Mo de binaires natifs répartis sur quatre architectures. Les variantes `x86` et `x86_64` représentent 25 Mo à elles seules et ne servent qu'aux émulateurs : aucun téléphone de chauffeur n'en a l'usage.

Cela contredit frontalement une contrainte posée dès l'architecture — terminaux d'entrée de gamme, forfait de données compté. Cinquante mégaoctets à l'installation, puis autant à chaque mise à jour, est une friction réelle sur le terrain visé.

Deux corrections, l'une couvrant l'autre :

- **Publication en AAB** au Play Store : Google découpe par architecture et le téléchargement effectif tombe autour de 15 à 20 Mo. C'est le format imposé de toute façon.
- **Découpage par architecture des APK distribués à la main**, avant que le compte Play soit validé. À défaut, retirer au minimum `x86` et `x86_64` des variantes de release — elles ne servent qu'au développement.

Mesurer la taille du téléchargement réel, pas celle du fichier de build : c'est la première qui compte pour un chauffeur.

Chaîne de publication automatisée depuis l'intégration continue, avec numérotation de version et notes de version.

Procédure de retour arrière documentée : que faire si une version pose problème en pilote.

### Critères d'acceptation

1. Les deux apps sont publiées en test fermé.
2. La politique de confidentialité est publiée et accessible.
3. La déclaration de collecte correspond au comportement réel.
4. La procédure d'installation tient en une page.
5. La publication est automatisée depuis l'intégration continue.
6. La procédure de retour arrière est documentée.
7. `assetlinks.json` est servi sur l'apex et la vérification des liens d'application passe pour les deux apps.
8. La politique de confidentialité est accessible sans authentification.
9. **Le téléchargement effectif reste sous un seuil défini avant mesure** — les variantes `x86` sont absentes des paquets distribués aux chauffeurs.

---

## L10-08 — Journal de bord du pilote

### Objectif

Faire du pilote une source de décisions, pas d'impressions.

### Contexte

C'est la tâche qui donne sa valeur à tout le reste. Sans elle, les décisions D10, D11 et É1 se reprendront à l'intuition, et le pilote n'aura rien tranché.

### Fichiers

```
docs/pilot/logbook.md
docs/pilot/thresholds.md
services/odoo/addons/babana/views/babana_pilot_dashboard.xml
```

### Spécification

**Indicateurs relevés quotidiennement** :

| Indicateur | Source | Décision qu'il éclaire |
|---|---|---|
| Courses demandées, abouties, abandonnées | L9-09 | — |
| Taux d'abandon par rang de refus | L9-09 | **Réouverture de D11** |
| Courses par chauffeur, taux de sélection quand affiché | L9-08 | **Réouverture de D10** |
| Échecs d'inscription pour absence de Google Play Services | L6-02 | **Réouverture de D4 et É1** |
| Écart moyen d'ETA | L10-03 | Calibration des facteurs |
| Écart moyen de distance | L10-05 | **Choix de la distance facturée** |
| Écarts de caisse, montant et fréquence | L5-06 | Calibration du plafond |
| Consommation batterie remontée par les chauffeurs | L6-17 | Réglage de la capture GPS |
| Latence d'acheminement des notifications | L7-04 | Calibration du délai d'acceptation |
| Courses sans chauffeur disponible, par zone et heure | L3-08 | Dimensionnement de la flotte |

**Seuils de réouverture définis avant la mise en service.** C'est le point essentiel : un seuil défini après avoir vu les chiffres est un seuil qui justifie la décision déjà prise. Chaque seuil est écrit dans `thresholds.md`, daté, avant le premier jour de pilote.

Tableau de bord Odoo dédié regroupant ces indicateurs sur une seule vue.

Rituel de revue hebdomadaire, avec un compte rendu écrit qui statue explicitement sur chaque décision surveillée : maintenue, sous surveillance, à rouvrir.

Recueil qualitatif auprès des chauffeurs et des clients, tenu séparé des indicateurs quantitatifs pour ne pas mélanger les registres.

### Critères d'acceptation

1. Tous les indicateurs du tableau sont relevables automatiquement, sauf le qualitatif.
2. **Les seuils sont écrits et datés avant le premier jour de pilote.**
3. Le tableau de bord regroupe les indicateurs sur une vue.
4. Le compte rendu hebdomadaire statue explicitement sur D10, D11 et É1.
5. Le recueil qualitatif est tenu séparément.
