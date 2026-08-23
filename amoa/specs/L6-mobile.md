# L6 — Applications mobiles

Décisions : D1 (deux apps, monorepo), D10 et D14 (le client choisit parmi 5), D11 (refus sans repli automatique), D12 (lien profond en v1), D13 (Google Maps derrière une abstraction), D20 (interface générique au pilote), D22 (export web du Client seulement).

**Règle transverse du lot** : aucune règle métier dans les apps. Ni calcul de tarif, ni décision d'affectation, ni validation de solde. L'app affiche ce que le serveur décide.

---

## L6-00 — Navigation et arborescence des écrans

### Objectif

Poser la structure dans laquelle tous les écrans des deux applications vivront.

### Contexte

**Créée le 21 août, après le rapport de J12 — c'est un trou de mon découpage, pas un manque d'exécution.** L6-06 et L6-08 s'enchaînent l'un l'autre sans qu'aucune tâche ne construise l'enchaînement. Le premier écran écrit (`SignInScreen`) reçoit un simple rappel faute d'un conteneur de navigation, choix volontairement minimal qui ne survivra pas au deuxième écran.

Cette fondation ne s'absorbe pas dans L6-06 : cette tâche est déjà de taille L, et la structure de navigation des deux applications serait alors décidée en passant, dans une tâche dont ce n'est pas le sujet.

### Fichiers

```
packages/navigation/src/           # types de routes partagés
apps/client/src/navigation/
apps/driver/src/navigation/
```

### Spécification

Une bibliothèque de navigation standard plutôt qu'un routeur maison — la question n'est pas la difficulté d'écrire un routeur, c'est le lien profond, le bouton retour Android, la restauration d'état et l'accessibilité, qu'un routeur maison réimplémentera mal pendant deux ans.

**Contrainte non négociable : l'export web du Client (D22).** La bibliothèque retenue doit fonctionner sous React Native Web. À vérifier avant de l'adopter, pas après.

**Les routes sont typées**, et leurs paramètres avec elles. Un écran qui reçoit un identifiant de course doit le recevoir typé, sinon la première refonte d'écran cassera silencieusement une navigation.

**Une garde d'authentification, au niveau de l'arborescence, jamais dans les écrans.** Un utilisateur sans session valide ne peut atteindre aucun écran métier. La perte de session en cours d'usage — jeton de renouvellement révoqué, `onSessionLost` de L6-02 — ramène à l'écran de connexion sans que chaque écran ait à s'en occuper.

**Les deux applications n'ont pas la même forme**, et l'arborescence doit le refléter plutôt que forcer une symétrie : le Client parcourt une séquence (accueil → estimation → attente → suivi → résumé), le Chauffeur vit sur un écran permanent que des événements interrompent (proposition reçue, course en cours). Ce qui se partage, ce sont les types de routes et la garde d'authentification, pas l'arborescence elle-même.

**Le chauffeur `pending` est routé vers son écran d'attente de dossier** (L6-15) — la donnée existe déjà dans la session (`driverStatus`, L6-02), rien ne la consomme encore.

### Critères d'acceptation

1. Les deux applications démarrent sur leur arborescence, et `SignInScreen` y est câblé plutôt que branché sur un rappel.
2. Un paramètre de route mal typé casse la compilation.
3. Sans session, aucun écran métier n'est atteignable — testé en tentant d'y naviguer directement.
4. La perte de session en cours d'usage ramène à la connexion, depuis n'importe quel écran.
5. Un chauffeur `pending` n'atteint pas les écrans de course.
6. **L'application Client s'ouvre dans un navigateur** (D22, D38 — critère réécrit le 24 août). La rédaction précédente demandait une compilation réussie. Le bundle a compilé pendant quatre nuits en affichant une page blanche : le fichier HTML ne chargeait jamais le script, et trois autres défauts attendaient derrière celui-là. Une compilation prouve qu'un assemblage est possible, pas qu'il fonctionne. Le critère est donc qu'on ait **ouvert la page et vu l'écran de connexion**, puis parcouru au moins un enchaînement d'écrans.
7. `configureMapsProvider` et `configureGoogleSignIn` sont appelés une fois au démarrage, à un endroit unique et nommé.

### Piège

Le bouton retour d'Android est le piège classique : un retour depuis l'écran de suivi de course ne doit pas ramener à l'écran d'estimation d'une course déjà commandée. L'arborescence doit distinguer ce qui s'empile de ce qui remplace.

---

## L6-01 — Abstraction carte et navigation

### Objectif

Isoler le SDK de carte derrière une interface interne (C3).

