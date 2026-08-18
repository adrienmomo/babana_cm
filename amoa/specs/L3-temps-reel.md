# L3 — Service temps réel

Décisions structurantes : D3 (service dédié), D10 (le client choisit), D11 (refus sans attribution automatique), D14 (5 chauffeurs les plus proches), D16 (TypeScript).

**Invariant du lot** : le service ne possède aucune donnée durable et n'écrit jamais dans PostgreSQL. S'il tombe, on perd les positions de l'instant — jamais une course confirmée ni un franc.

---

## L3-01 — Authentification des connexions WebSocket

### Objectif

N'accepter que des connexions porteuses d'un jeton applicatif valide, et distinguer client de chauffeur.

### Fichiers

```
services/realtime/src/ws/auth.ts
services/realtime/src/ws/connection.ts
services/realtime/test/auth.test.ts
```

### Spécification

Le jeton est présenté à l'établissement de la connexion. Validation **locale**, avec le secret partagé — aucun appel à Odoo, qui ne passerait pas à l'échelle avec une connexion par chauffeur.

Les claims lus sont ceux de `AccessTokenClaimsSchema` (C-01, D23) — `sub`, `role`, `driverId`, `exp`. **Le service ne redéclare pas cette forme** : il l'importe. C'est le même jeton, émis par L1-02, et il n'y a qu'une seule définition.

La connexion porte ensuite un contexte immuable : identifiant utilisateur, rôle, identifiant du chauffeur le cas échéant. Ce contexte est la seule source d'autorisation pour tous les messages suivants.

**L'identité de l'émetteur se lit dans la connexion, jamais dans le message.** Formulation corrigée le 15 août : la rédaction précédente prenait pour exemple un message `position.update` portant un identifiant de chauffeur à comparer, alors qu'aucun message client-vers-serveur de C-02 ne porte d'identifiant d'émetteur — la propriété était invérifiable telle qu'écrite. La règle qui compte est plus forte que la comparaison qu'elle remplace : le serveur ne lit jamais une identité dans une charge utile entrante. Un message dont le traitement a besoin de savoir qui l'envoie prend cette information du contexte de connexion. Si une tâche ultérieure donne malgré tout un champ d'identité à un message, ce champ est ignoré ou le message rejeté — jamais honoré.

Une connexion dont le jeton expire en cours de vie est fermée avec un code explicite. L'app renouvelle et se reconnecte. Le minuteur qui porte cette fermeture est **borné à la valeur maximale de `setTimeout`** (2³¹−1 ms, environ 24,8 jours) : au-delà, Node déclenche immédiatement, et une durée de vie de jeton mal choisie fermerait toutes les connexions à l'instant même de leur ouverture.

Registre en mémoire des connexions actives, indexé par rôle et identifiant, pour permettre l'émission ciblée.

### Critères d'acceptation

1. Une connexion sans jeton est refusée.
2. Une connexion avec un jeton expiré est refusée avec un code documenté, distinct de celui d'un jeton invalide.
3. **Aucun chemin de code ne dérive une identité d'une charge utile entrante** : l'identité vient du contexte de connexion, et seulement de lui.
4. La validation ne déclenche aucun appel sortant vers Odoo.
5. Un jeton qui expire en cours de connexion la ferme.
6. **Un jeton réellement émis par `/auth/google` est accepté** — pas seulement un jeton fabriqué par le test. Ce critère est celui qui a manqué : les deux services étaient verts en désaccord complet sur la forme du jeton.

---

## L3-02 — Ingestion des positions

### Objectif

Recevoir, valider et stocker les positions chauffeur dans Redis.

### Fichiers

```
services/realtime/src/tracking/ingest.ts
services/realtime/src/tracking/validation.ts
services/realtime/src/redis/positions.ts
services/realtime/test/ingest.test.ts
```

### Spécification

Message `position.update` : latitude, longitude, précision, vitesse, cap, horodatage de capture.

**Validation de plausibilité, avant écriture** :

- Coordonnées dans les bornes valides, et dans une zone d'exploitation configurable
- Précision meilleure qu'un seuil configurable — une position à cinq cents mètres près pollue le géo-index
- Horodatage ni dans le futur, ni trop ancien
- Vitesse implicite depuis la position précédente sous un seuil — une moto qui parcourt vingt kilomètres en dix secondes est un artefact GPS, pas un déplacement

Une position rejetée est comptée dans une métrique et ignorée, sans fermer la connexion : les rejets sont normaux en zone dense, ce sont leur volume et leur évolution qui informent.

Stockage Redis avec durée de vie courte, de l'ordre de la minute. Une position qui expire fait sortir le chauffeur du pool disponible — c'est le mécanisme naturel de détection d'un chauffeur déconnecté, préférable à une détection explicite qui peut échouer.

### Critères d'acceptation

1. Une position valide est stockée et le chauffeur reste disponible.
2. Chaque règle de plausibilité est testée individuellement.
3. Une position rejetée n'interrompt pas la connexion.
4. À l'expiration de la durée de vie sans nouvelle position, le chauffeur sort du pool.
5. Le taux de rejet est exposé en métrique.

---

## L3-03 — Géo-index des chauffeurs disponibles

### Objectif

Trouver les N chauffeurs disponibles les plus proches d'un point.

### Fichiers

```
services/realtime/src/redis/geo-index.ts
services/realtime/test/geo-index.test.ts
```

### Spécification

