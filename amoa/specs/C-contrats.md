# Contrats préalables — C-01 à C-03

Ces trois tâches ne produisent pas de fonctionnalité. Elles produisent les artefacts sans lesquels backend, temps réel et mobile ne peuvent pas avancer en parallèle sans produire du travail à jeter.

**Elles passent avant tout code, y compris avant le socle technique.** C-03 en particulier n'a aucune dépendance : c'est de la conception, faisable immédiatement.

---

## C-03 — Machine à états de la course

*À faire en premier. Bloque tout le domaine.*

### Objectif

Produire la table de transitions exhaustive de `babana.ride`, qui servira de référence à L4-02 et à tous les endpoints du cycle de vie.

### Contexte

`01-architecture.md` §6 : les transitions sont les **seules portes d'écriture** sur la course. Toute écriture directe de champ contournant une transition est un bug de conception.

Décisions contraignantes : D10 (le client choisit son chauffeur, d'où l'état `proposée`), D11 (le refus ramène à la sélection sans créer de nouvelle course), D9 (paiement espèces uniquement en v1).

### Fichiers

`docs/contracts/ride-state-machine.md`

### Spécification

États : `draft`, `requested`, `proposed`, `assigned`, `in_progress`, `completed`, `settled`, `cancelled`, `rejected`.

Pour **chaque** transition, documenter :

| Colonne | Contenu |
|---|---|
| Depuis / Vers | États source et cible |
| Déclencheur | Action ou événement |
| Acteur | Client, chauffeur, système, superviseur |
| Préconditions | Ce qui doit être vrai avant |
| Effets | Écritures, appels sortants, notifications |
| Irréversible | Oui ou non |

Transitions à couvrir au minimum :

- `draft → requested` — le client valide l'estimation
- `requested → proposed` — le client sélectionne un chauffeur ; réservation atomique côté temps réel (L3-06)
- `proposed → assigned` — le chauffeur accepte
- `proposed → rejected` — le chauffeur refuse ou le délai expire
- `rejected → proposed` — le client sélectionne un autre chauffeur, **sur la même course** (D11)
- `assigned → in_progress` — le chauffeur démarre la course
- `in_progress → completed` — le chauffeur termine ; consolidation distance, durée, montant
- `completed → settled` — encaissement confirmé
- `requested → cancelled`, `proposed → cancelled`, `assigned → cancelled`, `rejected → cancelled` — annulations, règles distinctes selon l'état et l'acteur
- `in_progress → cancelled` — **par le chauffeur uniquement**, cas exceptionnel : panne, accident, agression. Motif obligatoire, signalement au back-office, course sans encaissement isolée dans les indicateurs. Interdite au client : une fois le trajet commencé, il ne peut pas y mettre fin unilatéralement (voir L4-07)

Documenter également la **liste des transitions interdites** et la raison de chacune. Notamment : rien ne sort de `settled` ni de `cancelled` ; `completed` ne revient jamais à `in_progress` ; une course ne passe jamais de `requested` à `assigned` sans passer par `proposed` ; le client ne peut pas annuler depuis `in_progress`.

**`draft` n'est jamais persisté.** L'objet antérieur à la course est l'estimation (`babana.quote`, L2-04) ; le premier enregistrement `babana.ride` naît directement en `requested`. `draft` figure dans la liste pour décrire le cycle conceptuel, pas pour exister en base — le documenter explicitement évite qu'un développeur crée un état mort.

Préciser pour chaque état **quels champs deviennent immuables**. Après `completed`, la distance et le montant ne changent plus. Après `settled`, plus rien ne change.

### Critères d'acceptation