### Contexte

**À faire avant tout écran cartographique, pas après.** Une abstraction ajoutée après coup n'en est pas une : les écrans auront déjà fui vers le SDK et le basculement vers Mapbox redeviendra une réécriture. Le comparatif `02-comparatif-cartographie.md` laisse cette porte ouverte à condition que cette tâche soit faite en premier.

### Fichiers

```
packages/maps/src/
├── types.ts                  # interface publique
├── MapView.tsx               # composant carte
├── navigation.ts             # ouverture d'un guidage
├── places.ts                 # recherche de lieu
├── providers/google/         # implémentation
└── index.ts
packages/maps/test/
```

### Spécification

L'interface publique expose, et rien d'autre :

| Capacité | Rôle |
|---|---|
| Afficher une carte centrée, avec des marqueurs typés | Écrans client et chauffeur |
| Tracer un tracé | Suivi et résumé de course |
| Ouvrir un guidage vers un point | D12 : lien profond en v1, SDK embarqué en v2 |
| Rechercher un lieu et obtenir des coordonnées | Saisie de destination |
| Géocodage inverse d'un point vers un libellé | Désignation sur la carte |

Aucun type du SDK Google ne fuit dans l'interface publique. Les coordonnées, marqueurs et résultats de recherche sont des types propres au paquet.

`navigation.ts` en v1 construit une URL de lien profond vers Google Maps et l'ouvre. La signature de la fonction doit être **identique** à celle qu'aurait une navigation embarquée : lancer un guidage vers une destination, avec un rappel de fin. C'est cette identité de signature qui rendra la v2 indolore.

Règle de lint interdisant l'import du SDK hors de `packages/maps/src/providers/`.

### Critères d'acceptation

1. Aucun type du SDK n'apparaît dans l'interface publique.
2. Un import direct du SDK dans `apps/*` fait échouer le lint.
3. La fonction d'ouverture de guidage a une signature indépendante de son implémentation.
4. Le paquet est testable avec une implémentation simulée, sans SDK réel.
5. Une seconde implémentation vide compile contre l'interface — preuve que l'abstraction est réelle.
6. L'interface est conçue pour accueillir un fournisseur **web** (D22, L6-18) sans modification des écrans.

### Piège

Le point 5 est le vrai test. Une abstraction qui ne peut accueillir qu'une seule implémentation n'en est pas une. Écrire un fournisseur vide qui compile suffit à le prouver.

---

## L6-02 — Connexion Google

### Objectif

Authentifier l'utilisateur dans les deux apps.

### Fichiers

```
packages/api-client/src/auth/
apps/client/src/screens/SignInScreen.tsx
apps/driver/src/screens/SignInScreen.tsx
```

### Spécification

Google Sign-In natif, échange de l'ID token contre un jeton applicatif (L1-01).

**Deux chemins d'obtention de l'ID token** (D22) : Google Sign-In natif sur mobile, flux OAuth web pour l'export web du Client (L6-18). L'échange contre le jeton applicatif est strictement identique — seule l'obtention diffère. Les identifiants clients OAuth web et Android sont distincts et viennent tous deux de la configuration.

Stockage des jetons dans le **stockage sécurisé du système** — trousseau iOS, Keystore Android — jamais dans un stockage clé-valeur ordinaire.

Renouvellement transparent : une requête qui échoue en `TOKEN_EXPIRED` déclenche un renouvellement puis un réessai unique, sans que l'utilisateur voie quoi que ce soit. En cas d'échec du renouvellement, déconnexion propre avec message.

**Gérer explicitement l'absence de Google Play Services** : c'est le risque identifié sous É1. Message clair, et remontée d'une métrique — c'est cette mesure qui dira s'il faut rouvrir D4.

Le chauffeur non approuvé se connecte et arrive sur l'écran de suivi de dossier (L6-15), pas sur une erreur.

### Critères d'acceptation

1. Les jetons sont dans le stockage sécurisé du système.
2. Le renouvellement est transparent et ne réessaie qu'une fois.
3. L'échec du renouvellement déconnecte proprement.
4. L'absence de Google Play Services produit un message clair et une métrique.
5. Un chauffeur `pending` atteint son écran de suivi de dossier.
6. Les deux chemins d'obtention aboutissent au même échange contre le jeton applicatif — aucune duplication de la logique d'échange.

---

## L6-03 — Client API partagé

### Objectif

Un seul client HTTP pour les deux apps.

### Fichiers

```
packages/api-client/src/http/
├── client.ts
├── endpoints/
├── errors.ts
└── idempotency.ts
```