Index géospatial Redis contenant **uniquement** les chauffeurs disponibles : en ligne, approuvés, sans course en cours, sous leur plafond d'encaisse.

Entrée dans l'index : passage en ligne. Sortie : passage hors ligne, acceptation d'une course, réservation en cours (L3-06), plafond d'encaisse atteint, expiration de la position.

Requête par rayon avec limite de résultats, triée par distance croissante.

La distance renvoyée est une distance à vol d'oiseau. C'est acceptable pour ordonner cinq chauffeurs proches, et un appel de routage par chauffeur serait prohibitif. Le documenter : ce qui est affiché au client doit être présenté comme une proximité, pas comme un temps d'arrivée précis.

### Critères d'acceptation

1. Un chauffeur en ligne apparaît dans l'index, hors ligne il en sort.
2. Un chauffeur en course n'apparaît jamais.
3. Un chauffeur au plafond d'encaisse n'apparaît jamais.
4. Les résultats sont triés par distance croissante.
5. Un rayon sans chauffeur renvoie une liste vide, pas une erreur.

---

## L3-04 — Bascule en ligne / hors ligne

### Objectif

Le chauffeur se rend disponible ou non (D7).

### Fichiers

```
services/realtime/src/driver/availability.ts
services/odoo/addons/babana/controllers/driver.py
services/realtime/test/availability.test.ts
```

### Spécification

Le passage en ligne est **contrôlé côté Odoo**, source de vérité : chauffeur approuvé, moto affectée, assurance valide, permis valide, plafond d'encaisse non atteint. Chaque refus renvoie un motif distinct — un chauffeur qui ne comprend pas pourquoi il ne peut pas travailler appelle le support.

Le service temps réel reçoit l'autorisation et insère le chauffeur dans le géo-index. Il ne décide pas de l'éligibilité, il l'applique.

Le passage hors ligne est immédiat et inconditionnel, **sauf en course** : un chauffeur en course ne peut pas se mettre hors ligne, il doit d'abord terminer ou annuler. Sinon le passager se retrouve sans suivi ni chauffeur.

Une déconnexion réseau ne met pas hors ligne immédiatement : période de grâce configurable, puis sortie du pool par expiration de la position (L3-02).

### Critères d'acceptation

1. Chaque condition de refus est testée et renvoie un motif distinct.
2. Un chauffeur en course ne peut pas se mettre hors ligne.
3. La déconnexion réseau applique la période de grâce avant sortie du pool.
4. Le passage au plafond d'encaisse met hors ligne automatiquement.

---

## L3-05 — Les 5 chauffeurs les plus proches

### Objectif

Alimenter l'écran de sélection du client (D14).

### Contexte

**C2b — la flotte devient publiquement observable.** Chaque garde-fou de cette tâche est une mesure de sécurité, pas une optimisation.

### Fichiers

```
services/realtime/src/nearby/handler.ts
services/realtime/src/nearby/projection.ts
services/realtime/test/nearby.test.ts
```

### Spécification

Sur `nearby.subscribe`, renvoyer les 5 chauffeurs disponibles les plus proches, puis diffuser les mises à jour tant que l'abonnement est actif.

**Garde-fous, tous obligatoires** :

| Garde-fou | Raison |
|---|---|
| Rayon plafonné à une valeur configurée, quelle que soit la valeur demandée | Empêche le balayage de la ville |
| Nombre de résultats plafonné à 5, non négociable par le client | D14, et limite l'exposition |
| Position arrondie à la précision définie en C-02 | Empêche le suivi individuel |
| Limitation de débit par utilisateur | Empêche l'échantillonnage rapide |
| Charge utile minimale : prénom, photo, note, gamme, distance approximative | Aucune donnée identifiante au-delà |
| Un seul abonnement actif par client | Empêche le balayage par abonnements multiples |

La projection est implémentée comme une **liste blanche de champs**, jamais comme une exclusion : une liste noire laisse passer tout champ ajouté plus tard.

**Un profil manquant dégrade l'affichage, jamais la disponibilité** (D30, ajouté le 17 août). La première rédaction faisait omettre un chauffeur dont le profil n'était pas en cache, au nom du principe — juste — qu'on n'invente jamais un prénom. La conséquence a été découverte en câblant : aucun chauffeur réel ne portait de profil, donc la liste était systématiquement vide, donc **aucune course ne pouvait aboutir**. Ce n'était pas un cas limite, c'était un blocage total.

Le principe reste, la conclusion change. Le chauffeur est renvoyé avec ce qu'on sait — distance, position, gamme si connue — et les champs de profil à `null`. L'application affiche un avatar générique et un libellé neutre. Ce n'est pas inventer une donnée, c'est avouer son absence.

Ce qui compte au-delà de ce cas : **un défaut de cache ne doit jamais retirer un chauffeur de la flotte.** C'est la même famille de panne que le marqueur d'engagement resté en place — un état technique qui rend quelqu'un invisible sans que rien ne le signale. Chaque fois qu'une donnée manquante peut faire disparaître un chauffeur plutôt que dégrader son affichage, c'est la disparition qu'il faut refuser.

`NearbyDriverSchema` (C-01) rend donc `firstName`, `photoUrl`, `rating` et `motorcycleClass` nullables. Un chauffeur écarté faute de position, en revanche, reste écarté : sans position, il n'y a pas de distance, et la liste des plus proches n'a plus de sens.

