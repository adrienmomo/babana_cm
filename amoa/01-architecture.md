# babana.cm — Document d'architecture

**Version** 1.2 — 9 août 2026
**Statut** À valider
**Source** Cahier des charges « Application de transport en moto » (C. Mbong, 8 juillet 2026)

Ce document fige les décisions d'architecture avant découpage en tâches techniques. Il ne décrit pas le *quoi* (le CDC s'en charge) mais le *comment*, et surtout les *pourquoi* — pour que chaque tâche technique en dérive sans réinterprétation.

---

## 1. Décisions retenues

| # | Décision | Alternative écartée | Raison |
|---|---|---|---|
| D1 | Deux apps **React Native** distinctes (Client, Chauffeur), monorepo à code partagé | App unique bi-mode | Parcours, permissions et cycles de release trop différents |
| D2 | **Odoo 18 Community auto-hébergé** comme backend métier et back-office | Odoo.sh, Odoo Online | Odoo Online interdit le code custom ; auto-hébergement requis pour cohabiter avec le service temps réel |
| D3 | **Service temps réel dédié** (WebSocket + Redis) pour GPS et dispatch | Tout dans Odoo (`bus.bus`) | Odoo sature dès quelques centaines de chauffeurs actifs sur des écritures haute fréquence |
| D4 | **Google Sign-In** comme unique moyen d'authentification | OTP SMS (prévu au CDC §VII.1) | Choix maître d'ouvrage : zéro coût SMS, zéro friction. Voir écart É1 |
| D5 | **Chauffeurs salariés** en phase 1 | Commission par course, abonnement | Décision maître d'ouvrage. Commission et/ou abonnement en phase ultérieure |
| D6 | **Motos propriété de l'entreprise**, affectation durable chauffeur–moto | Motos personnelles | Cohérent avec D5. Voir écart É2 |
| D7 | Disponibilité chauffeur par **interrupteur en ligne / hors ligne** | Prise et fin de service, planning admin | Décision maître d'ouvrage. Impose la conséquence C1, traitée au §7 |
| D8 | **Compte courant chauffeur** avec plafond d'encaisse bloquant | Remise liée à la fin de service | Conséquence de D7 : sans clôture de service, le contrôle doit être un plafond |
| D9 | MVP pilote : boucle de course complète, **paiement espèces uniquement** | Mobile Money dès le MVP | Les agréments marchands MTN/Orange sont un délai administratif hors de notre contrôle |
| D10 | **Le client choisit son chauffeur** en v1 (CDC §II.2) | Matching automatique par proximité (CDC §IV.2) | Décision maître d'ouvrage. Supprime le moteur de matching de la v1, introduit la conséquence C2 |
| D11 | En cas de refus, **retour à la sélection manuelle**, sans attribution automatique | Bouton « prenez le plus proche » en repli | Décision maître d'ouvrage. Risque d'abandon à surveiller en pilote |
| D12 | Navigation par **lien profond vers Google Maps** en v1, navigation assistée in-app prévue en v2 | Turn-by-turn embarqué dès la v1 | Coût et consommation batterie disproportionnés au MVP. Impose l'abstraction C3 |
| D13 | **Google Maps** comme fournisseur de carte, derrière une abstraction interne | Mapbox | Couverture des points d'intérêt à Douala nettement supérieure ; plugin Navigation React Native officiel. Voir `02-comparatif-cartographie.md` |
| D14 | Le client se voit proposer les **5 chauffeurs les plus proches** | Tous les chauffeurs du rayon | Décision maître d'ouvrage. Limite l'exposition de la flotte (C2b) et rend le choix praticable sur un petit écran |
| D15 | Tarif = **base + distance × prix au km**, majoré par un **coefficient de zone et d'heure de pointe**. **Pas de prix à la minute** | Facturation à la minute, prix ferme calculé sur le devis | Conséquence directe d'É8 : la durée disponible avant la course est une durée voiture. Le salariat (D5) retire au terme temps sa raison d'être. Voir écart É9 |
| D23 | La **charge utile du jeton d'accès est un contrat partagé** (`AccessTokenClaimsSchema`, C-01), claims nommés d'après RFC 7519 : `sub`, `role`, `driverId`, `iat`, `exp`, `jti` | Chaque service déclare la forme qu'il attend | Deux implémentations lisent ce jeton sans jamais se parler. Elles ont divergé — `uid` contre `sub` — en restant vertes chacune de son côté. Voir §5 |
| D24 | En cas d'indisponibilité de l'API de routage, **une entrée de cache périmée est servie** plutôt qu'une erreur, si elle existe pour la même clé | Erreur stricte dans tous les cas | Un itinéraire déjà calculé par la vraie API n'est pas une estimation dégradée. Sans ce repli, une panne du fournisseur arrête toute la plateforme |
| D25 | Un **échec de sérialisation PostgreSQL se rejoue**, il ne se traduit jamais en erreur métier. Le rejeu est celui d'Odoo, à la frontière HTTP — notre code ne l'attrape pas | Traduction en `RIDE_INVALID_TRANSITION` ; rejeu maison dans le modèle | Une transition valide était refusée dix-neuf fois sur vingt selon la microseconde de l'instantané. Et le rejeu existait déjà un niveau au-dessus. Voir §2 bis |
| D26 | **Toute écriture sur le pool des chauffeurs disponibles passe par un seul script atomique**, qui porte l'unique définition de l'éligibilité — en ligne, non réservé, non engagé | Chaque appelant ajoute au pool selon sa propre logique | Une réservation atomique ne vaut rien si un autre chemin remet le chauffeur dans le pool. Voir §2 ter |
| D27 | **Le service temps réel lit Odoo ; Odoo n'écrit jamais dans Redis.** Un seul sens de dépendance, un seul canal interne, deux formes de charge utile (L3-15, L3-16) | Poussée événementielle d'Odoo vers Redis | Plus frais, mais donne à Odoo une dépendance Redis et toute la réconciliation qui va avec. Une note affichée trente secondes en retard ne coûte rien |
| D28 | **Plafond d'encaisse : montant fixe pour toute la flotte**, paramétrable, 50 000 FCFA au départ | Plafond par chauffeur ; plafond en nombre de courses | Un plafond par chauffeur crée une inégalité que quelqu'un devra justifier ; un plafond en courses est décorrélé de l'encaisse réelle. Voir §7 |
| D29 | **Un écart de caisse est accepté et reste au solde du chauffeur**, où il continue de peser sur le plafond | Refus de la remise ; écart sorti du compte courant | Le logiciel enregistre un fait, il ne prend aucune décision RH. Et un écart qui ne pèse nulle part est un écart que personne ne regarde. Voir §7 |
| D30 | **Une donnée de profil manquante dégrade l'affichage d'un chauffeur, elle ne le retire jamais de la flotte.** Champs à `null`, jamais omission | Omettre le chauffeur | L'omission a produit un blocage total : aucun profil en cache, donc aucune liste, donc aucune course possible. Un défaut de cache ne doit pas rendre quelqu'un invisible |
| D31 | **Acceptation et refus n'ont qu'un chemin d'écriture** : `proposal.accept` / `proposal.reject` en temps réel, puis transition Odoo par le canal interne. Les endpoints HTTP publics sont retirés | Endpoints HTTP en parallèle du temps réel | D26 remonté d'un cran : un état à deux écrivains, dont l'un ignore l'autre |
| D32 | **Un appel sortant vers le service temps réel se déclenche au commit de la transaction Odoo, jamais pendant** | Appel direct dans le contrôleur, synchrone ou en fil de fond | Une transaction rejouée ou annulée aurait déjà modifié Redis pour une décision qui n'a pas eu lieu. Voir §2 ter |
| D33 | **Un appel au commit ne s'enregistre jamais depuis l'intérieur d'un savepoint** : l'intention est retenue, puis enregistrée à la sortie réussie du bloc | Enregistrement au point où l'effet se produit | Le point d'accroche au commit ignore les savepoints. Or ce dépôt annule des savepoints dans des transactions qui commitent ensuite pour renvoyer leur erreur. Voir §2 ter |
| D34 | **La créance sur le chauffeur n'est soldée qu'à hauteur du montant réellement reçu.** Le compte d'écart n'intervient qu'au moment où une décision humaine éteint la dette | Reclasser l'écart hors de la créance dès la remise | Deux systèmes prétendaient dire ce que le chauffeur doit, et disaient le contraire. Voir §7 |
| D35 | **Toutes les lectures mobiles passent par des contrôleurs explicites sous `/api/v1`.** Le JSON-RPC natif est abandonné pour les apps | JSON-RPC natif pour les lectures secondaires | Il n'accepte pas notre jeton applicatif. L'économie promise se paierait par un pont d'authentification maison. Voir §5 |
| D36 | **La rotation du jeton de renouvellement a une fenêtre de grâce** : un jeton consommé depuis peu renvoie le même couple qu'à son premier usage, au lieu de révoquer la famille | Révocation stricte à toute réutilisation | Sur un réseau intermittent, une coupure entre l'envoi et la réception du nouveau jeton déconnectait l'utilisateur de tout. Voir §5 |