### Spécification

Client typé, construit sur les schémas de `@babana/contracts` : les types de requête et de réponse ne sont **jamais** redéclarés dans les apps.

Réessais automatiques sur erreur réseau et erreur serveur, avec temporisation croissante. **Jamais de réessai automatique sur une erreur métier** — un `DRIVER_ALREADY_TAKEN` rejoué ne produira jamais un succès et masquerait le vrai message.

Génération et transmission d'un identifiant d'idempotence sur toutes les écritures (L4-03).

Traduction du catalogue d'erreurs de C-01 en messages utilisateur en français. Une erreur inconnue produit un message générique et une remontée technique — jamais un code brut affiché à l'utilisateur.

Support JSON-RPC pour les lectures secondaires.

### Critères d'acceptation

1. Aucun type de requête ou réponse n'est redéclaré dans les apps.
2. Les erreurs réseau sont réessayées, les erreurs métier non.
3. Toute écriture porte un identifiant d'idempotence.
4. Chaque code du catalogue a un message français.
5. Un code inconnu produit un message générique, pas un code brut.

---

## L6-04 — Client WebSocket partagé

### Objectif

Une seule implémentation de la connexion temps réel.

### Fichiers

```
packages/api-client/src/realtime/
├── connection.ts
├── queue.ts
├── reconnect.ts
└── handlers.ts
```

### Spécification

Implémente C-02 côté client : connexion authentifiée, validation des messages entrants contre les schémas, émission typée.

Reconnexion avec temporisation croissante et **gigue aléatoire** (L3-11).

File d'attente locale persistante pour les actions émises hors connexion, rejouée dans l'ordre à la reconnexion, avec les identifiants d'origine. La file survit à un redémarrage de l'app.

Les positions ne sont pas mises en file : seule la dernière compte.

État de connexion exposé aux écrans, pour que l'interface puisse le montrer sans ambiguïté (L6-16).

Un message entrant non conforme au schéma est ignoré et signalé en métrique, il ne fait pas tomber l'app.

### Critères d'acceptation

1. La reconnexion applique temporisation croissante et gigue.
2. Une action émise hors connexion est rejouée à la reconnexion.
3. La file survit au redémarrage de l'app.
4. Les positions ne sont pas mises en file.
5. Un message non conforme est ignoré sans faire tomber l'app.

---

## L6-05 — Capture GPS

### Objectif

Émettre la position du chauffeur, sans vider sa batterie.

### Contexte

Risque identifié : un chauffeur dont la batterie tient trois heures désinstalle l'application, et la flotte se vide sans que personne comprenne pourquoi.

### Fichiers

```
apps/driver/src/location/
├── tracker.ts
├── adaptive.ts
├── background.ts
└── permissions.ts
```

### Spécification

**Fréquence adaptative** selon l'état :

| État | Fréquence |
|---|---|
| Hors ligne | Aucune capture |
| En ligne, immobile | Très faible |
| En ligne, en mouvement | Modérée |
| En course | Élevée |

L'immobilité se détecte sur la vitesse et le déplacement cumulé, pas sur un compteur seul.

Agrégation avant envoi : plusieurs positions accumulées sont envoyées en un message plutôt qu'une requête par point.

Fonctionnement en arrière-plan avec les permissions et le service de premier plan requis par Android, avec une notification persistante honnête sur ce qui est collecté.

**Gestion du refus de permission** : messages explicites, et l'app reste utilisable pour consulter la recette et l'historique. Un refus de permission ne doit pas rendre l'app inutilisable.

Arrêt de la capture dès le passage hors ligne. Une capture qui continue hors ligne est à la fois une consommation inutile et un problème de vie privée.

### Critères d'acceptation

1. Aucune capture hors ligne — test explicite.
2. La fréquence change effectivement selon les quatre états.
3. Les positions sont agrégées avant envoi.
4. La capture continue en arrière-plan avec notification persistante.
5. Le refus de permission laisse l'app utilisable en consultation.
6. Mesure de consommation réalisée (L6-17).

---

## L6-06 — App Client, écran d'accueil

### Objectif

La carte, les 5 chauffeurs proches, la désignation du départ et de l'arrivée.

### Fichiers

```
apps/client/src/screens/HomeScreen.tsx
apps/client/src/components/DriverMarker.tsx
apps/client/src/components/PlacePicker.tsx
```

### Spécification

Carte centrée sur la position du client. Les 5 chauffeurs disponibles affichés en marqueurs, mis à jour en direct (L3-05).

Désignation des points par **deux moyens** :

