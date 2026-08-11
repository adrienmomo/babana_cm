# babana.cm — Découpage en tâches techniques

**Version** 1.4 — 11 août 2026
**Périmètre** v1, pilote Bonanjo — décisions D1 à D15 de `01-architecture.md`, D16 à D18 de `04-monorepo-et-services.md`, D19 à D22 de `05-prerequis-et-simulation.md`
**Destinataire** développement par Claude Code

---

## 1. Principes de découpage

Quatre règles ont gouverné ce découpage. Les connaître évite de le réorganiser à contresens.

**Chaque tâche produit un incrément vérifiable.** Une tâche n'est pas finie parce que le code est écrit, mais parce qu'un critère de fin observable est satisfait. Chaque tâche en porte un. Les tâches sans critère vérifiable ont été fusionnées ou supprimées.

**Le découpage suit la règle de partition, pas les écrans.** Une tâche appartient soit au domaine Odoo, soit au service temps réel, soit aux apps — jamais aux trois. Une tâche qui traverse la frontière Odoo / temps réel est un signe que la frontière est mal placée.

**Les contrats précèdent le parallélisme.** Trois artefacts (§3) doivent être figés avant que backend, temps réel et mobile puissent avancer indépendamment. Tant qu'ils ne le sont pas, tout parallélisme produit du travail à jeter.

**La boucle de course d'abord, le confort ensuite.** L'ordre vise à rendre une course démontrable de bout en bout au plus tôt, même laide. Gestion de flotte, remise de caisse, notifications et rapports viennent après — ils sont indispensables au pilote, pas à la démonstration.

**Taille** : S ≈ une demi-journée à une journée, M ≈ deux à trois jours, L ≈ une semaine. Ce sont des ordres de grandeur pour séquencer, pas un chiffrage contractuel.

---

## 2. Jalons

Chaque jalon a un critère de démonstration binaire : soit on peut le montrer, soit non.

| Jalon | Contenu | Critère de démonstration |
|---|---|---|
| **J1 — Socle** | L0, contrats figés | Un développeur clone le dépôt, lance une commande, obtient Odoo + service temps réel + les deux apps qui démarrent et se répondent |
| **J2 — Identité** | L1 partiel | Un chauffeur s'inscrit avec Google, un admin valide son dossier dans Odoo, le chauffeur se connecte à l'app Chauffeur |
| **J3 — Course nue** | L2, L3, L4, L6 partiels | Un client voit 5 chauffeurs sur la carte, en choisit un, le chauffeur accepte, la position se suit en direct, la course se termine avec un montant. Sans facture, sans notification, sans jolie interface |
| **J4 — Course complète** | L4, L5, L7 | Espèces encaissées, solde chauffeur incrémenté, facture Odoo générée, notifications push aux transitions |
| **J5 — Prêt pilote** | L8, L9, L10, L0-07 | Remise de caisse validée par un superviseur, partage de trajet fonctionnel, tests de concurrence et de résilience passants, **restauration de sauvegarde réussie sur un hôte vierge**, supervision hors hôte qui alerte effectivement |

**J3 est le jalon qui compte.** C'est le premier moment où l'on sait si l'architecture tient. Tout ce qui peut être repoussé après J3 doit l'être.

---

## 3. Contrats à figer avant parallélisation

Ces trois artefacts sont des tâches à part entière, et ils bloquent presque tout le reste.

| ID | Tâche | Taille | Dépend de |
|---|---|---|---|
| C-01 | Contrat d'API mobile ↔ Odoo | M | — |
| C-02 | Contrat d'événements temps réel | M | — |
| C-03 | Machine à états de la course | S | — |

**C-01 — Contrat d'API mobile ↔ Odoo** (M)
Spécification écrite des endpoints critiques : authentification, cotation, cycle de vie de la course, encaissement, remise de caisse. Format des requêtes et réponses, codes d'erreur, règles de version. Les lectures secondaires (historique, factures, profil) passent en JSON-RPC natif et ne sont pas dans ce contrat.
*Critère de fin* : un document que le développeur mobile peut implémenter sans poser de question au développeur backend, et des exemples de requête et réponse pour chaque endpoint.