---

## 2. La règle de partition

C'est la décision la plus structurante du projet. Tout le découpage en découle.

> **Une écriture Odoo par événement métier, jamais par tick GPS.**
>
> **Le nombre d'écritures d'une course est borné par le nombre de décisions humaines qu'elle a comportées — jamais par sa durée ni par sa distance.**

**Révision du 10 août 2026.** La première version de cette règle énumérait « quatre moments » d'écriture. Ce compte a été invalidé par D10 : la sélection du chauffeur par le client introduit une boucle proposition–refus–resélection, et l'annulation possède quatre points d'entrée. Compter les écritures était fragile ; l'intention, elle, n'a pas changé. La formulation ci-dessus l'exprime sans compteur, et elle reste vraie quel que soit le nombre d'événements métier ajoutés plus tard.

**Événements qui écrivent dans Odoo**

| Événement | Écrit |
|---|---|
| Création de la demande | La course, à l'état `requested` |
| Proposition à un chauffeur | Le chauffeur sélectionné, l'horodatage |
| Acceptation | L'affectation |
| Refus ou expiration | Une ligne à l'historique des refus de la course |
| **Démarrage de la course** | Le passage en course, horodaté |
| Annulation, depuis n'importe quel état | L'état terminal, l'acteur, le motif |
| Fin de course | Distance, durée, tracé archivé en une seule écriture |
| Encaissement | Le règlement, le mouvement de compte courant, la facture |

**Ce qui n'écrit jamais** : position, ETA, distance en cours d'accumulation, compte à rebours, expiration d'une réservation non suivie d'effet. Tout cela vit dans Redis et sur le WebSocket.

**Complément du 11 août 2026 — le démarrage.** L'énumération initiale omettait le démarrage de la course. L'oubli a été révélé par le code : sans écriture à cette transition, la précondition de la fin de course n'est jamais satisfaite et aucune course ne peut se terminer. Le démarrage est une décision humaine du chauffeur, et elle doit survivre à une panne du service temps réel — si celui-ci tombe en pleine course, il faut savoir que la course avait commencé, et depuis quand.

Cet épisode illustre le bénéfice de la reformulation. Sous la règle des « quatre moments », il aurait fallu débattre de l'existence d'un cinquième. Sous « borné par les décisions humaines », la réponse est immédiate : le chauffeur a décidé de démarrer, donc cela écrit. Le critère n'est pas la place dans une liste, c'est la nature de l'événement.