1. Déplacement de la carte sous un réticule fixe, avec géocodage inverse
2. Recherche de lieu par texte

**Le premier moyen est prioritaire dans la conception.** À Douala, l'adresse formelle n'existe quasiment pas et la navigation se fait par repères : un écran qui suppose une saisie d'adresse échouera. La désignation sur la carte doit être le chemin le plus court, la recherche textuelle un complément.

Le départ est pré-rempli avec la position courante, modifiable.

Aucun chauffeur disponible : message clair proposant de réessayer, sans écran d'erreur technique.

Les positions affichées sont arrondies (L3-05) : ne pas afficher de distance au mètre près, ce serait une précision mensongère.

**Trois précisions ajoutées le 23 août**, toutes issues des doutes que l'implémentation a soulevés d'elle-même. Aucune n'est un défaut de l'écran ; toutes les trois portent sur ce qu'un client réel comprendra.

**Le libellé rendu par le géocodage inverse est une indication, jamais un fait.** Dans les quartiers non cartographiés — la majeure partie de Douala hors des grands axes — l'API ne répond pas « je ne sais pas » : elle rend le repère connu le plus proche, qui peut être à plusieurs centaines de mètres du réticule. Un libellé affiché comme une adresse exacte est donc régulièrement faux, et rien ne l'indique. Il se présente sous une forme qui dit son approximation — « vers <lieu> » plutôt que le nom seul — et l'interface rappelle que **c'est le point sur la carte qui fait foi**. C'est une correction de formulation, pas un appel de plus.

**Les trois causes d'échec de la géolocalisation ne se ressemblent pas et ne doivent pas produire le même écran.** Un refus de permission se règle dans les réglages du téléphone ; un GPS indisponible se règle en sortant d'un bâtiment ; un délai dépassé se règle en réessayant. Les confondre dans un unique message générique laisse l'utilisateur sans la seule information qui lui servirait — quoi faire. Le départ reste désignable à la main dans les trois cas.

**Un abonnement refusé pour limitation de débit doit se voir.** Le serveur ignore silencieusement un abonnement au-delà de la limite (L3-05) : un client qui tape plusieurs fois « Réessayer » peut donc cesser d'être servi sans qu'aucun élément ne le lui dise. C-02 gagne un accusé de réception pour `nearby.subscribe`, et l'écran distingue « aucun chauffeur à proximité » de « votre demande n'a pas été prise en compte, patientez » — deux situations que rien ne distingue aujourd'hui, et qui appellent des réactions opposées.

### Critères d'acceptation

1. Les deux moyens de désignation fonctionnent.
2. La désignation sur carte est atteignable sans passer par la recherche.
3. Les chauffeurs se mettent à jour en direct.
4. L'absence de chauffeur produit un message clair, pas une erreur.
5. Aucune distance affichée avec une précision supérieure à celle des données.

---

## L6-07 — Estimation et choix du chauffeur

### Objectif

Montrer le prix, laisser le client choisir parmi les 5 (D10, D14).

### Fichiers

```
apps/client/src/screens/QuoteScreen.tsx
apps/client/src/components/DriverCard.tsx
```

### Spécification

Après désignation, appel à `/quote` (L2-04). Affichage du montant, du **détail décomposé** — prise en charge, distance, coefficient éventuel, remise — de la distance et de la durée estimée corrigée.

Le détail est visible, pas caché derrière un dépliant. C'est la transparence promise au CDC §I.3, et sur un marché où l'on négocie le prix à l'arrivée, un montant sans explication sera contesté.

Liste des 5 chauffeurs : prénom, photo, note ou mention « nouveau » (L4-09), gamme de moto, distance approximative. Le client en choisit un.

Choix de la gamme si plusieurs sont disponibles, avec relance de l'estimation.

Compte à rebours de validité de l'estimation. À l'expiration, proposer de réactualiser plutôt que d'échouer.

**Aucun calcul de tarif dans l'app.** Le montant vient du serveur, il n'est ni recalculé ni ajusté localement.

**La liste des chauffeurs continue de vivre pendant que le client compare** (ajouté le 24 août). La première implémentation transmettait un cliché depuis l'écran d'accueil et coupait l'abonnement en changeant d'écran. C'est correct et sûr — le serveur reste l'arbitre, et un chauffeur pris entre-temps produit `DRIVER_ALREADY_TAKEN` —, mais l'erreur arrive au pire moment : celui où le client vient de choisir. Or c'est précisément l'écran où il prend son temps, puisqu'il compare.