**C-02 — Contrat d'événements temps réel** (M)
Messages WebSocket dans les deux sens : émission de position, liste des chauffeurs proches, proposition de course, acceptation, refus, mise à jour de suivi, fin de course. Plus la politique de reconnexion et de rattrapage d'état après coupure.
*Critère de fin* : chaque message a un nom, un schéma et un émetteur unique. La reconnexion est spécifiée, pas laissée à l'implémentation.

**C-03 — Machine à états de la course** (S)
Les états `brouillon → demandée → proposée → affectée → en_cours → terminée → encaissée`, plus `annulée` et `refusée`. Pour chaque transition : déclencheur, acteur autorisé, préconditions, effets de bord.
*Critère de fin* : un tableau de transitions exhaustif, et la liste des transitions interdites. C'est la colonne vertébrale du projet — tout le reste s'y accroche.

---

## 4. Lots et tâches

### L0 — Socle technique

| ID | Tâche | Taille | Dépend de |
|---|---|---|---|
| L0-01 | Odoo 18 Community en Docker : image, `docker-compose`, PostgreSQL, volumes, variables d'environnement | M | — |
| L0-02 | Squelette du module Odoo `babana` : manifeste, arborescence, groupes de sécurité, chargement à vide vérifié | S | L0-01 |
| L0-03 | Monorepo React Native : deux applications, paquet partagé (design system, client API, types), configuration de build Android | L | — |
| L0-04 | Squelette du service temps réel : serveur, Redis, point de santé, WebSocket qui accepte une connexion authentifiée | M | C-02 |
| L0-05 | Intégration continue : lint, tests unitaires, build Android sur chaque commit | M | L0-02, L0-03, L0-04 |
| L0-06 | Environnements et secrets : développement, recette, production ; secrets injectés à l'exécution, jamais dans le dépôt | M | L0-01 |
| L0-07 | Mise en production de l'hôte (D18) : durcissement, DNS, déploiement, sauvegardes externes avec restauration prouvée, supervision hors hôte | L | L0-06, L8-08 |
| L0-08 | **Services simulés** (D19) : `mock-google` émettant jetons et jeu de clés, doublures de routage et de recherche de lieu, implémentations de développement pour SMS et notifications | M | L0-01 |
| L0-09 | **Harnais de non-régression** : exécution locale de la suite complète, détection des tests instables, seuils de couverture sur les modules sensibles, blocage de fusion sur suite rouge | M | L0-05 |

**Sur L0-08** : à faire tôt. C'est la tâche qui rend tout le reste du développement possible sans compte externe (D19), et elle rend les tests négatifs d'authentification écrivables — contre le vrai Google, ils seraient impossibles.

**Point d'attention sur L0-03** : c'est la tâche la plus sous-estimée du lot. Un monorepo React Native mal posé se paie pendant tout le projet. Le paquet partagé doit être consommable par les deux apps dès le premier jour, sinon le code sera dupliqué et divergera.

---

### L1 — Identité, comptes, flotte