**L'invariant est testable, et il doit l'être.** Une course de cinq minutes et une course de quarante-cinq minutes, comportant le même nombre de décisions, produisent exactement le même nombre d'écritures Odoo. Un test qui compte les écritures sur deux courses de durées très différentes échoue si quelqu'un ajoute une écriture proportionnelle au temps. C'est cette vérification qui protège la règle, pas le fait de l'avoir écrite ici.

**Corollaire, à traiter comme un invariant de conception :** le service temps réel ne possède **aucune donnée durable**. S'il tombe, on perd les positions de l'instant et les courses en cours de matching — jamais une course confirmée ni un franc encaissé. Cet invariant doit être vérifiable par un test : couper le service temps réel en pleine course, le redémarrer, la course doit se retrouver et se terminer correctement.

**Ce qui appartient à qui**

| Donnée | Propriétaire | Durabilité |
|---|---|---|
| Position chauffeur, géo-index des disponibles | Redis | Éphémère, TTL court |
| Proposition de course en attente, timeout d'acceptation | Redis | Éphémère |
| Distance et durée en cours d'accumulation | Redis | Éphémère jusqu'à la fin de course |
| Course, tarif appliqué, facture, encaissement | Odoo / PostgreSQL | Source de vérité |
| Chauffeur, moto, affectation, documents | Odoo / PostgreSQL | Source de vérité |
| Grille tarifaire, zones, promotions | Odoo / PostgreSQL | Source de vérité |
| Compte courant chauffeur, remises de caisse | Odoo / PostgreSQL | Source de vérité, écritures comptables |

---

## 2 bis. Concurrence : ce qui est un fait métier, ce qui ne l'est pas

**Un échec de sérialisation PostgreSQL n'est pas une réponse à l'utilisateur (D25).** Sous `REPEATABLE READ`, deux transactions qui touchent la même ligne peuvent produire un `SerializationFailure`. La base dit alors une chose précise : *ton instantané est périmé, rejoue-moi.* Elle ne dit rien sur la validité de la demande.

Le 14 août, ce refus remontait en erreur technique brute ; nous l'avons traduit en `RIDE_INVALID_TRANSITION`. C'était un progrès et c'était encore faux. La traduction est juste quand les deux transitions concurrentes s'excluent — deux acceptations sur la même proposition — et fausse dès qu'elles s'enchaînent. Une annulation client arrivant juste après une acceptation chauffeur est valide : `assigned` est annulable. Elle était pourtant refusée dans l'immense majorité des cas, et honorée dans les autres, selon la microseconde où PostgreSQL avait pris son instantané. Le client recevait « transition invalide » pour une annulation légitime.

**La règle qui en découle vaut au-delà des courses** : rejouer la transaction un nombre borné de fois, en repartant d'un instantané neuf, et ne conclure à une erreur métier qu'après avoir relu l'état et constaté que la précondition est réellement violée. Une erreur de concurrence se rejoue ; une erreur métier se renvoie. Les confondre revient à répondre à l'utilisateur avec un détail d'implémentation de la base.

**Et le corollaire de test** : une paire de transitions divergentes ne prouve pas l'exclusion mutuelle. Il faut une paire réellement exclusive pour cela. Un test qui exige « exactement un succès » d'une paire qui peut légitimement en produire deux ne teste pas la concurrence — il fige une erreur de raisonnement, et il finit par être assoupli plutôt que compris.

**Où vit le rejeu — précision du 16 août.** Pas dans notre code. `odoo.service.model.retrying` enveloppe déjà **toute requête HTTP** et la rejoue sur curseur neuf, borné, en journalisant chaque tentative. Un rejeu écrit dans le modèle ne peut pas fonctionner : sous `REPEATABLE READ`, l'instantané est fixé à l'ouverture de la transaction, si bien que réessayer dans la même transaction retombe indéfiniment sur le même instantané périmé. Notre seule responsabilité est donc **de ne rien attraper** : laisser `SerializationFailure`, `LockNotAvailable` et `DeadlockDetected` traverser nos contrôleurs jusqu'à Odoo. Vu ainsi, la traduction du 14 août ne faisait pas que mal nommer l'erreur — elle la **cachait** au mécanisme qui savait la traiter.

Conséquence à ne pas perdre de vue quand un contrôleur appellera le service temps réel : **une requête rejouée rejoue tout ce qu'elle contient**, y compris un appel sortant. Un appel non idempotent placé dans une transaction rejouable s'exécutera deux fois.

---

## 2 ter. Le pool des chauffeurs disponibles n'a qu'un écrivain (D26)

Le 16 août, la réservation atomique a été livrée avec un script Lua irréprochable — et l'invariant qu'elle porte était cassé quand même. `ingestPosition` remettait le chauffeur dans le pool à chaque position reçue, sans rien savoir de la réservation. Un chauffeur réservé y revenait en quelques secondes, et un second client pouvait le gagner.

**L'atomicité d'une opération ne protège rien si l'état qu'elle garde a plusieurs écrivains.** La question n'est jamais « cette opération est-elle indivisible ? » mais « cet état a-t-il un seul chemin d'écriture ? ». Ici : un seul script porte l'entrée au pool, et il porte l'unique définition de l'éligibilité — en ligne, non réservé, non engagé. Aucun `GEOADD` direct ne subsiste ailleurs, et c'est vérifiable par recherche plutôt que par relecture.

**Le corollaire, découvert le 17 août (D32) : un effet hors de la base ne doit jamais partir avant le commit.** L'annulation d'une course déclenchait, depuis le contrôleur, le relâchement de la réservation et l'effacement de l'engagement côté Redis — dans un fil de fond, mais surtout **pendant la transaction**. Or D25 dit qu'Odoo rejoue ou annule une transaction en conflit. Une annulation qui échoue au commit laisse alors Redis dans l'état d'une annulation qui n'a pas eu lieu : le chauffeur revient au pool alors que sa course est toujours vivante.