L'abonnement reste donc actif : un chauffeur qui n'est plus disponible disparaît ou se grise **avant** qu'on le touche. Le mécanisme existe déjà (L3-05), il s'agit de ne pas l'interrompre.

### Critères d'acceptation

1. Le détail décomposé est visible sans interaction supplémentaire.
2. Les 5 chauffeurs sont affichés avec les seules données autorisées par C-02.
3. Un chauffeur sans avis suffisants est marqué « nouveau ».
4. L'expiration propose une réactualisation.
5. Aucun calcul de montant n'est effectué dans l'app — vérifié par revue et par absence de logique tarifaire.

---

## L6-08 — Attente, refus, nouvelle sélection

### Objectif

Gérer le refus sans attribution automatique (D11).

### Contexte

C'est le parcours où le risque d'abandon se joue. L9-09 le mesurera ; cet écran détermine ce qui sera mesuré.

### Fichiers

```
apps/client/src/screens/WaitingScreen.tsx
apps/client/src/screens/DriverRejectedScreen.tsx
```

### Spécification

Après sélection, écran d'attente avec compte à rebours et possibilité d'annuler.

Sur refus ou expiration : message honnête — « ce chauffeur n'est pas disponible » — et **retour immédiat à la sélection**, avec une liste actualisée excluant les refusants (L3-08). Pas d'écran intermédiaire, pas de confirmation à cliquer : chaque étape ajoutée ici est un abandon supplémentaire.

Après plusieurs refus consécutifs, ne pas insister avec le même message : varier, et proposer explicitement d'élargir la recherche.

`NO_DRIVER_AVAILABLE` : message clair et bouton de réessai. Ne pas laisser croire qu'une recherche continue en arrière-plan alors qu'il n'y en a pas.

**Instrumenter chaque abandon** : à quel rang de refus, après combien de temps. C'est la donnée de L9-09.

### Critères d'acceptation

1. Le refus ramène à la sélection sans écran intermédiaire.
2. Les chauffeurs ayant refusé n'apparaissent plus.
3. Le message varie après plusieurs refus.
4. `NO_DRIVER_AVAILABLE` produit un message clair sans fausse attente.
5. Les abandons sont instrumentés avec leur rang et leur délai.

---

## L6-09 — Suivi de course et résumé

### Objectif

Voir le chauffeur arriver, puis suivre le trajet.

### Fichiers

```
apps/client/src/screens/TrackingScreen.tsx
apps/client/src/screens/RideSummaryScreen.tsx
```

### Spécification

Phase d'approche : position du chauffeur en direct, ETA, coordonnées du chauffeur pour l'appeler, immatriculation et gamme de la moto pour l'identifier.

Phase de course : position en direct, tracé, destination.

Accès permanent au partage de trajet (L8-03) et au bouton d'urgence (L8-04). Ces deux fonctions doivent être atteignables en un geste depuis cet écran, pas enfouies dans un menu — leur utilité tient entièrement à leur accessibilité en situation de stress.

**Et si L8-03 et L8-04 n'existent pas encore, ces boutons sont absents, jamais inertes** (précision du 25 août). Un bouton d'urgence qui ne fait rien est pire que pas de bouton du tout : quelqu'un finira par compter dessus au mauvais moment. La même règle vaut partout ailleurs dans ce projet — une absence explicite plutôt qu'une présence trompeuse — mais elle se dit ici, parce que c'est le seul écran où l'illusion peut coûter davantage qu'une course.

Résumé de fin : distance, durée, montant, détail décomposé, notation (L4-09), accès à la facture.

Si la connexion est perdue, l'écran affiche le dernier état connu avec un indicateur explicite, pas une position figée qu'on croirait à jour.

### Critères d'acceptation

1. L'immatriculation et la gamme sont visibles pendant l'approche.
2. Partage et urgence sont atteignables en un geste.
3. La perte de connexion est signalée explicitement.
4. Le résumé contient le détail décomposé.
5. La notation est proposée après la course, sans être bloquante.

---

## L6-10 — Historique et factures client

### Objectif

Consulter ses courses passées.

### Fichiers

```
apps/client/src/screens/HistoryScreen.tsx
apps/client/src/screens/InvoiceScreen.tsx
```

### Spécification

Liste paginée : date, départ, arrivée, montant, statut. Détail d'une course avec le tracé et le détail tarifaire.

Facture téléchargeable en PDF, envoyable par email (CDC §III.3), à la demande.

Chargement progressif, pas de récupération de tout l'historique au premier affichage.

### Critères d'acceptation