**Cinq résultats, vraiment cinq** (ajouté le 16 août). L3-03 filtre les chauffeurs dont la position a expiré au moment de la requête, en sur-échantillonnant d'un facteur fixe pour absorber ce filtrage. Cela suppose qu'au plus une fraction du pool soit périmée — vrai en régime normal, faux après une coupure réseau généralisée, qui est le cas courant à Douala. Cette tâche doit donc **compléter jusqu'à cinq**, par élargissement ou par nouvelle requête, plutôt que de renvoyer deux chauffeurs parce que le sur-échantillonnage n'a pas suffi. Un client qui voit deux chauffeurs au lieu de cinq croit que la ville est vide.

**Un abonnement refusé le dit (ajouté le 23 août).** La limitation de débit ignore aujourd'hui l'abonnement en trop, sans rien renvoyer. Côté application, rien ne distingue alors « il n'y a aucun chauffeur près de vous » de « votre demande n'a pas été prise en compte » — et un client qui insiste sur un bouton « Réessayer » peut cesser d'être servi sans qu'aucun élément de l'écran ne le lui indique. Un silence est le pire retour possible pour une limitation de débit : il pousse exactement au comportement qui l'aggrave.

C-02 gagne donc un accusé de réception pour `nearby.subscribe` — accepté, ou refusé avec un délai avant nouvelle tentative.

### Critères d'acceptation

1. Un rayon demandé supérieur au plafond est ramené au plafond, sans erreur.
2. Plus de 5 chauffeurs disponibles : exactement 5 sont renvoyés, les plus proches. **Y compris quand une large part du pool porte des positions expirées** — le filtrage ne doit jamais réduire silencieusement la liste.
3. Les positions renvoyées sont arrondies.
4. La charge utile ne contient ni nom complet, ni téléphone, ni immatriculation — test explicite.
5. Un second abonnement du même client remplace le premier.
6. La limitation de débit est appliquée et testée.

### Piège

Renvoyer l'objet chauffeur complet parce que c'est plus simple est la faute naturelle ici. Le test du point 4 doit vérifier l'**absence** des champs interdits, pas seulement la présence des champs attendus.

---

## L3-06 — Réservation atomique du chauffeur

### Objectif

Quand un client sélectionne un chauffeur, le retirer du pool et créer la proposition **en une opération indivisible**.

### Contexte

**La tâche la plus risquée du projet.** Une implémentation en deux temps — lire l'état puis écrire — laisse une fenêtre de course qui produit deux gagnants. Le bug est intermittent, invisible en test unitaire, et se manifeste en production sous charge.

### Fichiers

```
services/realtime/src/reservation/reserve.ts
services/realtime/src/reservation/reserve.lua
services/realtime/test/reservation.test.ts
```

### Spécification

Implémenter la réservation comme un **script Lua exécuté par Redis**. Redis exécute un script de façon atomique : c'est ce qui rend l'opération indivisible sans verrou distribué.

Le script, en une exécution :

1. Vérifie que le chauffeur est présent dans le pool disponible
2. S'il n'y est pas, renvoie un échec
3. S'il y est, le retire du pool, crée l'entrée de réservation avec son délai d'expiration, et renvoie un succès

Aucune logique conditionnelle ne doit rester en TypeScript entre la lecture et l'écriture. Si vous écrivez `if (await isAvailable(id)) { await reserve(id) }`, la tâche est ratée.

L'échec renvoie `DRIVER_ALREADY_TAKEN` au client, qui revient à la sélection.

La réservation porte une expiration : si le chauffeur ne répond pas dans le délai, elle est libérée et le chauffeur réintègre le pool (L3-07).

Après réservation réussie, appeler Odoo pour la transition `requested → proposed`. **Si cet appel échoue, la réservation doit être libérée** — sinon un chauffeur reste bloqué hors du pool sans course correspondante.

### Ce n'est pas la réservation qu'il faut rendre atomique, c'est le pool (D26)

**Ajouté le 16 août, après relecture d'une première implémentation dont le script Lua était pourtant irréprochable.** Retirer un chauffeur du pool de façon indivisible ne sert à rien si un autre chemin l'y remet sans rien savoir de la réservation. C'est exactement ce qui se passait : `ingestPosition` (L3-02) rappelle `addToPool` à **chaque** position acceptée d'un chauffeur en ligne. Un chauffeur réservé revenait donc dans le pool à sa position suivante — quelques secondes — et un second client pouvait le réserver. La fenêtre n'était pas microscopique, elle était permanente. Le test de concurrence ne la voyait pas parce qu'il n'émet aucune position pendant la réservation.

**La règle**, et elle vaut au-delà de cette tâche : **toute écriture sur le pool passe par un seul script atomique**, qui porte l'unique définition de l'éligibilité. Un chauffeur entre dans le pool si et seulement si, dans la même exécution : il est marqué en ligne, il n'a pas de réservation active, et il n'est pas engagé sur une course. Aucun appelant ne fait de `GEOADD` direct — ni l'ingestion de position, ni la bascule en ligne, ni le relâchement.

**L'engagement est un état distinct de la réservation.** La réservation a une expiration courte, parce qu'un chauffeur qui ne répond pas doit être libéré. Une course, elle, n'a pas de durée prévisible — un embouteillage à Douala ne doit pas remettre au pool un chauffeur qui transporte un client. L'acceptation (L3-07) **remplace** donc la réservation par un marqueur d'engagement **sans expiration**, effacé à la fin de course. Sans lui, la réservation expirait en pleine course et le veilleur d'expiration remettait le chauffeur dans le pool, disponible, avec un passager derrière.