C'est le même raisonnement que D26, appliqué à travers la frontière des deux services. À l'intérieur d'une base, la transaction protège de ça toute seule ; dès qu'un effet sort de la base, plus rien ne le rattrape. Tout appel sortant se déclenche donc **au commit**, jamais avant. Odoo fournit ce point d'accroche ; il ne se remplace pas par un fil de fond, qui répond à une autre question — la latence, pas l'atomicité.

**Et le corollaire du corollaire (D33), trouvé le 19 août en relisant l'encaissement.** Le point d'accroche au commit **ignore les savepoints** : un rappel enregistré à l'intérieur d'un savepoint survit à l'annulation de ce savepoint et s'exécute quand même, dès lors que la transaction englobante commite.

Ce n'est pas une bizarrerie théorique ici, parce que ce dépôt commite délibérément des transactions dont un savepoint a été annulé : c'est ainsi qu'un contrôleur renvoie une erreur métier propre après un conflit. Les deux idiomes — savepoint pour l'erreur, accroche au commit pour l'effet externe — sont chacun corrects et ne composent pas.

La règle est donc de les séparer dans le temps : **l'intention est retenue pendant le savepoint, enregistrée après sa sortie réussie.** Écrit autrement : un effet qui sort de la base ne s'annonce qu'une fois qu'on sait qu'il a vraiment eu lieu, et le savepoint est précisément l'endroit où on ne le sait pas encore.

**Réservation et engagement sont deux états distincts, et c'est leur durée qui les sépare.** Une réservation expire vite, parce qu'un chauffeur qui ne répond pas doit être libéré. Une course n'a pas de durée prévisible : un embouteillage ne doit pas remettre au pool un chauffeur qui transporte quelqu'un. Confondre les deux revient à borner la durée d'une course par un délai d'acceptation.

---

## 3. Sélection du chauffeur par le client

D10 remplace le moteur de matching par une sélection manuelle. C'est un simplificateur majeur — plus de broadcast, plus de règle de priorité, plus de stratégie de repli — mais il introduit trois problèmes qui n'existent pas dans un système à attribution automatique.

**C2a — La réservation du chauffeur est une section critique.**
Deux clients qui sélectionnent le même chauffeur au même instant doivent produire un gagnant et un perdant, jamais deux gagnants. La réservation doit être une **opération atomique unique** côté service temps réel : le chauffeur est retiré du pool disponible dans le même geste que la création de la proposition. Un contrôle en deux temps — lire l'état puis écrire — laisse une fenêtre de course. Le bug qui en résulte est intermittent, invisible en test unitaire et coûteux en production : deux clients persuadés d'avoir le même chauffeur.

À traiter comme une exigence testable : un test de charge qui lance N sélections concurrentes sur le même chauffeur doit produire exactement un succès.

**C2b — La flotte devient publiquement observable.**
Pour choisir, le client doit voir la position, la photo, la note et le type de moto de chaque chauffeur disponible autour de lui. N'importe quel client peut donc cartographier la flotte en continu. Garde-fous à intégrer dès la conception, pas après : rayon de recherche plafonné, nombre de chauffeurs retournés plafonné, position arrondie à une précision utile mais non exploitable, et limitation de débit sur l'endpoint.

**C2c — L'utilisation de la flotte sera inégale.**
Les chauffeurs bien notés seront choisis, les nouveaux ne démarreront jamais. Sur un modèle à la commission, ce serait le problème du chauffeur ; avec D5, c'est l'entreprise qui paie des salariés que personne ne sélectionne. Le back-office doit donc exposer un **indicateur de courses par chauffeur** dès le pilote — c'est la donnée qui dira s'il faut réintroduire une attribution automatique.

Combiné à D11, l'enchaînement de refus n'a aucun filet : le client rechoisit à la main autant de fois que nécessaire. Le **taux d'abandon après refus** est à instrumenter dès le pilote, c'est l'indicateur qui déclenchera la réouverture de D11.

---

## 4. Couches et responsabilités

**Apps React Native (Client, Chauffeur)**
Rendu, carte, capture GPS, WebSocket. Aucune règle métier : ni calcul de tarif, ni décision d'affectation, ni validation de solde. L'app affiche ce que le serveur décide. Cette discipline est ce qui permet de corriger une règle tarifaire sans passer par les stores.

**Service temps réel**
Ingestion des positions, géo-index des chauffeurs disponibles, **réservation atomique du chauffeur** (§3), diffusion du suivi au client, accumulation distance et durée. Sans état durable. Pas de moteur de matching en v1, conséquence de D10.

**Module Odoo `babana`**
Modèle de domaine, règles métier, contrôleurs exposés au mobile, back-office. Source de vérité.

**Back-office Odoo natif**
Validation des chauffeurs, gestion de flotte, grilles tarifaires, promotions, validation des remises de caisse, rapports. Vues Odoo standard — c'est ici que le choix d'Odoo se rentabilise : §V du CDC est couvert quasi sans développement d'interface.

**Services externes**
Google Identity (authentification), Google Maps SDK et API de routage (carte, itinéraire, ETA — D13), Firebase Cloud Messaging (notifications push, CDC §III.4 et §IV.1). Chacun est un point de défaillance externe : aucun ne doit pouvoir bloquer une course en cours. Une notification push perdue ne doit jamais être le seul canal d'information — l'état est toujours re-lisible depuis le serveur à l'ouverture de l'app.

**C3 — Abstraction carte et navigation (D12, D13)**
Aucun écran n'importe directement le SDK de carte. Une interface interne — afficher une carte, tracer un tracé, ouvrir un guidage vers un point, chercher un lieu — avec une implémentation par fournisseur. En v1, l'implémentation « ouvrir un guidage » est un lien profond vers Google Maps ; en v2, elle devient le Navigation SDK sans qu'aucun écran ne change. Sans cette abstraction, le choix de fournisseur devient irréversible et la navigation in-app promise en v2 se paie en réécriture. Le comparatif détaillé est dans `02-comparatif-cartographie.md`.