1. Chaque état de la liste apparaît au moins une fois en source et une fois en cible, sauf `draft` (jamais cible, jamais persisté) et `settled` et `cancelled` (jamais source — états terminaux).
2. L'historique des refus est explicitement porté par la course, pas par une nouvelle course à chaque refus.
3. Chaque transition dont la colonne Effets comporte une écriture Odoo correspond à un **événement métier** de la liste du §2 de l'architecture. Aucune écriture n'est déclenchée par le temps écoulé, la distance parcourue ou l'expiration d'un compte à rebours sans effet métier.
4. `in_progress → cancelled` est autorisée pour le chauffeur, interdite pour le client, et son effet inclut un signalement au back-office.
5. Un développeur qui lit ce document peut implémenter L4-02 sans poser de question.

### Piège

La tentation sera de simplifier en supprimant `proposed` et en passant directement de `requested` à `assigned`. Ne pas le faire : c'est cet état qui rend le refus traçable et qui matérialise la réservation atomique de L3-06. Sans lui, un chauffeur peut être « réservé » sans qu'aucune donnée ne l'atteste.

---

## C-01 — Contrat d'API mobile ↔ Odoo

### Objectif

Spécifier les endpoints REST critiques, sous forme de types TypeScript et de schémas de validation dans `@babana/contracts`, plus une documentation lisible.

### Contexte

`01-architecture.md` §5 : **toutes** les lectures mobiles passent par des contrôleurs explicites (D35, 22 août). La rédaction précédente réservait les lectures secondaires — historique, factures, profil — au JSON-RPC natif, qui n'accepte pas notre jeton applicatif : Odoo y authentifie par session de cookie ou par identifiants explicites. Elles entrent donc dans ce contrat comme le reste.

D17 : le contrat est du code, pas un document que quelqu'un oublie de mettre à jour.

### Fichiers

```
packages/contracts/src/
├── errors.ts                 # catalogue partagé C-01 + C-02
└── http/
    ├── auth.ts
    ├── quote.ts
    ├── ride.ts
    ├── settlement.ts
    ├── remittance.ts
    ├── driver.ts
    ├── phone.ts
    ├── common.ts
    └── index.ts
docs/contracts/http-api.md        # généré ou rédigé, lisible
```

### Spécification

Préfixe commun `/api/v1`. Authentification par jeton applicatif en en-tête `Authorization: Bearer`, **sauf sur les trois routes de gestion de jeton** — `/auth/google`, `/auth/refresh` et `/auth/logout` — qui s'authentifient par le jeton transmis dans le corps.

**Pourquoi cette exception** (relevée en implémentant L1-02) : `/auth/refresh` existe précisément pour le cas où le jeton d'accès a expiré. Exiger un jeton d'accès valide pour le renouveler rend le mécanisme inutilisable au moment exact où il sert. Le jeton de renouvellement transmis dans le corps est déjà la preuve de possession suffisante ; sa vérification se fait contre le hachage stocké côté serveur.

**Corps de `/auth/google`** : `{ idToken, role }` où `role` vaut `client` ou `driver`. Le rôle est **obligatoire** — rien d'autre dans la requête ne permet de savoir s'il faut créer un chauffeur ou un client au premier appel, et l'email ne peut pas servir d'indice puisqu'il n'est jamais l'identifiant (L1-01).

**`GET /me` existe parce que son absence a produit un détournement** (D35). Rien ne renvoyait le profil de l'utilisateur courant : seuls `/auth/google` et `/auth/refresh` le portaient, parce que le profil figurait dans la liste des « lectures secondaires » abandonnées au JSON-RPC. Le code applicatif s'est donc mis à appeler `/auth/refresh` à chaque démarrage pour récupérer le statut du chauffeur — un renouvellement de jeton déclenché non pas parce que le jeton avait expiré, mais parce qu'il n'y avait pas d'autre façon de lire un profil. Avec la rotation de L1-02, cela multipliait par le nombre de démarrages les occasions de perdre une famille de jetons.

La réponse de `/me` porte le même objet utilisateur que celui d'une session — même schéma, une seule définition.

