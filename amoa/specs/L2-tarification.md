# L2 — Tarification

Décision structurante : **D15 — tarif = base + distance × prix au km, majoré par un coefficient de zone et d'heure de pointe. Pas de prix à la minute.** Écarts É8 (itinéraire calculé sur modèle voiture) et É9 (retrait du terme temps).

---

## L2-01 — Modèle `babana.fare.rule`

### Objectif

La grille tarifaire paramétrable.

### Contexte

D15 : **aucun champ de prix à la minute.** Ne pas en ajouter « au cas où » — un champ inutilisé finit toujours par être utilisé par erreur.

### Fichiers

```
services/odoo/addons/babana/models/babana_fare_rule.py
services/odoo/addons/babana/views/babana_fare_rule_views.xml
services/odoo/addons/babana/data/fare_rule_default.xml
services/odoo/addons/babana/tests/test_fare_rule.py
```

### Spécification

Champs :

| Champ | Rôle |
|---|---|
| `name` | Libellé |
| `base_fare` | Prise en charge, en FCFA |
| `price_per_km` | Prix au kilomètre |
| `minimum_fare` | Montant plancher de la course |
| `zone_id` | Zone d'application, vide = toutes |
| `vehicle_class` | `standard`, `premium`, ou vide pour toutes |
| `time_start`, `time_end` | Plage horaire d'application |
| `weekday_mask` | Jours d'application |
| `surge_multiplier` | Coefficient d'heure de pointe |
| `priority` | Départage en cas de règles concurrentes |
| `active_from`, `active_to` | Fenêtre de validité de la règle elle-même |

**Sélection de la règle** : parmi les règles applicables — zone, gamme, horaire, jour, fenêtre de validité — celle de plus forte priorité gagne. En cas d'égalité de priorité, la plus récemment créée. Cette règle de départage doit être déterministe et documentée : deux règles qui se recouvrent sans départage produisent des tarifs aléatoires selon l'ordre de lecture en base.

Une règle de repli sans zone, sans gamme et sans plage horaire est fournie dans `data/`. Il doit toujours exister une règle applicable : une course sans tarif calculable est une panne, pas un cas métier.

**Historisation** : une règle utilisée par une course passée n'est jamais modifiée en place. Modifier un tarif crée une nouvelle version et clôt l'ancienne par `active_to`. C'est ce qui rend une facture ancienne rejouable.

### Critères d'acceptation

1. Aucun champ de prix à la minute n'existe dans le modèle.
2. La sélection de règle est déterministe quand plusieurs règles se recouvrent.
3. Il existe toujours au moins une règle applicable, quelle que soit la position et l'heure.
4. Modifier une règle déjà utilisée crée une version, ne modifie pas l'existante.
5. `minimum_fare` est appliqué : une course très courte ne descend jamais en dessous.

---

## L2-02 — Zones géographiques

### Objectif

Découper la ville en zones et résoudre un point vers sa zone.

### Fichiers

```
services/odoo/addons/babana/models/babana_zone.py
services/odoo/addons/babana/views/babana_zone_views.xml
services/odoo/addons/babana/tests/test_zone.py
```

### Spécification

Modèle `babana.zone` : nom, polygone en GeoJSON, priorité, actif.

Résolution d'un point : parmi les zones contenant le point, celle de plus forte priorité. Aucune zone ne contient le point : renvoyer la zone par défaut, pas une erreur.

Les zones peuvent se chevaucher — c'est voulu, une zone « centre-ville aux heures de pointe » peut recouvrir une zone plus large. La priorité tranche.

Implémenter le test d'appartenance en Python, sans dépendance PostGIS : le volume de zones au pilote est faible, et ajouter PostGIS complique le déploiement pour un bénéfice nul à cette échelle. Le documenter comme une décision réversible si le nombre de zones croît fortement.

### Critères d'acceptation

1. Un point dans une zone unique renvoie cette zone.
2. Un point dans deux zones renvoie celle de plus forte priorité.
3. Un point hors de toute zone renvoie la zone par défaut.
4. Un point exactement sur une frontière est traité de manière déterministe, et le comportement est documenté.

---

## L2-03 — Moteur de cotation

### Objectif

Calculer un montant à partir d'un départ, d'une arrivée et d'une distance de référence.

### Contexte