**Partage de trajet (CDC §II.6)**
Le partage d'un trajet avec un proche implique une **route publique non authentifiée**, consultable dans un navigateur par quelqu'un qui n'a pas l'application. Conséquences de conception : jeton opaque non devinable, expiration à la fin de la course plus un délai court, et exposition stricte du minimum — position et ETA, jamais l'identité du client ni son historique.

---

## 5. Authentification

Google Sign-In seul (D4) impose deux points techniques non négociables.

**Un contrôleur Odoo custom est inévitable.** Le endpoint natif `/web/session/authenticate` attend `db / login / password`. Aucun mécanisme Odoo standard n'accepte un ID token Google. Il faut donc un contrôleur qui vérifie la signature du token auprès des certificats Google, contrôle `aud` et `iss`, puis ouvre la session ou émet un jeton applicatif.

**Conséquence de portée :** dès lors qu'un module custom avec contrôleurs existe, l'argument du « JSON-RPC natif pour tout » perd son intérêt.

**Correction du 22 août (D35) : le JSON-RPC natif est abandonné pour les applications mobiles.** La rédaction précédente réservait les lectures secondaires — historique, factures, profil — au JSON-RPC natif, et les chemins critiques aux contrôleurs explicites. Le partage tenait sur une hypothèse jamais vérifiée : que le JSON-RPC natif accepte notre jeton applicatif. Il ne l'accepte pas. Odoo y authentifie par session de cookie ou par `(db, uid, password)` explicites ; ni l'un ni l'autre ne comprend un porteur Bearer.

L'économie que cette décision promettait — ne pas écrire de contrôleur pour chaque lecture — se paierait donc par un pont d'authentification maison, c'est-à-dire par du code d'authentification réécrit à côté de celui qui existe. C'est cher, et c'est le genre de code où une erreur ne se voit pas.

**Toutes les lectures mobiles passent désormais par des contrôleurs explicites sous `/api/v1`**, comme les écritures. Un seul mécanisme d'authentification, un seul contrat (C-01), un seul format de fil. Quelques contrôleurs de plus, et plus aucun pont.

Cette décision a une conséquence immédiate qu'il faut nommer : **le profil de l'utilisateur courant n'avait aucun endpoint**, précisément parce qu'il figurait dans la liste des « lectures secondaires ». Son absence a poussé le code applicatif à appeler `/auth/refresh` à chaque démarrage pour récupérer le statut du chauffeur — un détournement, et un détournement coûteux (voir D36). `GET /me` comble le manque.

**Le jeton d'accès est un format de fil, pas un détail d'implémentation (D23).** Odoo l'émet en Python ; le service temps réel le vérifie en TypeScript, localement, sans jamais appeler Odoo — c'est ce qui lui permet de tenir une connexion par chauffeur. Les deux côtés ne se parlent donc jamais au sujet du jeton : ils n'ont que leur accord sur sa forme. Le 15 août, cet accord n'existait pas. Odoo émettait `uid`, le service temps réel exigeait `sub` et refusait tout jeton qui n'en portait pas. Aucune suite de tests ne l'a vu, parce que chaque côté fabriquait ses propres jetons pour se tester. En production, aucune connexion temps réel n'aurait jamais été acceptée.

La leçon dépasse le cas : **la règle de source unique de D17 ne s'arrête pas aux requêtes et aux messages.** Toute valeur lue par deux implémentations indépendantes est un contrat, y compris quand elle voyage dans un en-tête ou dans une signature. Et un test qui ne traverse qu'un seul service ne peut pas prouver un accord entre deux — d'où le critère 5 de C-01, qui prend un jeton réellement émis et ouvre une connexion réelle avec.

Corollaire pratique : le jeton d'un chauffeur porte `driverId` (`babana.driver.public_id`), distinct de `sub` (`res.users.babana_public_id`). Sans lui, le service temps réel ne peut pas savoir quel chauffeur est au bout d'une connexion sans appeler Odoo — ce qui lui est interdit.

**La rotation du jeton de renouvellement a une fenêtre de grâce (D36, 22 août).** La règle d'origine était juste dans son intention : un jeton de renouvellement déjà consommé qui réapparaît est le signe d'un vol, et révoquer toute la famille est la bonne réaction. Elle supposait un réseau qui livre ou qui échoue franchement.

Le réseau de Douala ne fait ni l'un ni l'autre. Une coupure entre l'envoi du jeton et la réception de son remplaçant laisse l'ancien consommé côté serveur et aucun nouveau côté téléphone. Au redémarrage suivant, l'application présente le seul jeton qu'elle possède — consommé — et se fait révoquer toute sa famille. Le chauffeur est déconnecté en pleine journée, sans comprendre pourquoi, et l'événement ressemble exactement à un vol dans les journaux.

**Un jeton consommé depuis moins de quelques dizaines de secondes renvoie donc le même couple qu'à son premier usage**, au lieu de déclencher la révocation — le même principe que l'idempotence des écritures, appliqué à l'authentification : rejouer une opération dont on n'a pas reçu la réponse doit redonner la réponse, pas punir. Au-delà de la fenêtre, la réutilisation redevient ce qu'elle est censée signaler.

**Vérification du numéro de téléphone.** Google Sign-In ne fournit pas de numéro vérifié. Le numéro reste indispensable : le chauffeur doit pouvoir appeler le client, et le Mobile Money de la phase 2 en dépendra. Un numéro saisi au clavier et jamais vérifié est un risque à assumer explicitement. Mitigation recommandée, à coût quasi nul : **un seul OTP dans la vie du compte**, au moment du rattachement du numéro — pas à chaque connexion.