### Critères d'acceptation

1. La décision et l'écriture sont dans le même script Lua. Aucun `if` entre une lecture et une écriture en TypeScript.
2. **Test de concurrence** : N tentatives simultanées sur le même chauffeur produisent exactement un succès et N−1 `DRIVER_ALREADY_TAKEN` (voir L3-13).
3. Un chauffeur réservé n'apparaît plus dans `nearby.drivers`.
3 bis. **Un chauffeur réservé qui continue d'émettre des positions ne revient jamais dans le pool.** Le test émet des positions pendant la réservation — sans quoi il ne prouve rien.
3 ter. **Un chauffeur engagé sur une course ne revient jamais dans le pool**, quelle que soit la durée de la course et quoi qu'il émette.
4. L'échec de l'appel Odoo libère la réservation.
5. La réservation expire et libère le chauffeur — **et l'engagement, lui, n'expire jamais tout seul.**
6. **Aucun appel à `GEOADD` sur la clé du pool ne subsiste hors du script d'éligibilité**, dans tout le service. Vérifiable par recherche : c'est le genre de règle qu'une revue oublie et qu'un `grep` n'oublie pas.
6 bis. **Aucune fonction de code source n'écrit dans le pool sans passer par le script** — précision du 17 août. Une première implémentation gardait un `addToPool` inconditionnel exporté depuis `src/`, réservé par convention aux fixtures de test. La recherche du critère 6 ne l'attrapait pas, puisque `addToPool` ne contient pas la chaîne `geoadd` : un appelant de production aurait contourné la garantie en toute discrétion. Une aide de test vit dans les tests. Une règle de lint avec un trou documenté est pire qu'aucune règle, parce qu'elle donne confiance.

---

## L3-07 — Cycle de proposition

### Objectif

Proposer la course au chauffeur, gérer acceptation, refus et expiration.

### Fichiers

```
services/realtime/src/proposal/lifecycle.ts
services/realtime/src/proposal/timeout.ts
services/realtime/test/proposal.test.ts
```

### Spécification

Après réservation, émettre `proposal.new` au chauffeur : départ, arrivée, montant, distance, délai restant. Si le chauffeur n'est pas connecté, déclencher aussi une notification push (L7-04).

**Délai d'acceptation configurable** (valeur par défaut 30 secondes, L9-06). Trois issues :

- **Acceptation** — transition `proposed → assigned` dans Odoo. **Le marqueur d'engagement remplace la réservation** (D26) : sans expiration, effacé à la fin de course. « Le chauffeur reste hors du pool » n'était pas une conséquence automatique — la réservation expirait en pleine course et le remettait au pool, avec un passager derrière. Le suivi démarre (L3-09).
- **Refus explicite** — transition `proposed → rejected`, le chauffeur réintègre le pool, le client revient à la sélection (D11).
- **Expiration** — même effet qu'un refus, avec un motif distinct. La distinction compte : un chauffeur qui refuse explicitement et un chauffeur qui ne répond pas ne posent pas le même problème opérationnel.

**Idempotence** : une acceptation qui arrive après l'expiration doit échouer proprement, pas créer une course fantôme. C'est le cas de course le plus probable ici, parce que le réseau est lent — le chauffeur appuie à temps, le message arrive en retard.

Le compte à rebours affiché côté chauffeur est **indicatif** ; le serveur est seul juge de l'expiration.

### Critères d'acceptation

1. L'acceptation dans le délai produit `assigned`.
2. Le refus explicite libère le chauffeur et notifie le client, avec un motif distinct de l'expiration.
3. L'expiration libère le chauffeur.
4. Une acceptation arrivant après l'expiration échoue proprement.
5. Une double acceptation ne produit qu'une transition.
6. Le délai est lu depuis la configuration, pas codé en dur.

---

## L3-08 — Élargissement du rayon

### Objectif

Proposer d'autres chauffeurs quand aucun ne convient.

### Contexte

D11 : pas d'attribution automatique. Le client garde la main, on lui donne simplement d'autres candidats.

### Fichiers

```
services/realtime/src/nearby/expand.ts
services/realtime/test/expand.test.ts
```

### Spécification

Déclenchement : les 5 proposés ont tous refusé ou expiré, ou aucun chauffeur n'est disponible dans le rayon initial.

Élargir le rayon par paliers configurables jusqu'à un maximum, et renvoyer une nouvelle liste de 5 **excluant ceux qui ont déjà refusé sur cette course**. Reproposer un chauffeur qui vient de refuser est une mauvaise expérience des deux côtés.

Au maximum du rayon sans candidat : renvoyer `NO_DRIVER_AVAILABLE`. Le client décide de réessayer ; on ne le met pas en file d'attente, ce n'est pas dans le périmètre v1.

Compter les élargissements et les échecs par zone et par tranche horaire : c'est la donnée qui dira si la flotte est sous-dimensionnée ou mal répartie.

### Critères d'acceptation

1. Après cinq refus, une nouvelle liste est proposée sans les refusants.
2. Le rayon s'élargit par paliers jusqu'au maximum.
3. Au maximum sans candidat, `NO_DRIVER_AVAILABLE` est renvoyé.
4. Les élargissements et échecs sont comptés par zone et tranche horaire.