**Le moteur de cotation doit être une fonction pure.** C'est ce qui permet de le tester exhaustivement et de rejouer un litige tarifaire à l'identique six mois plus tard. Une cotation qui lit l'heure système ou l'état de la base à l'intérieur du calcul n'est pas rejouable.

### Fichiers

```
services/odoo/addons/babana/services/pricing.py
services/odoo/addons/babana/tests/test_pricing.py
```

### Spécification

Signature conceptuelle : `compute_fare(rule, distance_m, promotion, context) -> FareBreakdown`.

Toutes les entrées sont passées en paramètre — la règle, la distance, l'horodatage, la zone, la gamme. **Aucune lecture de `datetime.now()` ni de la base à l'intérieur de la fonction.**

Calcul, dans cet ordre :

1. `base_fare + (distance_km × price_per_km)`
2. Application de `surge_multiplier`
3. Application de la promotion éventuelle (L2-06)
4. Application de `minimum_fare` — **après** la promotion : une promotion ne fait pas descendre sous le plancher
5. Arrondi FCFA

Le résultat est un détail décomposé, pas un simple montant : base, part distance, coefficient appliqué, remise, plancher appliqué ou non, total. Ce détail est stocké sur la course et affiché au client. Un montant sans décomposition est indéfendable en cas de contestation.

**Arrondi** : le FCFA n'a pas de subdivision en circulation et les petites coupures sont rares. Arrondir au multiple supérieur d'un pas configurable — 25 ou 50 FCFA — plutôt qu'à l'unité. Le pas est un paramètre de configuration, pas une constante.

### Critères d'acceptation

1. La fonction est pure : appelée deux fois avec les mêmes entrées, elle renvoie exactement le même résultat.
2. Aucun appel à l'horloge ni à la base à l'intérieur.
3. Le plancher s'applique après la promotion.
4. Le détail décomposé est complet et sa somme égale le total.
5. L'arrondi suit le pas configuré.
6. Une distance nulle produit `max(base_fare, minimum_fare)`, pas une erreur.

---

## L2-04 — Endpoint de cotation

### Objectif

`POST /api/v1/quote` — l'estimation affichée avant validation.

### Contexte

CDC §II.2 et §I.3 : le prix doit être affiché **avant** la course. É8 : la durée annoncée vient d'un modèle voiture et doit être corrigée (L10-03).

### Fichiers

```
services/odoo/addons/babana/controllers/quote.py
services/odoo/addons/babana/models/babana_quote.py
services/odoo/addons/babana/tests/test_quote_controller.py
```

### Spécification

Requête : départ, arrivée, gamme souhaitée, code promo éventuel.

Traitement : résoudre les zones, sélectionner la règle, obtenir la distance de référence (L2-05), calculer (L2-03), appliquer le facteur de correction d'ETA (L10-03).

Réponse : identifiant d'estimation, montant, détail décomposé, distance, durée estimée corrigée, date d'expiration.

**L'estimation est persistée** avec son identifiant. La création de course (L4-03) référence cet identifiant plutôt que de recalculer : c'est ce qui garantit que le client paie ce qu'on lui a montré. Une estimation expirée est refusée avec `QUOTE_EXPIRED`.

Durée de validité configurable, de l'ordre de quelques minutes. Sans expiration, un client peut faire estimer aux heures creuses et commander aux heures de pointe.

L'estimation stocke la règle tarifaire appliquée, pas seulement son identifiant : si la règle change entre l'estimation et la course, le tarif montré reste opposable.

### Critères d'acceptation

1. Deux estimations identiques dans la même minute renvoient le même montant.
2. Une estimation expirée est refusée à la création de course.
3. La durée renvoyée est la durée corrigée, pas la durée brute du routeur.
4. La réponse contient le détail décomposé complet.
5. Un code promo invalide n'échoue pas la cotation : il renvoie l'estimation sans remise, avec un indicateur explicite.

---

## L2-05 — Distance de référence et cache

### Objectif

Obtenir la distance d'itinéraire auprès de Google, avec cache.

### Contexte

**É8 — la distance et la durée renvoyées sont calculées sur un modèle voiture.** Google n'active pas le routage deux-roues au Cameroun, Mapbox n'en propose dans aucun pays. C'est assumé et documenté.

### Fichiers

```
services/odoo/addons/babana/services/routing.py
services/odoo/addons/babana/models/babana_route_cache.py
services/odoo/addons/babana/tests/test_routing.py
```