---

## 6. Modèle de domaine — esquisse

Les noms sont indicatifs, à figer au démarrage du développement.

- **`babana.driver`** — hérite ou référence `hr.employee` (D5). Statut de validation, documents, note moyenne, état en ligne / hors ligne, plafond d'encaisse, solde courant, compteur de courses (indicateur d'équité de §3).
- **`babana.motorcycle`** — flotte de l'entreprise (D6) : immatriculation, carte grise, assurance et son échéance, gamme (standard / premium, cf. CDC §II.2), affectation au chauffeur.
- **`babana.ride`** — la course. Machine à états explicite : `brouillon → demandée → proposée → affectée → en_cours → terminée → encaissée`, plus `annulée` et `refusée`. L'état `proposée` existe parce que le client désigne un chauffeur précis (D10) qui peut refuser ; `refusée` ramène le client à la sélection (D11) sans créer une nouvelle course, afin que les refus successifs restent traçables sur une même demande. Départ, arrivée, distance, durée, tarif appliqué, polyline, moyen de paiement, chauffeur sélectionné, historique des refus.
- **`babana.fare.rule`** — grille tarifaire : base, prix au km, zone, plage horaire, coefficient d'heure de pointe (CDC §V.3). **Pas de prix à la minute** (D15). Le champ durée reste néanmoins enregistré sur la course, pour calibrer l'ETA, mesurer la productivité et rendre possible une réintroduction ultérieure du terme temps.
- **`babana.promotion`** — code promo, conditions, compteur d'usage.
- **`babana.cash.remittance`** — remise de caisse : chauffeur, montant, superviseur, écriture comptable liée.
- **`babana.incident`** — bouton d'urgence et signalements (CDC §II.6, §VII.4).
- Facturation : réutiliser `account.move` d'Odoo plutôt qu'un modèle maison. Le PDF, la numérotation légale et l'envoi par email demandés au CDC §III.3 sont alors gratuits.

**Machine à états de la course.** Les transitions doivent être les seules portes d'écriture sur `babana.ride`. Toute écriture directe de champ contournant une transition est un bug de conception. C'est ce qui garantit qu'une course ne peut pas être encaissée deux fois, ni terminée sans avoir démarré, ni affectée à deux chauffeurs.

---

## 7. Gestion de la recette espèces

Point absent du cahier des charges, et risque numéro un du pilote.

Un chauffeur salarié qui encaisse des espèces détient des fonds appartenant à l'entreprise. Sans traçabilité, il n'existe aucun moyen de savoir si la recette rentre.

**Mécanisme retenu (D8)**

1. Chaque course payée en espèces incrémente le solde courant du chauffeur.
2. Le solde est un compte courant permanent, pas un solde de session — cohérent avec D7.
3. Un plafond d'encaisse est paramétré dans le back-office. Au-delà, le chauffeur ne peut plus accepter de nouvelle course.
4. La remise à un superviseur remet le solde à zéro et génère l'écriture comptable Odoo.