---

## L3-09 — Diffusion du suivi

### Objectif

Le client voit la position de son chauffeur, pendant l'approche puis pendant la course.

### Fichiers

```
services/realtime/src/tracking/broadcast.ts
services/realtime/test/broadcast.test.ts
```

### Spécification

Après affectation, le client abonné reçoit `driver.position` à une fréquence configurable — plus faible que la fréquence d'ingestion, pour ne pas saturer le réseau du client.

Pendant le suivi, la position est diffusée **en précision réelle** : le client a le droit de savoir où est le chauffeur qui vient le chercher. L'arrondi de L3-05 ne s'applique qu'à la découverte, pas au suivi d'une course affectée.

Diffuser aussi l'ETA d'approche, recalculé périodiquement.

Le suivi s'arrête à la fin de la course. Un client ne suit jamais un chauffeur avec qui il n'a pas de course en cours — vérifié à chaque diffusion, pas seulement à l'abonnement.

Le contact avec qui le trajet est partagé (L8-03) reçoit le même flux, par un canal distinct.

### Critères d'acceptation

1. Le client affecté reçoit les positions, à la fréquence configurée.
2. Un client non affecté à cette course ne reçoit rien — test explicite.
3. La position diffusée en suivi est en précision réelle, contrairement à L3-05.
4. Le suivi cesse à la fin de la course.
5. La fréquence de diffusion est indépendante de la fréquence d'ingestion.

---

## L3-10 — Accumulation distance et durée

### Objectif

Mesurer la course pendant qu'elle se déroule.

### Contexte

Ces valeurs servent au contrôle et à la calibration, **pas au tarif** : D15 retire le terme temps, et la distance facturée est celle de l'itinéraire de référence (L2-05). Ce qui est mesuré ici sert à détecter les écarts et à alimenter L10-03.

### Fichiers

```
services/realtime/src/tracking/accumulator.ts
services/realtime/test/accumulator.test.ts
```

### Spécification

Depuis `ride.start`, accumuler dans Redis : distance parcourue par sommation des segments entre positions valides, durée écoulée, tracé simplifié.

Filtrer avant d'accumuler : les positions rejetées par L3-02 ne comptent pas, et un segment sous un seuil de quelques mètres est ignoré — le bruit GPS à l'arrêt ferait grimper la distance sans que la moto bouge.

Simplifier le tracé au fil de l'eau pour éviter de stocker des milliers de points.

À la fin de course, transmettre à Odoo : distance parcourue, durée écoulée, tracé. Odoo compare la distance parcourue à la distance de référence et enregistre l'écart (L4-04).

### Critères d'acceptation

1. Une moto à l'arrêt avec du bruit GPS n'accumule pas de distance.
2. Les positions rejetées ne sont pas accumulées.
3. Le tracé simplifié conserve la forme du trajet.
4. Une coupure suivie d'une reconnexion ne perd pas l'accumulation en cours (voir L3-14).

---

## L3-11 — Reconnexion et rattrapage d'état

### Objectif

Une coupure réseau ne fait rien perdre.

### Contexte

Le réseau intermittent à Douala n'est pas un cas limite, c'est le cas courant.

### Fichiers

```
packages/api-client/src/realtime/reconnect.ts
services/realtime/src/ws/resync.ts
services/realtime/test/resync.test.ts
```

### Spécification

Côté app : reconnexion avec temporisation croissante et **gigue aléatoire** — sans elle, mille chauffeurs se reconnectent en même temps après une coupure d'antenne et achèvent le serveur.

À la reconnexion, l'app envoie son dernier état connu. Le serveur répond par un **état complet**, pas par un différentiel : reconstituer un différentiel après coupure est une source d'erreurs, et l'état complet est petit.

Les actions émises hors connexion sont mises en file locale et rejouées dans l'ordre, avec leur identifiant d'origine. Le serveur déduplique par cet identifiant.

Les positions ne sont **pas** rejouées : une position obsolète est pire que pas de position. Seule la dernière est envoyée.

Les actions métier — acceptation, démarrage, fin de course — sont rejouées, elles. Le serveur les traite avec le contrôle d'idempotence de L3-07.

### Critères d'acceptation

1. La reconnexion applique temporisation croissante et gigue.
2. La resynchronisation renvoie un état complet.
3. Une action émise hors connexion est rejouée à la reconnexion.
4. Une action rejouée deux fois ne produit qu'un effet.
5. Les positions obsolètes ne sont pas rejouées.

---

## L3-12 — Appels sortants vers Odoo

### Objectif

Matérialiser la règle de partition : les écritures Odoo sont déclenchées par des événements métier, jamais par le temps.

### Contexte

**C'est ici que la règle de partition se matérialise ou se perd.** Toute tentation d'écrire dans Odoo à un cinquième moment doit être refusée et remontée comme une question d'architecture.

### Fichiers

```
services/realtime/src/odoo/client.ts
services/realtime/src/odoo/outbox.ts
services/realtime/test/outbox.test.ts
```

### Spécification

Quatre appels, et seulement quatre :

1. Création de la demande — en réalité déclenchée par l'app cliente vers Odoo directement
2. Affectation, après acceptation du chauffeur
3. Fin de course, avec distance, durée et tracé consolidés
4. Encaissement — déclenché par l'app chauffeur vers Odoo directement

Le service temps réel porte donc les appels 2 et 3.