### Spécification

Appel à l'API de routage Google pour un couple de points. Retour : distance en mètres, durée en secondes, tracé.

**Un commentaire explicite au point de calcul** rappelle É8 : la distance est celle d'un itinéraire voiture, et ce choix est délibéré parce qu'il est reproductible. Sans ce commentaire, quelqu'un « corrigera » plus tard en sommant les points GPS et cassera la reproductibilité des factures.

Cache : clé formée des coordonnées arrondies à une grille de l'ordre de cent mètres, de la gamme et de la tranche horaire. Durée de vie de quelques heures. Le cache réduit le coût et la latence, et il rend deux estimations proches cohérentes entre elles — ce qui compte autant que l'économie.

**Comportement en cas d'indisponibilité de l'API** : ne pas échouer silencieusement ni renvoyer une distance à vol d'oiseau sans le dire. Renvoyer une erreur explicite. Une estimation fausse est pire qu'une absence d'estimation — elle produit une facture indéfendable.

Plafond de quota configurable, avec alerte quand il approche.

### Critères d'acceptation

1. Deux appels identiques ne produisent qu'une requête sortante.
2. Le cache expire.
3. L'indisponibilité de l'API produit une erreur explicite, jamais une estimation dégradée silencieuse.
4. Le commentaire sur É8 est présent au point de calcul.
5. Les tests n'appellent jamais l'API réelle : elle est simulée.

---

## L2-06 — Promotions

### Objectif

Codes promo et campagnes (CDC §V.3).

### Fichiers

```
services/odoo/addons/babana/models/babana_promotion.py
services/odoo/addons/babana/views/babana_promotion_views.xml
services/odoo/addons/babana/tests/test_promotion.py
```

### Spécification

Champs : code (unique, insensible à la casse), type (`percentage` ou `fixed_amount`), valeur, remise maximale, montant minimum de course, période de validité, nombre d'usages total, nombre d'usages par client, réservé aux nouveaux clients, zones et gammes éligibles.

Modèle `babana.promotion.usage` : promotion, client, course, montant remisé. C'est ce qui permet de compter les usages et d'auditer une campagne.

**Le compteur d'usages doit être incrémenté de façon atomique** au moment de l'application définitive, pas à l'estimation. Sinon une promotion limitée à cent usages en produira davantage sous charge — deux clients qui estiment en même temps passeraient tous les deux le contrôle.

L'application à l'estimation est indicative ; l'application définitive a lieu à la création de la course.

### Critères d'acceptation

1. Un code invalide, expiré ou épuisé n'échoue pas la cotation, il renvoie l'estimation sans remise avec un indicateur.
2. La limite par client est respectée.
3. La limite globale est respectée sous accès concurrent — test de concurrence obligatoire.
4. La remise maximale plafonne une remise en pourcentage.
5. Une promotion réservée aux nouveaux clients est refusée à un client ayant déjà une course.

---

## L2-07 — Jeu de tests de cotation

### Objectif

Couvrir exhaustivement le calcul tarifaire.

### Fichiers

```
services/odoo/addons/babana/tests/test_pricing_scenarios.py
services/odoo/addons/babana/tests/fixtures/fare_scenarios.json
```

### Spécification

Les scénarios sont décrits dans un fichier de données, pas dans le code : ils doivent être lisibles et modifiables par quelqu'un qui ne lit pas Python. Chaque scénario donne les entrées et le montant attendu.

Couvrir au minimum :

- Course nominale en zone standard, heure creuse
- Course en heure de pointe, coefficient appliqué
- Course franchissant une frontière de zone — la zone de **départ** détermine la règle, et ce choix doit être documenté
- Course très courte, plancher appliqué
- Course avec promotion en pourcentage, puis en montant fixe
- Promotion portant le montant sous le plancher — le plancher gagne
- Bascule exacte à la minute de début et de fin d'une plage horaire
- Deux règles concurrentes de priorités différentes
- Deux règles concurrentes de priorités égales
- Gamme premium contre standard
- Arrondi : montants juste au-dessus et juste en dessous d'un pas
- Distance nulle

### Critères d'acceptation

1. Les scénarios sont dans un fichier de données lisible.
2. Chaque cas de la liste est couvert.
3. Ajouter un scénario ne demande pas de modifier le code de test.
4. Un changement du moteur de cotation qui casserait un montant fait échouer la suite.