1. La pagination fonctionne et respecte le plafond serveur.
2. Le PDF se télécharge.
3. L'envoi par email fonctionne.
4. Le détail tarifaire d'une course ancienne reste correct après changement de grille.

---

## L6-11 — Bascule en ligne / hors ligne

### Objectif

Le chauffeur se rend disponible (D7).

### Fichiers

```
apps/driver/src/screens/HomeScreen.tsx
apps/driver/src/components/AvailabilityToggle.tsx
```

### Spécification

Interrupteur visible en permanence, avec l'état courant sans ambiguïté.

**Chaque refus de passage en ligne affiche son motif précis** (L3-04) : dossier non approuvé, aucune moto affectée, assurance expirée, permis expiré, plafond d'encaisse atteint. Un refus générique fait appeler le support ; un motif précis fait agir le chauffeur.

Quand le motif est le plafond, proposer directement l'accès à la déclaration de remise (L5-07).

Un chauffeur en course ne peut pas se mettre hors ligne : l'interrupteur est désactivé, avec explication.

Indicateur de connexion au service temps réel, distinct de l'état en ligne : un chauffeur peut se croire disponible alors que sa connexion est tombée.

### Critères d'acceptation

1. Chaque motif de refus affiche un message distinct.
2. Le motif « plafond » propose l'accès à la remise.
3. L'interrupteur est désactivé en course, avec explication.
4. L'état de connexion est distinct de l'état en ligne.

---

## L6-12 — Réception de proposition

### Objectif

Le chauffeur voit la course et décide.

### Fichiers

```
apps/driver/src/screens/ProposalScreen.tsx
apps/driver/src/components/CountdownRing.tsx
```

### Spécification

Affichage plein écran, réveil de l'appareil, signal sonore et vibration. Un chauffeur en circulation ne regarde pas son écran : la proposition doit s'imposer.

Contenu : départ, arrivée, distance, montant, distance à parcourir jusqu'au client, compte à rebours.

Boutons accepter et refuser, **dimensionnés pour un usage à une main avec des gants**. C'est une contrainte réelle : le chauffeur est sur sa moto.

Le compte à rebours est indicatif ; le serveur est seul juge. Une acceptation tardive qui échoue affiche un message compréhensible — « cette course a été attribuée » — pas une erreur technique.

À l'expiration, retour automatique à l'écran d'accueil sans action requise.

### Critères d'acceptation

1. La proposition réveille l'appareil et produit signal sonore et vibration.
2. Les boutons respectent une taille minimale de cible tactile.
3. Une acceptation tardive affiche un message compréhensible.
4. L'expiration ramène à l'accueil automatiquement.
5. Deux propositions ne peuvent pas s'afficher simultanément.

---

## L6-13 — Course en cours et navigation

### Objectif

Guider le chauffeur, gérer le déroulé (D12).

### Fichiers

```
apps/driver/src/screens/ActiveRideScreen.tsx
apps/driver/src/navigation/launch.ts
```

### Spécification

Deux phases : approche vers le client, puis trajet vers la destination.

Bouton de navigation appelant `packages/maps` (L6-01), qui ouvre Google Maps en lien profond. **L'app doit rester fonctionnelle en arrière-plan** : la capture GPS continue, l'état de course est préservé, le retour dans l'app retrouve l'écran attendu.

Coordonnées du client accessibles pour l'appeler pendant la course.

Boutons de démarrage et de fin de course, avec confirmation sur la fin — une fin déclenchée par erreur est pénible à rattraper.

Bouton d'urgence accessible.

Gestion du retour depuis Google Maps : l'app ne doit pas se réinitialiser ni perdre l'état de la course.

### Critères d'acceptation

1. Le lien profond ouvre Google Maps vers le bon point.
2. La capture GPS continue quand l'app est en arrière-plan.
3. Le retour depuis Google Maps retrouve l'écran de course.
4. La fin de course demande confirmation.
5. L'appel du client fonctionne pendant la course.

---

## L6-14 — Confirmation d'encaissement

### Objectif

Le chauffeur confirme avoir reçu les espèces.

### Fichiers

```
apps/driver/src/screens/SettlementScreen.tsx
```

### Spécification

Affichage du montant dû, **sans champ de saisie** : le chauffeur confirme, il ne déclare pas (L4-05). Autoriser une saisie ouvrirait la sous-déclaration.

Après confirmation : nouveau solde et marge restante avant plafond.

Si l'encaissement franchit le plafond, message explicite indiquant le passage hors ligne et proposant la déclaration de remise.

Fonctionne hors connexion : la confirmation est mise en file et rejouée (L6-16). Un chauffeur ne doit pas rester bloqué sur un écran parce que le réseau est tombé.