**File d'attente persistante avec rejeu** : si Odoo est indisponible au moment de l'appel, l'événement est mis en file et rejoué avec temporisation croissante. La file survit à un redémarrage du service — c'est la seule donnée que le service persiste, et elle ne contredit pas l'invariant : ce n'est pas un état métier, c'est une intention d'écriture en attente.

Chaque appel porte un identifiant d'idempotence. Odoo rejette silencieusement un identifiant déjà traité.

Alerte si la file dépasse un seuil ou si un événement échoue au-delà d'un nombre de tentatives : une file qui grossit signifie que des courses ne s'enregistrent pas.

### Critères d'acceptation

1. Exactement quatre types d'écriture existent. Un test recense les appels sortants et échoue si un cinquième apparaît.
2. Odoo indisponible : l'événement est mis en file et rejoué au retour.
3. La file survit au redémarrage du service.
4. Un appel rejoué avec le même identifiant ne produit qu'une écriture.
5. Une file au-dessus du seuil déclenche une alerte.

---

## L3-13 — Test de concurrence sur la réservation

### Objectif

Prouver que L3-06 est correcte.

### Contexte

**Cette tâche n'est pas optionnelle.** C'est la seule preuve que la réservation atomique fonctionne. Un test unitaire séquentiel ne prouve rien ici.

### Fichiers

```
services/realtime/test/concurrency/reservation.test.ts
```

### Spécification

Lancer N tentatives de réservation **réellement simultanées** sur le même chauffeur, contre un Redis réel — pas un double en mémoire, qui ne reproduirait pas les conditions de course.

Répéter le scénario un grand nombre de fois : une fenêtre de course étroite ne se manifeste pas au premier essai.

Vérifier à chaque itération : exactement un succès, N−1 échecs `DRIVER_ALREADY_TAKEN`, et l'état Redis cohérent — une seule réservation, chauffeur absent du pool.

Ajouter un scénario mixte : réservations concurrentes pendant que d'autres chauffeurs entrent et sortent du pool.

### Critères d'acceptation

1. Le test s'exécute contre un Redis réel.
2. Sur toutes les itérations, exactement un succès à chaque fois.
3. L'état Redis final est cohérent à chaque itération.
4. Le test tourne en intégration continue.
5. Une implémentation volontairement naïve — lecture puis écriture — fait échouer le test. À vérifier une fois, pour prouver que le test détecte bien le défaut.

### Piège

Le point 5 est ce qui distingue un test utile d'un test décoratif. Un test de concurrence qui passerait aussi avec l'implémentation naïve ne teste rien.

---

## L3-14 — Test de résilience

### Objectif

Prouver l'invariant : le service peut tomber sans qu'une course soit perdue.

### Fichiers

```
services/realtime/test/resilience/restart.test.ts
```

### Spécification

Scénario, de bout en bout, contre l'environnement réel :

1. Créer une course, la faire accepter, la démarrer
2. Émettre des positions pendant un temps
3. **Tuer le service temps réel** brutalement, sans arrêt propre
4. Le redémarrer
5. Reconnecter les deux apps
6. Terminer la course

Vérifier après redémarrage : la course est retrouvée dans son état, l'accumulation reprend, la fin de course s'enregistre correctement dans Odoo, la facture est cohérente.

Variante : tuer le service **entre** la fin de course et l'écriture Odoo. L'événement doit être en file et rejoué au redémarrage (L3-12).

Variante : tuer Redis. La perte des positions de l'instant est acceptable ; la perte d'une course en cours d'affectation ne l'est pas — les états durables sont dans Odoo.

### Critères d'acceptation

1. Après redémarrage brutal, la course se retrouve et se termine.
2. Aucune course confirmée n'est perdue.
3. L'événement de fin de course en file est rejoué.
4. La perte de Redis ne fait perdre aucune course enregistrée dans Odoo.
5. Le test tourne en intégration continue, ou au minimum avant chaque livraison.

---

## L3-15 — Canal de configuration Odoo → temps réel

### Objectif

Permettre au service temps réel de lire les valeurs métier paramétrables sans jamais toucher PostgreSQL.

### Contexte

**Créée le 16 août, après l'écart `amoa/questions/L3-02.md`.** D21 veut les valeurs métier en base, modifiables sans redéploiement pendant le pilote. L'invariant 1 interdit au service temps réel tout client PostgreSQL, et la frontière de lint le garantit mécaniquement. Les deux règles sont bonnes ; entre les deux, il manquait un canal.

Faute de ce canal, L3-02, L3-03 et L3-04 ont posé leurs seuils, rayons et délais en variables d'environnement, tous rassemblés dans `services/realtime/src/config.ts`. C'est un champ-pont à l'échelle d'un fichier : provisoire, tracé, condamné — **par cette tâche**, qui commence par les faire disparaître.

### Fichiers

```
services/odoo/addons/babana/controllers/internal_config.py
services/realtime/src/config/remote.ts
services/realtime/test/remote-config.test.ts
```

### Spécification

Un endpoint Odoo **interne**, authentifié par `REALTIME_SHARED_SECRET` — le même mécanisme que le sens sortant de L3-12, pas un second à inventer. Il n'est jamais exposé publiquement : ni sur le domaine mobile, ni au travers de Caddy.