**Réponse d'une session** : elle porte, quand `role` vaut `driver`, le statut de validation du chauffeur (`pending`, `approved`, `rejected`, `suspended`). L'authentification ne rejette jamais un chauffeur non approuvé — elle lui renvoie un jeton et un statut explicite, et ce sont les endpoints métier qui refusent ses actions. `DRIVER_NOT_APPROVED` n'est donc **jamais** émis par `/auth/google`.

**Casse des champs** : le contrat est en camelCase (`idToken`), y compris quand une spécification de tâche écrit le nom en snake_case dans sa prose. Le contrat fait foi sur le format de fil (D17).

**La charge utile du jeton d'accès fait partie du contrat** (D23, posée le 15 août). Un jeton d'accès est lu par deux implémentations indépendantes — Odoo l'émet en Python, le service temps réel le vérifie en TypeScript sans jamais appeler Odoo (L1-02, L3-01). C'est un format de fil comme un autre, et la règle de D17 s'y applique : il ne se déclare qu'une fois.

```
packages/contracts/src/auth/access-token.ts   # AccessTokenClaimsSchema
```

Claims, nommés d'après RFC 7519 quand un claim enregistré existe :

| Claim | Type | Rôle |
|---|---|---|
| `sub` | UUID | `res.users.babana_public_id` — l'utilisateur |
| `role` | `client` \| `driver` | |
| `driverId` | UUID, présent si et seulement si `role` vaut `driver` | `babana.driver.public_id`, **distinct de `sub`** |
| `iat`, `exp` | entiers, secondes epoch | |
| `jti` | UUID | identifiant unique du jeton |

`sub`, pas `uid` : c'est le claim enregistré pour le sujet, et une bibliothèque JWT tierce le comprendra sans configuration. `driverId` est obligatoire sur un jeton chauffeur — sans lui le service temps réel ne peut pas indexer la connexion sans appeler Odoo, ce que la spécification lui interdit.

Le jeton de renouvellement, lui, **n'est pas un JWT** et n'entre pas dans ce contrat : c'est une valeur opaque dont seul le haché est stocké (L1-02). Rien de ce qui le concerne ne doit être vérifiable hors d'Odoo.

**Cette règle est née d'un défaut réel** : Odoo émettait `uid`, le service temps réel exigeait `sub`, et chaque côté était vert parce qu'il testait sa propre forme inventée. Toute connexion WebSocket réelle aurait été refusée. Le test qui l'aurait révélé traverse les deux services et n'appartenait à aucune tâche — c'est pour cela que le critère 5 ci-dessous existe.

Endpoints à spécifier :

| Méthode | Chemin | Rôle |
|---|---|---|
| POST | `/auth/google` | Échange d'un ID token Google contre un jeton applicatif |
| POST | `/auth/refresh` | Renouvellement |
| POST | `/auth/logout` | Révocation |
| GET | `/me` | Profil de l'utilisateur courant, statut chauffeur compris |
| POST | `/quote` | Estimation : départ, arrivée, promo éventuelle → montant, distance, ETA |
| POST | `/rides` | Création d'une demande à partir d'une estimation |
| POST | `/rides/{id}/select-driver` | Sélection d'un chauffeur parmi les 5 proposés |
| POST | `/rides/{id}/start` | Démarrage |
| POST | `/rides/{id}/complete` | Fin, consolidation |
| POST | `/rides/{id}/settle` | Encaissement espèces |
| POST | `/rides/{id}/cancel` | Annulation |
| POST | `/rides/{id}/rate` | Notation par le client |
| GET | `/drivers/nearby` | Les 5 chauffeurs les plus proches (D14) |
| POST | `/drivers/me/availability` | Bascule en ligne / hors ligne |
| GET | `/drivers/me/cash` | Solde courant, plafond, encaissé du jour |
| POST | `/remittances` | Déclaration de remise par le chauffeur |
| POST | `/phone/verify/start` | Envoi de l'OTP de rattachement |
| POST | `/phone/verify/confirm` | Confirmation de l'OTP |