| ID | Tâche | Taille | Dépend de |
|---|---|---|---|
| L1-01 | Contrôleur Odoo `/api/v1/auth/google` : vérification de signature de l'ID token auprès des certificats Google, contrôle de `aud` et `iss`, contrôle d'expiration, création ou reprise de l'utilisateur | M | L0-02, L0-08, C-01 |
| L1-02 | Émission et rafraîchissement du jeton applicatif, expiration, révocation | M | L1-01 |
| L1-03 | Modèle `babana.driver` : rattachement à `hr.employee`, statut de validation, note moyenne, état en ligne, plafond d'encaisse, solde courant, compteur de courses | M | L0-02 |
| L1-04 | Modèle client : réutilisation de `res.partner`, champs propres à l'application, numéro de téléphone | S | L0-02 |
| L1-05 | Téléversement des documents chauffeur (permis, pièce d'identité) : stockage, accès signé à durée limitée, jamais d'URL publique | M | L1-03 |
| L1-06 | Circuit de validation du dossier chauffeur dans le back-office : accepter, rejeter avec motif, suspendre | M | L1-05 |
| L1-07 | Modèle `babana.motorcycle` et gestion de flotte : immatriculation, carte grise, assurance et échéance, gamme standard ou premium | M | L0-02 |
| L1-08 | Affectation durable moto ↔ chauffeur, avec historique des affectations | S | L1-03, L1-07 |
| L1-09 | Rattachement du numéro Mobile Money avec **un seul OTP dans la vie du compte** : intégration agrégateur SMS, anti-rejeu, limitation de tentatives | M | L1-03, L1-04 |
| L1-10 | Alerte d'échéance d'assurance et de carte grise dans le back-office | S | L1-07 |

**Sur L1-01** : c'est la tâche qui prouve que le choix Google-only tient techniquement. À faire tôt, avant toute app mobile. Le piège classique est de vérifier le token côté client ou de faire confiance à un champ non signé — la vérification doit être serveur, contre les certificats Google, à chaque appel.

**Sur L1-09** : peut être repoussé après J3, mais **pas après J4**. Sans numéro vérifié, la phase 2 Mobile Money hérite d'une base de numéros non fiables et le rattrapage est douloureux.

---

### L2 — Tarification

| ID | Tâche | Taille | Dépend de |
|---|---|---|---|
| L2-01 | Modèle `babana.fare.rule` : base, prix au km, zone, plage horaire, coefficient d'heure de pointe. **Sans prix à la minute** (D15) | M | L0-02 |
| L2-02 | Modèle de zone géographique et résolution d'un point vers une zone | M | L2-01 |
| L2-03 | Moteur de cotation : distance de l'itinéraire, application de la règle, coefficient, arrondi FCFA. Fonction pure et testable, sans effet de bord | M | L2-01, L2-02 |
| L2-04 | Endpoint de cotation `/api/v1/quote` : départ, arrivée, retour du montant et de la distance de référence | S | L2-03, C-01 |
| L2-05 | Intégration de l'API de routage Google pour la distance de référence, avec cache par paire de zones | M | L2-03, L0-08 |
| L2-06 | Modèle `babana.promotion` et application d'un code promo à la cotation | M | L2-03 |
| L2-07 | Jeu de tests de cotation : cas nominaux, frontières de zone, bascule d'heure de pointe, arrondi, promotion cumulée | M | L2-03, L2-06 |

**Sur L2-03** : le moteur de cotation doit être une fonction pure. C'est ce qui permet de le tester exhaustivement et de rejouer un litige tarifaire à l'identique six mois plus tard. Une cotation qui lit l'heure système ou l'état de la base à l'intérieur du calcul n'est pas rejouable.

**Sur L2-05** : la distance de référence est calculée sur un modèle voiture (É8). C'est assumé, mais le code doit le documenter à l'endroit du calcul, sinon quelqu'un « corrigera » plus tard en sommant les points GPS et cassera la reproductibilité des factures.

---

### L3 — Service temps réel

| ID | Tâche | Taille | Dépend de |
|---|---|---|---|
| L3-01 | Authentification des connexions WebSocket par le jeton applicatif, distinction client et chauffeur | M | L0-04, L1-02 |
| L3-02 | Ingestion des positions chauffeur : réception, validation de plausibilité, écriture Redis avec TTL | M | L3-01 |
| L3-03 | Géo-index des chauffeurs disponibles dans Redis, requête des N plus proches | M | L3-02 |
| L3-04 | Bascule en ligne / hors ligne du chauffeur, avec entrée et sortie du pool disponible | S | L3-03 |
| L3-05 | Endpoint « 5 chauffeurs les plus proches » (D14) : rayon plafonné, nombre de résultats plafonné, position arrondie, limitation de débit, charge utile minimale (photo, note, gamme, distance) | M | L3-03 |
| L3-06 | **Réservation atomique du chauffeur** : retrait du pool et création de la proposition en une opération indivisible | M | L3-05, C-03 |
| L3-07 | Cycle de proposition : notification au chauffeur, délai d'acceptation, acceptation, refus, expiration | M | L3-06 |
| L3-08 | Élargissement du rayon et nouvelle liste de 5 quand aucun chauffeur ne convient | S | L3-05, L3-07 |
| L3-09 | Diffusion du suivi au client : position du chauffeur, ETA, pendant l'approche puis pendant la course | M | L3-02, L3-07 |
| L3-10 | Accumulation de la distance et de la durée en cours de course dans Redis | M | L3-09 |
| L3-11 | Reconnexion et rattrapage d'état après coupure réseau, côté client comme côté chauffeur | M | C-02, L3-09 |
| L3-12 | Appels sortants vers Odoo aux quatre événements métier de la règle de partition, avec rejeu en cas d'échec | M | L4-02, C-01 |
| L3-13 | **Test de concurrence sur la réservation** : N sélections simultanées du même chauffeur produisent exactement un succès | M | L3-06 |
| L3-14 | **Test de résilience** : coupure du service temps réel en pleine course, redémarrage, la course se retrouve et se termine correctement | M | L3-12 |

**Sur L3-06** : la tâche la plus risquée du projet. Une réservation implémentée en deux temps — lire l'état puis écrire — laisse une fenêtre de course qui produit deux gagnants. Le bug est intermittent, invisible en test unitaire, et se manifeste en production sous charge. L3-13 n'est pas optionnelle : c'est la seule preuve que L3-06 est correcte.

**Sur L3-12** : c'est ici que la règle de partition se matérialise ou se perd. Toute tentation d'écrire dans Odoo à un cinquième moment doit être refusée et remontée comme une question d'architecture.

---

### L4 — Boucle de course

| ID | Tâche | Taille | Dépend de |
|---|---|---|---|
| L4-01 | Modèle `babana.ride` : champs, index, contraintes d'intégrité | M | L0-02, C-03 |
| L4-02 | Machine à états : transitions comme seules portes d'écriture, refus des transitions interdites, historique des refus sur une même demande | L | L4-01, C-03 |
| L4-03 | Endpoints du cycle de vie : demander, sélectionner un chauffeur, accepter, refuser, démarrer, terminer | L | L4-02, C-01 |
| L4-04 | Consolidation de fin de course : distance, durée, tracé archivé en une écriture, calcul du montant définitif | M | L4-02, L2-03, L3-10 |
| L4-05 | Encaissement espèces : confirmation par le chauffeur, passage à l'état encaissé | M | L4-02 |
| L4-06 | Génération de la facture via `account.move` : numérotation légale, PDF, envoi par email à la demande | M | L4-05 |
| L4-07 | Annulation : par le client avant affectation, par le client après affectation, par le chauffeur, avec règles distinctes | M | L4-02 |
| L4-08 | Historique des courses et des factures, exposé en JSON-RPC natif | S | L4-06 |
| L4-09 | Notation et avis client après la course, mise à jour de la note moyenne du chauffeur | M | L4-05, L1-03 |
| L4-10 | **Tests de la machine à états** : toutes les transitions valides passent, toutes les interdites échouent, double encaissement impossible | M | L4-02 |
| L4-11 | **Test de concurrence sur les transitions**, contre une pile réelle hors du harnais Odoo | M | L4-02, L0-01 |

**Sur L4-11** : extraite de L4-02 le 11 août. Un test de concurrence dans le harnais Odoo est instable par construction — `TransactionCase` annule la transaction en fin de test, une seconde connexion ne voit rien ou attend un verrou. Même raisonnement que L3-13 pour Redis.

**Sur L4-02** : la tâche la plus structurante du lot. Si les transitions ne sont pas les seules portes d'écriture, l'invariant se perd et toutes les garanties du §6 de l'architecture tombent. Un test doit vérifier qu'aucun chemin ne permet d'écrire l'état directement.

---

### L5 — Caisse et recette

| ID | Tâche | Taille | Dépend de |
|---|---|---|---|
| L5-01 | Compte courant chauffeur : incrémentation à chaque encaissement espèces, journal des mouvements | M | L4-05, L1-03 |
| L5-02 | **Plafond d'encaisse bloquant** : au-delà du plafond configuré, le chauffeur ne peut plus être sélectionné ni accepter de course | M | L5-01, L3-04 |
| L5-03 | Modèle `babana.cash.remittance` : chauffeur, montant attendu, montant remis, superviseur, horodatage | M | L5-01 |
| L5-04 | Validation de la remise par un superviseur dans le back-office, remise à zéro du solde | M | L5-03 |
| L5-05 | Écriture comptable Odoo à la validation de la remise | M | L5-04 |
| L5-06 | Traitement des écarts : différence entre attendu et remis enregistrée explicitement, jamais absorbée | M | L5-04 |
| L5-07 | Écran de recette dans l'app Chauffeur : encaissé du jour, solde dû, plafond restant. **Libellé « recette encaissée », pas « revenus »** (É6) | M | L5-01, L6-02 |

**Sur L5-02** : le plafond est le seul mécanisme de contrôle de la recette, puisque D7 supprime la clôture de service. Il doit bloquer à deux endroits — la sélection par le client et l'acceptation par le chauffeur — sinon il se contourne.

**Sur L5-06** : un écart silencieusement absorbé est une fraude rendue invisible. L'écart doit produire une trace consultable et une alerte au-delà d'un seuil.

---

### L6 — Applications mobiles

| ID | Tâche | Taille | Dépend de |
|---|---|---|---|
| L6-01 | **Abstraction carte et navigation** (C3) : interface interne afficher une carte, tracer un tracé, ouvrir un guidage, chercher un lieu. Implémentation Google Maps. Aucun écran n'importe le SDK | M | L0-03 |
| L6-02 | Connexion Google Sign-In dans les deux apps, stockage sûr du jeton, rafraîchissement transparent | M | L0-03, L1-02 |
| L6-03 | Client API partagé : appels REST, JSON-RPC, gestion d'erreurs, réessais | M | L0-03, C-01 |
| L6-04 | Client WebSocket partagé : connexion, reconnexion, file d'attente locale, rattrapage d'état | M | L0-03, C-02 |
| L6-05 | Capture GPS côté chauffeur : fréquence adaptative selon la vitesse, agrégation avant envoi, fonctionnement en arrière-plan | L | L6-04 |
| L6-06 | App Client — écran d'accueil carte : position, 5 chauffeurs proches, désignation du départ et de l'arrivée sur la carte et par recherche de lieu | L | L6-01, L6-03, L3-05 |
| L6-07 | App Client — estimation et validation : montant, distance, ETA corrigé, choix du chauffeur parmi les 5 | M | L6-06, L2-04 |
| L6-08 | App Client — attente, refus et nouvelle sélection, sans attribution automatique (D11) | M | L6-07, L3-07 |
| L6-09 | App Client — suivi de course en direct, puis résumé de fin | M | L6-08, L3-09 |
| L6-10 | App Client — historique, factures, téléchargement et envoi par email | M | L4-08 |
| L6-11 | App Chauffeur — bascule en ligne / hors ligne, état visible en permanence | S | L6-04, L3-04 |
| L6-12 | App Chauffeur — réception de proposition : départ, arrivée, montant, distance, compte à rebours, accepter ou refuser | M | L6-11, L3-07 |
| L6-13 | App Chauffeur — course en cours, lien profond vers Google Maps (D12), démarrage et fin de course | M | L6-12, L6-01 |
| L6-14 | App Chauffeur — confirmation d'encaissement espèces | S | L6-13, L4-05 |
| L6-15 | App Chauffeur — inscription et téléversement des documents, écran d'attente de validation | M | L6-02, L1-05 |
| L6-16 | **Mode dégradé réseau** dans les deux apps : file d'attente locale des actions, rejeu à la reconnexion, état affiché sans ambiguïté | L | L6-04 |
| L6-17 | Mesure de consommation batterie et données de L6-05, sur terminaux d'entrée de gamme | M | L6-05 |
| L6-18 | **Export web de l'app Client** (D22) : implémentation web de `@babana/maps`, flux OAuth web, dégradations signalées, déploiement Vercel. **App Chauffeur exclue** | M | L6-09, L6-01 |

**Sur L6-01** : à faire avant tout écran cartographique, pas après. Une abstraction ajoutée après coup n'en est pas une — les écrans auront déjà fui vers le SDK et le basculement vers Mapbox redeviendra une réécriture.

**Sur L6-16** : à concevoir dès le départ, pas ajouté à la fin. Le réseau intermittent à Douala n'est pas un cas limite, c'est le cas courant. Une app qui suppose le réseau disponible est à réécrire.

**Sur L6-17** : ce n'est pas une tâche de confort. Un chauffeur dont la batterie tient trois heures désinstalle l'application, et la flotte se vide sans que personne comprenne pourquoi.

---

### L7 — Notifications

| ID | Tâche | Taille | Dépend de |
|---|---|---|---|
| L7-01 | Intégration Firebase Cloud Messaging : enregistrement et cycle de vie des jetons d'appareil | M | L0-03, L1-03 |
| L7-02 | Envoi de notification aux transitions de course : confirmation, arrivée du chauffeur, fin avec résumé | M | L7-01, L4-02 |
| L7-03 | Notification d'acceptation ou de rejet du dossier chauffeur (CDC §IV.1) | S | L7-01, L1-06 |
| L7-04 | Notification de proposition de course au chauffeur, y compris application en arrière-plan | M | L7-01, L3-07 |
| L7-05 | Notification d'approche du plafond d'encaisse | S | L7-01, L5-02 |
| L7-06 | **Aucune notification n'est un canal unique** : tout état notifié est relisible depuis le serveur à l'ouverture de l'app | M | L7-02, L6-03 |

**Sur L7-06** : une notification perdue ne doit jamais laisser un utilisateur dans un état qu'il ne peut pas retrouver. C'est une exigence transverse, à vérifier par test : couper les notifications et vérifier que l'app reste utilisable.

---

### L8 — Sécurité et conformité

| ID | Tâche | Taille | Dépend de |
|---|---|---|---|
| L8-01 | Règles d'enregistrement Odoo : un chauffeur ne lit que ses courses, un client que les siennes, aucun client ne lit les documents d'un chauffeur | L | L4-01, L1-03 |
| L8-02 | **Tests d'habilitation** : pour chaque modèle, un test qui tente l'accès interdit et vérifie l'échec | M | L8-01 |
| L8-03 | Partage de trajet (CDC §II.6) : route publique non authentifiée, jeton opaque, expiration, exposition minimale — position et ETA seulement | M | L3-09, L4-02 |
| L8-04 | Modèle `babana.incident` et bouton d'urgence : déclenchement, alerte au back-office, traçabilité | M | L4-01 |
| L8-05 | Signalement et gestion de litige côté client et côté chauffeur (CDC §VII.4) | M | L8-04 |
| L8-06 | TLS sur toutes les liaisons, WebSocket inclus, y compris en recette | M | L0-06 |
| L8-07 | Chiffrement au repos du volume PostgreSQL et du stockage de documents | M | L0-06 |
| L8-08 | Sauvegarde automatique quotidienne **et procédure de restauration testée** | M | L0-06 |
| L8-09 | Journalisation non modifiable des transitions de course et des mouvements de compte courant | M | L4-02, L5-01 |
| L8-10 | Politique de conservation des données de localisation : durée, purge automatique, documentation de conformité | M | L4-04 |

**Sur L8-08** : la tâche n'est pas finie quand la sauvegarde tourne, elle est finie quand une restauration a été effectuée avec succès sur un environnement vierge. Une sauvegarde jamais restaurée n'est pas une sauvegarde.

**Sur L8-02** : les habilitations Odoo sont faciles à croire correctes et faciles à avoir fausses. Seul un test qui tente l'accès interdit prouve quelque chose.

---

### L9 — Back-office et pilotage

| ID | Tâche | Taille | Dépend de |
|---|---|---|---|
| L9-01 | Vues Odoo chauffeurs : liste, formulaire, filtres, recherche, actions de validation et suspension | M | L1-06 |
| L9-02 | Vues Odoo flotte : motos, affectations, échéances | S | L1-07 |
| L9-03 | Vues Odoo courses : liste, formulaire, filtres par état, zone, chauffeur, période | M | L4-01 |
| L9-04 | Vues Odoo tarification et promotions, avec paramétrage des coefficients | M | L2-01, L2-06 |
| L9-05 | Vues Odoo remises de caisse et écarts | M | L5-03 |
| L9-06 | Paramétrage back-office des valeurs de dispatch : délai d'acceptation, rayon initial, plafond d'encaisse. **Aucune valeur codée en dur** | M | L3-07, L5-02 |
| L9-07 | Tableau de bord : courses par jour, semaine, mois ; recette ; zones actives ; heures de pointe (CDC §V.2) | L | L9-03 |
| L9-08 | **Indicateur d'équité** : nombre de courses par chauffeur, pour détecter les salariés jamais sélectionnés (C2c) | M | L9-03 |
| L9-09 | **Indicateur d'abandon** : taux d'abandon client après un ou plusieurs refus (D11) | M | L9-03 |
| L9-10 | Rapports exportables PDF et Excel (CDC §V.2) | M | L9-07 |

**Sur L9-08 et L9-09** : ce ne sont pas des tâches de reporting mais des instruments de décision. L9-08 dira s'il faut rouvrir D10 et réintroduire une attribution automatique. L9-09 dira s'il faut rouvrir D11 et ajouter un repli. Sans eux, ces deux décisions se prendront à l'intuition.

**Sur L9-06** : chaque valeur de dispatch codée en dur est un déploiement à faire pour changer un chiffre qu'on ajustera dix fois pendant le pilote.

---

### L10 — Qualité et préparation du pilote

| ID | Tâche | Taille | Dépend de |
|---|---|---|---|
| L10-01 | Scénario de bout en bout automatisé : de la demande à la facture, exécuté en intégration continue | L | J4 |
| L10-02 | **Mesure cartographique** : 30 couples départ–arrivée réels à Douala, comparaison des itinéraires et durées annoncées contre observées, taux de résolution de 50 repères d'usage | M | L2-05 |
| L10-03 | **Facteur de correction d'ETA** déduit de L10-02, intégré au calcul affiché (É8) | M | L10-02, L2-04 |
| L10-04 | Devis Google du SKU « Navigation Request », en préparation de la v2 | S | — |
| L10-05 | Arbitrage distance calculée ou distance parcourue pour la facturation, sur données de L10-02 | S | L10-02 |
| L10-06 | Test de charge : nombre de chauffeurs simultanés en émission de position, mesure de saturation | M | L3-02 |
| L10-07 | Publication Google Play en canal fermé, comptes de test | M | L6-16 |
| L10-08 | Journal de bord du pilote : indicateurs à relever quotidiennement, seuils de réouverture de D10, D11 et É1 | S | L9-08, L9-09 |

**Sur L10-02** : à planifier dès le début du pilote, pas après. Elle conditionne L10-03 et L10-05, donc la crédibilité de l'ETA et la formule de facturation. Menée trop tard, elle impose de refaire la tarification en pleine exploitation.

---

## 5. Chemin critique vers J3

L'enchaînement le plus court qui produit une course démontrable. Toute tâche hors de cette liste peut attendre.

```
C-03 → L0-01 → L0-02 → L4-01 → L4-02 ─┐
                                       ├→ L4-03 → L4-04 → J3
C-01 → L1-01 → L1-02 ─┐                │
                       ├→ L3-01 → L3-03 → L3-05 → L3-06 → L3-07 → L3-09 → L3-10 → L3-12
C-02 → L0-04 ─────────┘                │
                                       │
L0-03 → L6-01 → L6-03 → L6-04 → L6-06 → L6-07 → L6-08 → L6-09
                              └→ L6-05, L6-11, L6-12, L6-13
L2-01 → L2-03 → L2-04 ────────────────┘
```

Trois goulots à surveiller :

**C-03 bloque L4-01 et L4-02**, qui bloquent presque tout le domaine. À traiter en premier, avant même le socle technique — c'est une tâche de conception, elle ne demande pas d'environnement.

**L1-02 bloque L3-01**, qui bloque tout le temps réel. L'authentification n'est pas un lot annexe à faire « quand on aura le temps » : elle est sur le chemin critique.

**L6-01 bloque L6-06**, donc tous les écrans cartographiques. L'abstraction de carte doit précéder le premier écran, sinon elle n'existera jamais.

---

## 6. Ce qui n'est pas dans le périmètre v1

À dire explicitement pour éviter qu'une tâche réapparaisse par inadvertance.

- Mobile Money et carte bancaire (É4, phase 2)
- Wallet chauffeur, commissions, abonnements, moteur de payout (É3, D5)
- Moteur de matching automatique et priorité par proximité (É7, D10)
- Navigation turn-by-turn embarquée (D12, v2)
- Prix à la minute dans le tarif (É9, D15)
- Export fiscal des revenus chauffeur (É6, sans objet avec le salariat)
- Téléversement de la carte grise par le chauffeur (É2, remplacé par la gestion de flotte)
- Calcul de paie dans Odoo (`hr_payroll` absent de Community, traité hors application)
- Version iOS — le CDC §III.1 donne Android prioritaire, iOS après le pilote

---

## 7. Les onze premières tâches

Dans cet ordre, sans parallélisation utile avant la quatrième. **Aucune ne demande de compte externe** (D19).

1. **C-03** — machine à états de la course. Aucune dépendance, bloque tout le domaine.
2. **C-01** — contrat d'API mobile ↔ Odoo.
3. **C-02** — contrat d'événements temps réel.
4. **L0-01** — Odoo en Docker.
5. **L0-02** — squelette du module `babana`.
6. **L0-08** — services simulés. *Débloque tout le développement sans aucun compte externe (D19).*
7. **L0-03** — monorepo React Native. *Peut démarrer en parallèle de 4, 5 et 6.*
8. **L1-01** — contrôleur d'authentification Google, testé contre `mock-google`. La tâche qui valide ou invalide D4.
9. **L4-01** — modèle `babana.ride`.
10. **L4-02** — machine à états implémentée.
11. **L0-04** — squelette du service temps réel. *Peut démarrer en parallèle de 9 et 10.*

À l'issue de ces dix tâches, trois chantiers peuvent avancer indépendamment : domaine Odoo, service temps réel, applications mobiles. Avant, non — et tenter de paralléliser plus tôt produira du travail à jeter.

---

## 8. Traçabilité des décisions

Chaque décision et chaque écart de `01-architecture.md` doit être porté par au moins une tâche. Cette table est l'inverse du découpage : elle sert à vérifier qu'aucune décision n'a été perdue en route, et à retrouver les tâches concernées quand une décision est rouverte.

| Décision | Tâches porteuses |
|---|---|
| D1 — Deux apps React Native, monorepo | L0-03, L6-* |
| D2 — Odoo 18 Community auto-hébergé | L0-01, L0-06, L8-07, L8-08 |
| D3 — Service temps réel dédié | L0-04, L3-* |
| D4 — Google Sign-In seul | L1-01, L1-02, L6-02 |
| D5 — Chauffeurs salariés | L1-03, L5-*, L9-08 |
| D6 — Motos propriété de l'entreprise | L1-07, L1-08, L1-10, L9-02 |
| D7 — En ligne / hors ligne libre | L3-04, L6-11 |
| D8 — Compte courant et plafond d'encaisse | L5-01, L5-02, L5-07, L7-05, L9-06 |
| D9 — MVP espèces uniquement | L4-05, L5-*, L6-14 |
| D10 — Le client choisit son chauffeur | L3-05, L3-06, L6-07, L9-08 |
| D11 — Refus sans attribution automatique | L3-07, L3-08, L6-08, L9-09 |
| D12 — Lien profond en v1, nav in-app en v2 | L6-01, L6-13, L10-04 |
| D13 — Google Maps derrière une abstraction | L6-01, L2-05, L10-02 |
| D14 — 5 chauffeurs les plus proches | L3-05, L6-07 |
| D15 — Tarif sans prix à la minute | L2-01, L2-03, L2-07, L9-04 |
| D16 — Service temps réel en TypeScript | L0-04, L3-* |
| D17 — Contrats dans `@babana/contracts` | C-01, C-02, L0-03, L6-03, L6-04 |
| D18 — VPS unique en Europe, sauvegardes hors hôte | L0-07, L8-08, L10-06 |
| D19 — Développement en mode simulé par défaut | L0-08, L1-01, L1-09, L2-05, L7-01, L10-01 |
| D20 — Interface générique au pilote | L0-03, L6-* |
| D21 — Valeurs par défaut plausibles et marquées provisoires | L2-01, L9-06, L0-06 |
| D22 — Version web du Client seulement | L6-18, L0-03, L6-01, L6-02 |

| Écart | Tâches porteuses |
|---|---|
| É1 — Auth Google au lieu d'OTP | L1-01, L1-09, L10-08 |
| É2 — Carte grise gérée par l'admin | L1-05, L1-07 |
| É3 — Salariat, pas de commission | Hors périmètre (§6) ; `babana.driver` de L1-03 ne doit pas interdire l'ajout ultérieur |
| É4 — Paiement espèces seulement | Hors périmètre (§6) |
| É5 — Odoo non mentionné au CDC | Justification d'architecture, sans tâche propre. Le coût qu'il introduit est traité par L3-* et L3-12 |
| É6 — Recette encaissée, pas revenus | L5-07 |
| É7 — Priorité par proximité sans objet | Hors périmètre (§6) ; réouverture pilotée par L9-08 |
| É8 — Itinéraire calculé sur modèle voiture | L2-05, L10-02, L10-03, L10-05 |
| É9 — Retrait du terme temps du tarif | L2-01, L2-03 |

**Sur É3** : c'est le seul écart hors périmètre qui impose une contrainte au code v1. Le modèle `babana.driver` doit être conçu de sorte que l'ajout d'un solde de commission ou d'un abonnement ne demande pas de migration structurelle. À vérifier lors de la revue de L1-03.