Il sert un **sous-ensemble nommé et fermé** d'`ir.config_parameter` — la liste des clés lisibles est déclarée dans le code, jamais un préfixe ouvert. Un endpoint qui sert « tout ce qui commence par `babana.` » finira par servir un secret que quelqu'un aura rangé là.

Côté temps réel : lecture au démarrage, puis rafraîchissement périodique avec un cache de quelques dizaines de secondes — ces valeurs ne changent pas à la seconde. **Le service démarre et fonctionne si Odoo est injoignable** : il sert alors les dernières valeurs connues, ou les valeurs par défaut compilées s'il n'a jamais rien lu. Un service temps réel qui refuse de démarrer parce qu'Odoo redémarre est un point de panne ajouté, pas retiré.

Les valeurs par défaut restent dans le code, comme filet — et elles restent plausibles au sens de D21, pas aléatoires.

### Critères d'acceptation

1. Aucune valeur métier du service temps réel ne vient plus d'une variable d'environnement : `services/realtime/src/config.ts` ne porte plus que des adresses et des secrets.
2. Une valeur modifiée dans Odoo est prise en compte par le service sans redémarrage, au plus tard après la période de cache.
3. Odoo injoignable au démarrage : le service démarre avec ses valeurs par défaut.
4. Odoo injoignable en cours de route : le service conserve les dernières valeurs lues, sans jamais retomber sur les valeurs par défaut.
5. L'endpoint refuse tout appel sans le secret partagé, et n'est pas atteignable depuis l'extérieur.
6. Une clé hors de la liste déclarée n'est jamais servie, même si elle existe dans `ir.config_parameter`.

---

## L3-16 — Profils chauffeurs lisibles par le service temps réel

### Objectif

Donner au service temps réel les quatre champs de profil que `nearby.drivers` doit afficher, sans lui donner de client PostgreSQL.

### Contexte

**Créée le 16 août, après l'écart `amoa/questions/L3-05.md`.** `NearbyDriverSchema` exige prénom, photo, note et gamme de moto. Position et distance viennent du géo-index ; ces quatre-là sont possédés par Odoo. Même famille de problème que L3-15, forme différente : une donnée **par enregistrement**, pas un paramètre global.

**Le sens de la dépendance est fixé, et il ne s'inverse pas (D27).** Le service temps réel lit Odoo ; Odoo n'écrit jamais dans Redis. Une poussée d'Odoo vers Redis à chaque changement de profil serait plus fraîche, mais elle donnerait à Odoo une dépendance Redis qui n'existe nulle part dans le dépôt, et avec elle la gestion d'un Redis indisponible, le rejeu et la réconciliation — toute la complexité que le flux événementiel prétend éviter. Une note moyenne qui met trente secondes à apparaître ne coûte rien ; un couplage bidirectionnel entre les deux services coûte pour toujours.

### Fichiers

```
services/odoo/addons/babana/controllers/internal_profiles.py
services/realtime/src/redis/driver-profiles.ts
services/realtime/test/driver-profiles.test.ts
```

### Spécification

Extension du canal de L3-15 — **même endpoint interne, même secret partagé, même politique de repli**, une charge utile de plus. Ne pas construire un second mécanisme d'authentification.

Le service temps réel demande les profils des chauffeurs qu'il s'apprête à renvoyer, **par lot**, jamais un appel par chauffeur. Cache par chauffeur, durée de vie courte. Au pilote, le pool tient en quelques dizaines de chauffeurs : rafraîchir le lot entier périodiquement est acceptable et plus simple qu'une invalidation fine.

**Liste blanche de champs, côté Odoo aussi.** L'endpoint ne sert que les quatre champs, jamais l'enregistrement `babana.driver` projeté. Le garde-fou de L3-05 ne doit pas être le seul : si la seule protection contre la fuite du numéro de téléphone est une projection côté temps réel, elle tombera le jour où quelqu'un ajoutera un champ « pratique » à la réponse.

**Un chauffeur sans profil disponible est renvoyé avec ses champs de profil à `null`** (D30), jamais complété par une valeur inventée et jamais omis. Odoo injoignable dégrade l'affichage de la liste ; il ne vide pas la liste.

Cette tâche fait disparaître le hash Redis provisoire posé par L3-05 — règle des champs-pont.

### Critères d'acceptation

1. Les quatre champs affichés viennent d'Odoo, par le canal interne, jamais d'un client PostgreSQL.
2. Odoo injoignable : les profils déjà lus restent servis ; les chauffeurs jamais lus sont omis, jamais inventés.
3. Une requête `nearby` renvoyant cinq chauffeurs ne déclenche pas cinq appels à Odoo.
4. L'endpoint Odoo ne sert que les quatre champs — test explicite sur l'**absence** de nom complet, téléphone, immatriculation.
5. Une modification de profil dans Odoo se voit côté temps réel au plus tard après la durée de cache, sans redémarrage.
6. `services/odoo` ne porte aucune dépendance à un client Redis.

---

## L3-17 — Câblage Odoo ↔ temps réel

### Objectif

Faire en sorte que la réservation, la proposition, l'acceptation et le refus existent réellement — et non seulement dans des modules sans appelant.

### Contexte

**Créée le 17 août.** Trois nuits ont produit la réservation atomique (L3-06), le pool à écrivain unique (L3-06R) et le cycle de proposition (L3-07). Chacun est testé, chacun est correct, **et aucun n'a d'appelant en production.** `select-driver` (L4-03) ne réserve toujours rien ; une acceptation n'écrit rien dans Odoo. Cela a été signalé honnêtement chaque nuit, et c'est devenu le chemin critique : tant que ce câblage n'existe pas, rien de ce qui a été construit n'est intégré, et les défauts d'assemblage restent invisibles.