Pour chaque endpoint : schéma de requête, schéma de réponse, codes HTTP, erreurs possibles.

**Codes d'erreur** — un catalogue nommé, stable, indépendant du HTTP. Au minimum : `DRIVER_ALREADY_TAKEN`, `CASH_LIMIT_REACHED`, `RIDE_INVALID_TRANSITION`, `NO_DRIVER_AVAILABLE`, `QUOTE_EXPIRED`, `PHONE_ALREADY_VERIFIED`, `TOKEN_EXPIRED`, `DRIVER_NOT_APPROVED`.

Le catalogue est **partagé entre C-01 et C-02** : un même code peut être émis par un endpoint HTTP ou par un message WebSocket. `NO_DRIVER_AVAILABLE`, par exemple, n'est émis par aucun endpoint HTTP — il vient du service temps réel après épuisement de l'élargissement du rayon (L3-08). Le catalogue vit donc dans `packages/contracts/src/errors.ts`, à la racine du paquet, pas sous `http/`.

**Identifiants publics** — tout identifiant qui traverse le contrat est un UUID opaque, jamais l'identifiant interne d'Odoo. Un entier séquentiel exposé dans une API publique se devine, se compte et révèle le volume d'activité. Chaque modèle atteignable depuis le mobile porte donc un `public_id` distinct de sa clé primaire. Règle générale posée le 15 août, après que L4-03 l'a appliquée à `babana.ride` et `babana.driver` sans qu'aucune spécification ne la formule.

**Idempotence** — l'identifiant voyage dans l'en-tête `Idempotency-Key`, convention REST courante, plutôt que dans le corps : les schémas de corps n'ont pas à porter de mécanique de transport. Seules les transitions **réellement appliquées** sont mises en cache — rejouer un appel qui a échoué pour raison métier est sans risque, et parfois nécessaire puisque la condition qui l'a fait échouer peut avoir changé.

**Versionnement** — le préfixe `/v1` est figé. Toute rupture de compatibilité crée `/v2`, elle ne modifie pas `/v1`. Documenter cette règle explicitement : une app installée sur le téléphone d'un chauffeur ne se met pas à jour à la demande.

**Acceptation et refus ne sont pas des endpoints HTTP** (D31, 17 août). `/rides/{id}/accept` et `/rides/{id}/reject` ont été retirés de ce tableau. Ils y figuraient depuis la première rédaction, et L4-03 les a implémentés en appelant directement la machine à états — créant un second chemin d'écriture à côté de la résolution atomique du service temps réel. C'est le défaut D26 remonté d'un cran : un état à deux écrivains, dont l'un ne connaît pas l'autre.

Le chauffeur accepte et refuse par `proposal.accept` / `proposal.reject` (C-02), sur la connexion qui lui a présenté la proposition. Le service temps réel résout atomiquement, puis écrit la transition dans Odoo par le canal interne. Un seul chemin, une seule résolution.

**Attention en retirant ces endpoints** : les scénarios de concurrence de L4-11 les utilisent pour prouver le verrouillage d'Odoo, qui reste nécessaire — le service temps réel écrit toujours ses transitions dans Odoo. Ces tests visent désormais les routes internes, ils ne disparaissent pas avec les endpoints publics.

**Durée de validité de l'estimation** — une estimation a une date d'expiration. Passée cette date, `/rides` la refuse avec `QUOTE_EXPIRED`. Sinon un client peut faire estimer à 6h du matin et commander à 18h au tarif creux.

### Critères d'acceptation