**Deux paramètres arbitrés le 17 août** (maîtrise d'ouvrage), après huit nuits pendant lesquelles le lot L5 a été tenu à l'écart faute de les avoir posés.

**Le plafond est un montant fixe pour toute la flotte**, paramétrable en back-office, valeur de départ 50 000 FCFA à confirmer en pilote. Écarté : un plafond par chauffeur, qui crée une inégalité visible que quelqu'un devra justifier à voix haute ; et un plafond en nombre de courses, décorrélé du risque réel — dix courses courtes ne portent pas la même encaisse que dix longues.

**Un écart de caisse est accepté et porté en dette (D29).** Le superviseur valide ce qui est réellement remis ; la différence reste au solde du chauffeur et **continue de compter dans son plafond**. Trois conséquences voulues :

- Le logiciel ne prend aucune décision de ressources humaines. Il enregistre un fait — il manque tel montant — et laisse la suite à des humains. Sur des chauffeurs salariés, c'est la seule position tenable.
- L'écart reste visible tant qu'il n'est pas réglé, parce qu'il pèse là où le chauffeur le sent : sur sa capacité à travailler. Un écart sorti du compte courant serait un écart que plus personne ne regarde.
- Refuser la remise tant que le compte n'y est pas aurait un effet pervers : un chauffeur bloqué au plafond avec 500 FCFA manquants ne peut plus travailler du tout, donc plus rembourser.

Le plafond bloquant est ce qui empêche cette dette de croître indéfiniment : elle se heurte au plafond, et le chauffeur doit régulariser pour reprendre.

**La comptabilité dit la même chose que le compte courant, jamais autre chose (D34, 20 août).** C'est une évidence tant qu'on ne l'écrit pas, et une source de dérive dès qu'on l'oublie. La créance sur le chauffeur n'est soldée qu'à hauteur de ce qui a été **réellement reçu** ; le reliquat reste dû au bilan, du même montant que celui resté au compte courant. Les deux systèmes se vérifient alors l'un l'autre au lieu de se contredire.

Le compte d'écart n'intervient qu'au moment où une **décision humaine éteint la dette** — retenue, ajustement — parce que c'est le seul moment où la créance cesse réellement d'exister. Reclasser l'écart hors de la créance dès la remise revenait à écrire dans les livres que le chauffeur ne doit plus rien, et produisait, à la remise suivante, une créance en solde créditeur : l'entreprise devant de l'argent à un chauffeur qui lui en doit.

**Comptes et journaux sont provisoires jusqu'à validation par un comptable.** Le plan de la base de développement n'est pas le SYSCOHADA en usage au Cameroun ; les comptes livrés sont des valeurs par défaut plausibles, paramétrables, à repointer avant le pilote. Voir `05-prerequis-et-simulation.md` §5.
5. Tout écart entre montant attendu et montant remis est enregistré, jamais absorbé silencieusement.

Le plafond remplace la clôture de service comme mécanisme de contrôle. Il ne coûte qu'une règle métier et un champ de configuration.

---

## 8. Écarts assumés avec le cahier des charges

Ces écarts sont des décisions, pas des oublis. Ils doivent être validés par le maître d'ouvrage.

**É1 — Authentification (CDC §VII.1, §X.3.a)**
Le CDC impose inscription et connexion par numéro de téléphone avec OTP SMS. D4 retient Google Sign-In seul. Conséquence : numéro non vérifié, et exclusion des utilisateurs sans compte Google actif — population non négligeable sur la cible chauffeurs. À réévaluer si le taux d'échec d'inscription observé en pilote est élevé.

**É2 — Documents chauffeur (CDC §IV.1)**
Le CDC prévoit le téléversement de la carte grise par le chauffeur. Avec D6, la carte grise est un actif géré par l'admin. L'onboarding chauffeur se limite au permis et à la pièce d'identité, et une gestion de flotte apparaît en contrepartie.

**É3 — Statut chauffeur (CDC §VIII.1, §X.3.b)**
Le CDC évoque une commission par course et un abonnement chauffeur par Mobile Money — deux modèles économiques différents et mutuellement incompatibles dans le modèle de données. D5 tranche pour le salariat en phase 1. Wallet, moteur de payout, commissions et abonnements sortent du périmètre. Le modèle de domaine doit néanmoins ne pas rendre leur ajout ultérieur coûteux.

**É4 — Paiement (CDC §II.4, §VI.4)**
Mobile Money et carte bancaire sont reportés en phase 2 (D9). Le MVP est espèces uniquement.

**É5 — Choix technique du CDC (§VI.2, §VI.5)**
Le CDC recommande un backend sur mesure, PostgreSQL, et une infrastructure AWS ou Azure. L'architecture retenue est compatible sur le fond (PostgreSQL, cloud, scalabilité) mais introduit Odoo, non mentionné au CDC. Le gain est le back-office §V et la comptabilité quasi gratuits ; le coût est une contrainte de performance sur le chemin temps réel, traitée par D3.

**É6 — Tableau de bord des revenus chauffeur (CDC §II.5, §IV.4)**
Le CDC prévoit un suivi des « revenus journaliers, hebdomadaires et mensuels » et un export pour usage fiscal. Avec D5, un salarié n'a pas de revenu variable par course : ce qu'il voit n'est pas son revenu mais **la recette qu'il a encaissée pour le compte de l'entreprise**. Le libellé et la finalité de l'écran changent complètement — il devient un outil de suivi d'activité et de réconciliation de caisse, non un relevé de gains. L'export fiscal §IV.4 perd son objet.

**É7 — Priorité par proximité (CDC §IV.2)**
Le CDC prévoit « un système de priorité pour les chauffeurs les plus proches ». Avec D10, c'est le client qui choisit : cette exigence devient sans objet en v1. Elle redeviendra pertinente si l'attribution automatique est réintroduite, ce que les indicateurs de §3 diront.

**É8 — Itinéraire moto (CDC §I.3, §II.1, §III.2)**
Ni Google ni Mapbox ne calculent d'itinéraire deux-roues au Cameroun : Google n'y active pas son mode deux-roues, Mapbox n'en propose dans aucun pays. Les itinéraires, distances et durées seront donc calculés sur un modèle **voiture**, alors que la proposition de valeur du CDC §I.3 est précisément que la moto ne subit pas ce que subit la voiture. Conséquences retenues : le tarif s'appuie sur la distance et sur la durée **réellement mesurée**, jamais sur la durée estimée par le routeur ; l'ETA affiché nécessite un facteur de correction calibré en pilote. Détail dans `02-comparatif-cartographie.md`.

**É9 — Formule tarifaire (CDC §II.3)**
Le CDC impose un tarif « basé sur la distance parcourue **et** le temps de trajet ». D15 retire le terme temps. Justification : la durée connaissable avant la course est une durée voiture (É8), donc un devis incluant un prix à la minute surfacture structurellement aux heures de pointe — précisément quand l'avantage de la moto devrait se voir. Avec des chauffeurs salariés (D5), le terme temps ne protège plus le chauffeur du temps immobilisé, il ne protège que la marge de l'entreprise ; le coefficient d'heure de pointe du CDC §V.3 remplit ce rôle et il est, lui, exactement calculable d'avance. Bénéfice second : le devis devient exact au franc près et vérifiable de tête par le client, ce qui compte sur un marché où la négociation à l'arrivée est la norme.

---

## 9. Sécurité et exploitation

Exigences du CDC §VII.2 et §VII.3, à traiter comme des tâches et non comme des intentions.

- **Transport** : TLS obligatoire sur toutes les liaisons, WebSocket inclus. Aucun endpoint en clair, y compris en environnement de test.
- **Au repos** : chiffrement du volume PostgreSQL et du stockage de documents. Les pièces d'identité et permis de conduire (§IV.1) ne sont jamais servis en URL publique — accès signé et à durée limitée uniquement.
- **Secrets** : clés Google, identifiants FCM, jetons marchands hors du dépôt de code, injectés à l'exécution.
- **Sauvegardes** : sauvegarde automatique quotidienne de PostgreSQL et du stockage, avec **restauration testée** — une sauvegarde jamais restaurée n'est pas une sauvegarde. Redis n'est pas sauvegardé, par construction (règle de partition, §2).
- **Rôles** : le mobile n'accède jamais à un modèle Odoo hors de ce que les règles d'enregistrement autorisent pour son utilisateur. Un chauffeur ne lit pas la course d'un autre chauffeur ; un client ne lit pas les documents d'un chauffeur. À vérifier par des tests, pas par relecture.
- **Journalisation** : toute transition de course et toute opération sur le compte courant chauffeur sont journalisées de manière non modifiable. C'est ce qui permettra de trancher un litige.

---

## 10. Risques ouverts

| Risque | Impact | Traitement proposé |
|---|---|---|
| Consommation batterie et données de l'émission GPS continue (CDC §VI.3) | Chauffeurs qui désinstallent l'app | Fréquence adaptative selon la vitesse, agrégation avant envoi, mesure obligatoire en pilote |
| Coût du quota Google Maps à l'échelle | Coût variable non maîtrisé, croissant avec le volume de courses | Cache des itinéraires par paire de zones, plafonds de quota dans la console, abstraction C3 pour garder Mapbox atteignable |
| Tarif « Navigation Request » de Google non public | Inconnue d'un facteur vingt sur le coût de la v2 | Obtenir un devis avant tout engagement sur la navigation in-app |
| Itinéraires calculés sur un modèle voiture (É8) | ETA pessimiste, tarif temps surévalué, crédibilité entamée | Tarif sur distance et durée mesurée ; facteur de correction d'ETA calibré en pilote |
| Sélection concurrente du même chauffeur (§3) | Deux clients avec le même chauffeur | Réservation atomique et test de charge dédié |
| Observabilité de la flotte par les clients (§3) | Cartographie de la flotte par un tiers | Rayon et nombre de résultats plafonnés, position arrondie, limitation de débit |
| Utilisation inégale de la flotte (§3) | Salariés payés sans être choisis | Indicateur de courses par chauffeur dès le pilote ; réouverture de D10 si nécessaire |
| Abandon du client après refus en chaîne (D11) | Course perdue, client perdu | Instrumenter le taux d'abandon après refus ; réouverture de D11 si nécessaire |
| Qualité GPS en zone dense (Douala) | Tarif contesté par le client | Distance de référence calculée par l'API de routage, pas par sommation des points GPS |
| Absence de `hr_payroll` en Odoo Community | Paie non calculable dans Odoo | Module OCA, ou paie traitée hors application — à trancher, hors périmètre MVP |
| Réseau mobile intermittent | Course perdue, tarif faux | Mode dégradé côté app avec file d'attente locale et rejeu ; à concevoir dès le départ, pas après |
| Google Sign-In requiert les Google Play Services | Exclusion de terminaux d'entrée de gamme et reconditionnés | Mesurer le taux d'échec en pilote ; É1 à rouvrir si significatif |

---

## 11. Ce que ce document ne tranche pas encore

À arbitrer avant ou pendant le découpage en tâches. Les trois blocages de la version 1.0 — choix du chauffeur, navigation, algorithme de matching — sont levés par D10 à D13.

**Paramètres provisoires, à confirmer avant le développement**

Le nombre de chauffeurs proposés est fixé (D14). Trois paramètres de dispatch restent ouverts ; en l'absence d'arbitrage, les valeurs ci-dessous seront retenues par défaut. Aucune n'est structurante : toutes doivent être configurables dans le back-office, pas codées en dur.

| Paramètre | Valeur par défaut | Remarque |
|---|---|---|
| Délai d'acceptation par le chauffeur | 30 secondes | Assez pour qu'un chauffeur arrêté lise la course, assez court pour que le client ne décroche pas |
| Rayon de recherche initial | À calibrer en pilote | Dépend de la densité de la flotte à Bonanjo |
| Aucun chauffeur disponible | Élargir le rayon et proposer 5 autres chauffeurs | Garde le client dans le parcours sans réintroduire d'attribution automatique |

**Non bloquants**

- Valeurs de la grille tarifaire : base, prix au km, coefficients de zone et d'heure de pointe
- Règle d'arrondi du tarif en FCFA
- Stratégie de test : niveau de couverture attendu, et quels scénarios de bout en bout sont non négociables
- Environnements et chaîne de déploiement
- Politique de conservation des données de localisation (CDC §VII.4, conformité RGPD ou équivalent local)
- Traitement de la paie : module OCA ou hors application (cf. §10)
- Facturation de la distance calculée ou de la distance parcourue, l'écart étant plus élevé que dans une app voiture (É8)

---

## 12. Couverture du cahier des charges

| Section CDC | Traitement |
|---|---|
| II.1 Géolocalisation temps réel | D3, §2 |
| II.2 Commande de course | D10, D14, §3 |
| II.3 Facturation automatique | D15, `babana.fare.rule`, `account.move` ; É9 sur le retrait du terme temps |
| II.4 Paiement intégré | É4, reporté phase 2 |
| II.5 Profil chauffeur | `babana.driver` ; É6 sur les revenus |
| II.6 Sécurité, partage de trajet, bouton d'urgence | §4, `babana.incident` |
| III.1 à III.3 Interface et historique | D1, `account.move` |
| III.4 Notifications push | §4, Firebase Cloud Messaging |
| IV.1 Inscription et documents chauffeur | É2, §9 |
| IV.2 Réception des demandes | D10, §3 ; É7 sur la priorité par proximité |
| IV.3 GPS intégré | D12, §4 |
| IV.4 Suivi des revenus | É6 |
| V.1 à V.3 Administration | Back-office Odoo natif, §4 |
| VI.1 Développement mobile | D1 |
| VI.2 Base de données | D2, PostgreSQL |
| VI.3 API de géolocalisation | §4, risques §10 ; voir `02-comparatif-cartographie.md` |
| VI.4 Paiements locaux | É4 |
| VI.5 Hébergement cloud | D2 |
| VII.1 Authentification OTP | É1, écart assumé |
| VII.2 Chiffrement | §9 |
| VII.3 Sauvegardes | §9 |
| VII.4 Conformité réglementaire | §9, §11 pour la conservation des données |
| VIII Planning | Hors périmètre de ce document |
| IX Budget | Hors périmètre de ce document |
| X Diagrammes et scénario | Machine à états §6, cohérente avec le scénario §X.2 |