### Critères d'acceptation

1. Aucun champ de saisie de montant.
2. Le nouveau solde et la marge s'affichent après confirmation.
3. Le franchissement du plafond est annoncé explicitement.
4. La confirmation hors connexion est mise en file et rejouée.
5. Une confirmation rejouée ne produit pas de double encaissement.

---

## L6-15 — Inscription chauffeur

### Objectif

Créer le compte, téléverser les documents, suivre la validation.

### Contexte

É2 : **pas de carte grise à téléverser** — elle appartient à la flotte. Permis et pièce d'identité seulement.

### Fichiers

```
apps/driver/src/screens/onboarding/
├── ProfileScreen.tsx
├── DocumentsScreen.tsx
└── PendingScreen.tsx
```

### Spécification

Parcours : connexion Google, informations personnelles, téléversement du permis avec sa date d'expiration, téléversement de la pièce d'identité, vérification du numéro de téléphone (L1-09), puis attente de validation.

Prise de photo depuis l'app avec cadrage guidé, ou choix dans la galerie. Compression avant envoi — une photo de dix mégaoctets sur un réseau mobile camerounais ne partira jamais.

Écran d'attente montrant l'état de chaque document, et en cas de rejet, le motif et la possibilité de renvoyer la pièce concernée seulement.

Le parcours est **reprenable** : un chauffeur qui ferme l'app au milieu retrouve son avancement.

### Critères d'acceptation

1. Le parcours est reprenable après fermeture de l'app.
2. Les photos sont compressées avant envoi.
3. Le rejet d'un document permet de le renvoyer seul.
4. Aucune demande de carte grise.
5. L'état de chaque document est visible.

---

## L6-16 — Mode dégradé réseau

### Objectif

Fonctionner sur un réseau intermittent.

### Contexte

**À concevoir dès le départ, pas ajouté à la fin.** Le réseau intermittent à Douala n'est pas un cas limite, c'est le cas courant. Une app qui suppose le réseau disponible est à réécrire.

### Fichiers

```
packages/api-client/src/offline/
apps/client/src/components/ConnectionBanner.tsx
apps/driver/src/components/ConnectionBanner.tsx
```

### Spécification

**Indicateur de connexion permanent** dans les deux apps, avec trois états distincts : connecté, dégradé — les actions sont en file — et hors ligne. L'utilisateur doit toujours savoir si ce qu'il voit est à jour.

File d'attente persistante des actions d'écriture, rejouée dans l'ordre avec les identifiants d'idempotence.

Actions autorisées hors connexion : confirmation d'encaissement, fin de course, déclaration de remise, notation. Ce sont celles qu'un utilisateur ne peut pas différer.

Actions **interdites** hors connexion : sélection d'un chauffeur, acceptation d'une proposition. Elles dépendent d'un état serveur qui aura changé — les mettre en file produirait des échecs incompréhensibles plus tard. Le refuser tout de suite est plus honnête.

Toute donnée affichée depuis un cache porte son horodatage. Une position figée qu'on croit à jour est pire qu'une absence d'information.

### Critères d'acceptation

1. L'indicateur distingue les trois états.
2. Les actions autorisées hors connexion sont mises en file et rejouées.
3. Les actions interdites hors connexion sont refusées immédiatement avec explication.
4. La file survit au redémarrage de l'app.
5. Toute donnée en cache affiche son horodatage.
6. Un rejeu ne produit pas de double effet.

---

## L6-17 — Mesure batterie et données

### Objectif

Vérifier que l'app Chauffeur est utilisable une journée entière.

### Contexte

**Ce n'est pas une tâche de confort.** Un chauffeur dont la batterie tient trois heures désinstalle l'application.

### Fichiers

```
docs/measurements/battery-data.md
apps/driver/src/telemetry/
```

### Spécification

Protocole de mesure sur au moins deux terminaux d'entrée de gamme représentatifs du parc réel, pas sur un téléphone de développeur.

Scénarios : huit heures en ligne sans course, huit heures avec un rythme de courses réaliste, une heure en course continue.

Relever : consommation batterie par heure, volume de données par heure, comportement thermique.

**Seuils d'acceptation à définir avant la mesure**, pas après — sinon le résultat obtenu deviendra le seuil.

Si les seuils ne sont pas tenus, les leviers dans l'ordre : réduire la fréquence en immobilité, augmenter l'agrégation, réduire la fréquence de diffusion, revoir le mode arrière-plan.

### Critères d'acceptation