1. `@babana/contracts` compile et exporte un type et un schéma de validation par requête et par réponse.
2. Des schémas JSON sont générés dans `packages/contracts/dist/json-schema/`, consommables par les contrôleurs Odoo en Python.
3. Chaque endpoint a au moins un exemple de requête et un exemple de réponse.
4. Le catalogue d'erreurs est exhaustif : aucun endpoint ne peut renvoyer une erreur non listée.
5. **Un test de bout en bout obtient un jeton par `/auth/google` et ouvre avec lui une connexion WebSocket acceptée.** Il tourne contre les deux services réels, pas contre des jetons fabriqués par le test. Aucune suite propre à un service ne peut le remplacer : c'est précisément l'accord entre les deux qu'il vérifie.

---

## C-02 — Contrat d'événements temps réel

### Objectif

Spécifier les messages WebSocket dans les deux sens, plus la politique de reconnexion et de rattrapage d'état.

### Contexte

D16 : le service temps réel est en TypeScript, donc ce contrat est importé à l'identique par les apps et par le serveur. Un message mal formé devient une erreur de compilation.

`01-architecture.md` §2 : tout ce qui transite ici est éphémère. Aucun message ne porte une décision métier définitive — la vérité reste dans Odoo.

### Fichiers

```
packages/contracts/src/realtime/
├── client-to-server.ts
├── server-to-client.ts
├── envelope.ts
└── index.ts
docs/contracts/realtime-events.md
```

### Spécification

**Enveloppe commune** : type du message, identifiant unique, horodatage d'émission. L'identifiant sert à l'idempotence côté réception — un message rejoué après reconnexion ne doit pas produire deux effets.

**Chauffeur vers serveur** : `position.update` (latitude, longitude, précision, vitesse, cap), `availability.set`, `proposal.accept`, `proposal.reject`, `ride.start`, `ride.complete`.

**Client vers serveur** : `nearby.subscribe` (position, rayon), `nearby.unsubscribe`, `ride.track` (abonnement au suivi d'une course).

**Serveur vers chauffeur** : `proposal.new` (course, départ, arrivée, montant, distance, délai restant), `proposal.expired`, `ride.cancelled`, `cash.limit.warning`.

**Serveur vers client** : `nearby.drivers` (les 5 plus proches, position arrondie), `ride.proposed`, `ride.assigned`, `ride.rejected`, `driver.position` (suivi), `ride.started`, `ride.completed`.

**Politique de reconnexion** — à spécifier précisément, c'est ce qui sera oublié sinon :

- Reconnexion avec temporisation croissante et gigue aléatoire, pour éviter que mille chauffeurs se reconnectent en même temps après une coupure réseau.
- À la reconnexion, le client envoie son dernier état connu ; le serveur répond par un message de resynchronisation complet plutôt que par un différentiel.
- Les actions émises hors connexion sont mises en file locale et rejouées à la reconnexion, dans l'ordre, avec leur identifiant d'origine pour que le serveur puisse les dédupliquer.
- Une position vieille de plus de N secondes est ignorée par le serveur, pas rejouée : rejouer une position obsolète est pire que la perdre.

**Précision des positions diffusées aux clients** — les positions envoyées dans `nearby.drivers` sont arrondies. Spécifier la précision retenue : assez fine pour que l'affichage soit crédible, assez grossière pour que la flotte ne soit pas cartographiable (C2b).

### Critères d'acceptation

1. Chaque message a un nom, un schéma de validation et **un émetteur unique** — aucun message n'est envoyable dans les deux sens.
2. La politique de reconnexion est écrite, y compris le comportement des messages en file d'attente.
3. Le schéma de `nearby.drivers` ne contient aucune donnée personnelle au-delà du prénom, de la photo, de la note et de la gamme de moto. Ni nom complet, ni téléphone, ni immatriculation.
4. Les paquets `apps/client`, `apps/driver` et `services/realtime` importent tous ce contrat ; aucun ne définit ses propres types de message.

### Piège

Le point 3 est facile à violer sans y penser, en renvoyant l'objet chauffeur complet parce que c'est plus simple. Le schéma doit décrire exactement les champs autorisés et la validation doit rejeter le surplus, pas seulement le champ manquant.