### Fichiers

```
services/realtime/src/http/internal.ts
services/odoo/addons/babana/services/realtime_client.py
services/odoo/addons/babana/controllers/ride.py
services/realtime/src/driver/reconcile.ts
```

### Spécification

**Sens Odoo → temps réel.** Un endpoint HTTP interne sur le service temps réel, authentifié par `REALTIME_SHARED_SECRET`, jamais exposé publiquement. `select-driver` l'appelle pour réserver et proposer, **avant** la transition Odoo. Un échec de réservation donne `DRIVER_ALREADY_TAKEN` sans qu'aucune transition n'ait lieu.

**Le piège du rejeu, et c'est le point central de cette tâche.** Odoo rejoue la requête HTTP entière sur conflit de concurrence (D25). Un appel sortant placé dans un contrôleur rejouable **s'exécute donc deux fois**. Deux réponses possibles, à choisir explicitement et à documenter :

- rendre l'appel idempotent de bout en bout, par une clé de requête que le service temps réel reconnaît et dont il rejoue la réponse ;
- ou sortir l'appel de la transaction rejouable.

Ce qui n'est pas acceptable, c'est de ne pas trancher. Un appel sortant non idempotent dans une transaction rejouable est un défaut qui ne se manifeste que sous charge, exactement comme ceux que L4-11 a mis trois nuits à révéler.

**Sens temps réel → Odoo** : c'est L3-12, et rien ici ne doit le réimplémenter. Acceptation, refus et expiration écrivent leurs transitions par ce chemin-là.

**Les routes internes d'écriture ne sont pas un point d'entrée** (précision du 19 août). `/api/internal/rides/{id}/driver-accepted` et sa jumelle pour le refus sont la **seconde moitié** d'une opération dont la première est `ProposalLifecycle.accept()` / `.reject()`. Les appeler directement écrit bien la transition dans Odoo, et laisse la réservation Redis en place et le minuteur d'expiration armé — un chauffeur affecté qui reste « réservé » indéfiniment, invisible pour tout le monde.

Découvert en écrivant le scénario 3 de L4-11, dont la préparation prenait ce raccourci. Les scénarios 1 et 2 ne l'avaient jamais montré parce que leur nettoyage passe par une annulation, qui relâche la réservation en effet de bord sans le nommer. La règle : ces routes n'ont qu'un appelant légitime, et un test qui a besoin d'amener une course à `assigned` emprunte le vrai chemin.

**La précondition C-03 « chauffeur présent dans la dernière liste des 5 »**, signalée depuis L3-06 et jamais vérifiée nulle part, se traite ici : c'est la première fois que les deux côtés se parlent, donc la première fois que la vérification a un effet.

**Fin de course : le marqueur d'engagement s'efface.** Sans quoi le chauffeur ne revient jamais dans le pool.

### La réconciliation, qui fait partie de cette tâche

Le marqueur d'engagement n'expire jamais — c'est délibéré, un embouteillage à Douala ne doit pas remettre au pool un chauffeur qui transporte quelqu'un. Mais un marqueur qui n'expire jamais et qu'un seul échec laisse en place rend le chauffeur **invisible pour toujours**, sans erreur, sans alerte. C'est mot pour mot le scénario du contexte terrain : la flotte se vide et personne ne comprend pourquoi.

Le service temps réel demande donc périodiquement à Odoo la liste des chauffeurs réellement en course, et **aligne ses marqueurs dessus** : il efface les orphelins, il pose ceux qui manquent. Odoo est la source de vérité (D27) ; le service temps réel ne décide de rien, il reflète (invariant 3).

L'écart constaté à chaque passage est compté et journalisé. Un écart durablement non nul n'est pas un incident de réconciliation, c'est un défaut du chemin nominal — la réconciliation le répare et le **dénonce**, elle ne le masque pas.

### Critères d'acceptation

1. Une course va de `requested` à `assigned` par l'API mobile, réservation atomique comprise, contre la pile réelle.
2. Deux clients sélectionnant le même chauffeur : un seul gagne, l'autre reçoit `DRIVER_ALREADY_TAKEN`, et aucune course fantôme n'est créée.
3. **Une requête `select-driver` rejouée par Odoo ne produit qu'une réservation.** Test explicite, avec un rejeu réellement provoqué — pas simulé par un double appel du test.
4. L'échec de l'appel au service temps réel ne laisse aucune transition Odoo appliquée.
5. Un chauffeur qui refuse réintègre le pool ; un chauffeur qui accepte n'y revient pas jusqu'à la fin de course.
6. La fin de course efface le marqueur d'engagement et le chauffeur redevient disponible.
7. **Un marqueur d'engagement orphelin est effacé par la réconciliation**, et l'écart est journalisé.
8. Un chauffeur absent de la dernière liste des 5 envoyée au client ne peut pas être sélectionné.
9. **Aucun appel sortant vers le service temps réel ne part avant le commit de la transaction Odoo** (D32). Test explicite : une transition dont la transaction échoue au commit ne doit avoir modifié aucune clé Redis. `reserve_and_propose` fait exception et doit le rester — il précède délibérément la transition, puisque c'est son résultat qui l'autorise.