1. Les mesures sont faites sur des terminaux d'entrée de gamme.
2. Les seuils étaient définis avant la mesure.
3. Les trois scénarios sont couverts.
4. Le rapport est versionné dans le dépôt.
5. Si un seuil n'est pas tenu, les optimisations sont appliquées et la mesure refaite.

---

## L6-18 — Export web de l'application Client

### Objectif

Une adresse à transmettre pour démontrer l'application Client, sans installation.

### Contexte

D22. **L'application Chauffeur est explicitement exclue** : la capture GPS en arrière-plan (L6-05) s'arrête quand l'onglet passe en arrière-plan, et la proposition de course (L6-12) ne peut pas réveiller l'appareil depuis un navigateur. Une version web du Chauffeur serait une démonstration trompeuse.

**Ce n'est pas une cible de test qui fasse foi.** L6-16 et L6-17 mesurent précisément ce que le web ne reproduit pas. Les APK sur terminaux d'entrée de gamme restent la seule preuve.

### Fichiers

```
apps/client/
├── index.web.tsx
├── webpack.config.js            # ou équivalent selon l'outillage retenu
└── vercel.json
packages/maps/src/providers/web/  # troisième implémentation
packages/api-client/src/auth/web.ts
```

### Spécification

Export web de `apps/client` via React Native Web, déployé en site statique.

**Implémentation web de `@babana/maps`** : le SDK natif de carte n'existe pas sur le web. Écrire un fournisseur web derrière la même interface que le fournisseur natif (L6-01). Aucun écran ne change — c'est le test réel de l'abstraction. Si un écran doit être modifié pour fonctionner en web, l'abstraction est incomplète et c'est elle qu'il faut corriger.

**Second chemin d'authentification** : flux OAuth web au lieu de Google Sign-In natif. L'échange contre le jeton applicatif est identique (L1-01) — seule l'obtention de l'ID token diffère. Les identifiants clients OAuth web et Android sont distincts, tous deux dans la configuration.

**Dégradations signalées, jamais masquées.** Trois fonctions sont absentes ou dégradées sur le web : notifications push, capture de position en arrière-plan, lien profond de navigation. L'application doit l'indiquer explicitement à l'utilisateur plutôt que de faire semblant. Un bandeau discret précisant que la version web est une démonstration suffit.

**Aucune branche conditionnelle dans les écrans.** Les différences de plateforme vivent dans les paquets partagés — `@babana/maps`, `@babana/api-client` — jamais dans `apps/client/src/screens`. Un écran truffé de `if (Platform.OS === 'web')` annonce quinze écrans dans le même état six mois plus tard.

**Aucune session n'est persistée sur le web (D39, 24 août).** Le stockage sécurisé du natif s'appuie sur le trousseau du système ; un navigateur n'a rien d'équivalent, et tout ce qu'on range dans son stockage local est lisible par n'importe quelle injection de script. Un jeton de renouvellement y serait une session entière offerte, survivant à l'expiration du jeton d'accès.

L'implémentation web du stockage de jetons garde donc la session **en mémoire seulement** : fermer l'onglet déconnecte, rouvrir demande une reconnexion Google — deux clics, la session Google du navigateur étant déjà ouverte. C'est une dégradation, et elle rejoint les trois autres du paragraphe précédent : elle **se signale**, elle ne se masque pas.

Le contournement posé le 24 août pour vérifier le bundle — un stockage local qui ne chiffre rien — est explicitement provisoire et disparaît avec cette tâche.

Déploiement sur Vercel, en prévisualisation par branche. La version web pointe sur `staging.babana.cm` par défaut, jamais sur la production — une démonstration ne doit pas créer de vraies courses.

### Critères d'acceptation

1. L'application Client se charge et permet le parcours complet — estimation, sélection, suivi, résumé — dans un navigateur.
2. **Aucun écran n'a été modifié** pour permettre l'export web : seuls les paquets partagés ont changé.
3. Aucun `Platform.OS === 'web'` dans `apps/client/src/screens`.
4. Les trois fonctions dégradées sont signalées à l'utilisateur.
5. L'application Chauffeur n'a **pas** d'export web, et la configuration de build l'empêche explicitement.
6. La version déployée pointe sur l'environnement de recette, pas sur la production.
7. Chaque branche produit une prévisualisation.

### Piège

Le critère 2 est celui qui donne sa valeur à la tâche. S'il faut modifier des écrans, c'est que `packages/maps` ou `packages/ui` fuit — et cette fuite coûtera aussi cher le jour où D13 sera rouverte en faveur de Mapbox. Corriger l'abstraction, pas l'écran.
