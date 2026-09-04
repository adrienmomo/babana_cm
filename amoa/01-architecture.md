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
| D12 | Navigation par **lien profond vers Google Maps** en v1, navigation assistée in-app prévue en v2 | Turn-by-turn embarqué dès la v1 | Coût et consommation batterie disproportionnés au MVP. Impose l'abstraction C3. **Réexaminée et maintenue le 3 septembre** — voir §4 bis |
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
| D37 | **Le jeton rejouable est conservé chiffré, avec une clé dérivée du jeton présenté** — et effacé à la fin de la fenêtre, par une tâche périodique, pas seulement à la prochaine présentation | Le conserver en clair | Sans cela, chaque renouvellement laissait en base, définitivement, le jeton valide de l'utilisateur en clair. Voir §5 |
| D38 | **Un artefact qui se construit n'est pas un artefact qui fonctionne.** Tout livrable destiné à être ouvert par quelqu'un a pour critère qu'il ait été ouvert | Compilation réussie comme preuve | Le bundle web compilait depuis quatre nuits et affichait une page blanche. Voir §9 |
| D39 | **L'export web ne persiste aucune session** : rien dans le stockage du navigateur, reconnexion à la réouverture | Trousseau simulé par `localStorage` | Un navigateur n'a pas de trousseau système ; un jeton de renouvellement dans `localStorage` est lisible par toute faille d'injection. Voir §9 |
| D40 | **Toute date qui traverse le contrat porte son fuseau**, écrite en UTC suffixé par un sérialiseur unique côté Odoo | Assouplir le schéma pour accepter une date nue | Une date sans fuseau n'est pas ambiguë, elle est fausse d'une heure à Douala : un navigateur l'interprète comme heure locale. Voir §5 bis |
| D41 | **L'immatriculation est révélée à l'affectation**, jamais avant | Ne jamais l'exposer ; l'exposer dès la liste des cinq | Avant le choix, la flotte doit rester non balayable (C2b) ; après, le client doit reconnaître la moto qui arrive. C'est le choix qui fait basculer la règle |
| D42 | **Les numéros de téléphone sont révélés à l'affectation et effacés à la fin de la course**, des deux côtés | Relais de masquage ; ne rien exposer | À Douala on se repère en s'appelant, et un client qui ne trouve pas sa moto annule. Le relais est la bonne réponse à terme, et c'est une intégration téléphonique entière |
| D43 | **Aucune configuration de fournisseur externe n'a de valeur par défaut qui pointe vers le vrai fournisseur.** Non configuré, on échoue bruyamment | Une valeur par défaut « raisonnable » | Une configuration qui retombe sur le vrai service masque sa propre panne : le simulateur paraît branché et ne l'est pas. Voir §9 ter |
| D44 | **Un état réparé est indiscernable d'un état produit normalement.** Une réconciliation restaure l'état complet, jamais un fragment | Réparer le marqueur qui manque | Un état partiel qu'aucune transition ne pourrait produire est un quatrième cas que personne n'a prévu. Voir §2 ter |
| D45 | **Tout compte reçoit son fuseau à la création** (`Africa/Douala`, paramétrable), et toute requête bornée par un jour calendaire convertit ses bornes en UTC | Laisser courir le fuseau par défaut d'Odoo | Sans lui, tout chauffeur camerounais est à Bruxelles, et sa recette du jour tombe à zéro plusieurs heures par jour. Voir §5 bis |
| D46 | **Le banc de vérification reproduit la topologie de production** : même origine pour le bundle web et l'API, donc aucun CORS | Ajouter des en-têtes CORS à l'API authentifiée | On n'ajoute pas une surface d'attaque à une API qui porte des jetons pour accommoder une erreur de banc d'essai. Voir §9 ter |
| D47 | **Un flux périodique surveille son propre silence**, abonnement par abonnement — pas seulement la connexion qui le porte | Battement de cœur sur la connexion | Une connexion vivante dont un flux est mort reste « connectée ». Un battement de cœur arriverait quand même, et masquerait le défaut. Voir §3 bis |
| D48 | **En cas d'urgence, le superviseur est prévenu en premier** — c'est le canal qui produit une action. Le proche vient ensuite | Notifier le contact d'urgence en premier | Un superviseur peut appeler, voir la position, alerter. Un proche ne peut que s'inquiéter. Voir §9 |
| D49 | **Toute action émise sur le fil reçoit une réponse, positive ou négative.** Un succès ne s'infère jamais d'un silence | Ne répondre qu'en cas d'échec | Une app qui n'apprend que les échecs doit deviner les succès — et deviner veut dire attendre un délai inventé. Voir §3 ter |
| D50 | **Un flux annonce sa propre cadence** dans son accusé d'abonnement ; l'application ne recopie jamais une valeur du serveur | Constante locale alignée à la main | Deux copies d'une même valeur, sans mécanisme pour les tenir d'accord, finissent par diverger en silence — D23, une fois de plus. Voir §3 ter |
| D51 | **Une proposition porte la distance à parcourir à vide** jusqu'au client, pas seulement celle de la course | La distance de la course seule | C'est le chiffre le plus déterminant pour un chauffeur qui décide en trente secondes, et le serveur le connaît déjà |
| D52 | **Les contraintes déclarées sont comparées à celles réellement présentes en base**, après installation | Faire confiance à la déclaration | Odoo journalise l'échec de création d'une contrainte et poursuit. Deux ont ainsi protégé le vide pendant des semaines. Voir §9 quater |
| D53 | **La base n'installe jamais les données de démonstration d'Odoo, et la devise franc CFA est exigée à l'installation** | Laisser la devise par défaut ; corriger à la main | Les données de démonstration créent des écritures avant qu'on fixe la devise, et Odoo refuse ensuite de la changer : le compte courant et le grand livre étaient libellés en dollars. Voir §7 |
| D54 | **Les lectures des contrôleurs se font au nom de l'utilisateur**, jamais en `sudo` ; seules les écritures, qui passent par les transitions, l'utilisent | Lire en `sudo` et vérifier dans le contrôleur | Deux gardes pour la même règle, dont une seule s'exécutait. Voir §9 quinquies |
| D56 | **La non-habilitation d'un dossier chauffeur est un état temps réel**, posé au commit de la transition Odoo : elle retire du vivier et refuse une acceptation en vol. Sa levée ne réintègre pas | Compter sur `is_online` côté Odoo | Le vivier ne dépend pas d'`is_online` : un chauffeur suspendu y restait sélectionnable. Voir §7 bis |
| D55 | **Une suspension empêche de travailler, pas de voir.** Le chauffeur suspendu garde la lecture de son compte courant, de ses remises et de sa course en cours | Coupure totale et immédiate | Retirer à quelqu'un tout moyen de voir sa dette l'empêche de la régler — et couper au milieu d'une course laisse un passager sans chauffeur. Voir §7 |
| D57 | **La facture part automatiquement à l'encaissement**, et l'échec d'un envoi se voit là où un superviseur regarde déjà | Envoi à la demande du client | Une facture sert le jour d'une contestation ; personne ne réclame ce qu'il ignore. Et un envoi automatique qui échoue en silence est pire qu'un envoi manuel : plus personne ne constate l'absence. Voir §7 ter |
| D58 | **Une écriture PostgreSQL ordinaire se pose dans le savepoint, avec les effets qu'elle accompagne ; seul un appel sortant vers le service temps réel se pose au commit** | Étendre D32/D33 à tout effet secondaire | D32/D33 protègent d'une donnée Redis qu'un `ROLLBACK` ne peut pas défaire. Une facture, elle, doit échouer *avec* l'encaissement — sinon « course encaissée sans facture » revient par la porte du correctif. Voir §2 quater |
| D59 | **Une variable de configuration n'existe que si un test relie sa déclaration, sa livraison et sa consommation** | La documenter et la garder | Trois fois, une variable documentée, gardée par un contrôle, et jamais délivrée au code qui la lit. Le garde-fou lisait la valeur puis ne la transmettait pas. Voir §9 sexies |
| D60 | **Un gestionnaire qui doit garder la trace d'un échec ne commite pas la transaction de la requête : il renvoie une notification au lieu de lever** | `env.cr.commit()` avant de lever | Un commit sur le curseur de la requête exécute au passage tous les points d'accroche au commit en attente — D32 à l'envers, sur une requête qui se termine en erreur. Voir §2 quinquies |
| D61 | **Aucune adresse de production en repli dans le code.** Une adresse absente échoue ; elle ne se devine pas | `\|\| 'https://api.babana.cm'` | Un binaire de recette construit sans cette variable écrirait dans la base du pilote sans que rien ne le signale. Même famille que D43 : un repli plausible est plus dangereux qu'une absence |
| D62 | **Un script d'exploitation n'est vérifié que s'il a été exécuté comme script**, d'un bout à l'autre | Rejouer ses commandes une à une | Rejouer les commandes prouve la mécanique, jamais le script — l'ordre, les gardes, les variables, les codes de retour restent non exercés. Et c'est le script qu'on lance à trois heures du matin. Voir §9 septies |
| D63 | **Le jeu de démonstration porte ce que l'écran affiche**, pas seulement les enregistrements qui le référencent | Semer les lignes, pas les fichiers | Cent chauffeurs semés, deux cents documents, zéro image téléversée : l'écran de validation d'un permis n'a jamais été vu. Un enregistrement qui pointe vers rien peuple une liste, pas un écran. Voir §9 septies |
| D64 | **L'adresse qui sert à écrire n'est pas celle qui sert à signer une URL destinée à un navigateur.** Le stockage a un point d'entrée interne et un point d'entrée public, distincts | Un seul `S3_ENDPOINT` | L'URL signée renvoyée au navigateur portait `http://minio:9000`, injoignable hors du réseau Docker — en production comme en développement. La route publique n'expose que l'API S3, jamais la console. Voir §9 octies |
| D65 | **Une variable est livrée à ce qui la consomme, et le contrôle le vérifie par service** | « livrée quelque part » | `BABANA_DOMAIN` était livrée à Caddy, jamais au conteneur qui exécute `share.py` : tous les liens de partage portaient `babana.cm` en dur, dans tous les environnements. Le contrôle des trois moments a laissé passer exactement le défaut qu'il existe pour attraper. Voir §9 nonies |
| D66 | **Le pilote démarre sans vérification du numéro par SMS.** Le numéro du chauffeur est vérifié à l'embauche ; celui du client reste déclaré | Attendre la passerelle SMS | Sur des chauffeurs salariés recrutés en personne, l'OTP ne vérifie rien que l'employeur ne sache déjà. Attendre aurait décalé le pilote d'autant, sans contrepartie. Voir É1 |
| D67 | **Le journal d'audit immuable (L8-09) entre au périmètre pilote** | Le différer avec le reste du lot L8 | Une donnée non journalisée pendant le pilote est perdue définitivement : on ne reconstitue pas un historique après coup. Sur un service en espèces, c'est la seule chose qu'on ne puisse pas rattraper. Voir §7 quater |
| D68 | **L'échec d'un mécanisme se signale ailleurs que dans ce qu'il remplace** | `_logger.exception` pour un journal d'audit | Deux gardes justes — le journal ne lève jamais, l'écriture est interdite — composent un silence : si la traçabilité s'arrête, la seule trace est dans le journal applicatif que L8-09 existe précisément à remplacer. Voir §9 decies |
| D69 | **Une assertion ne somme jamais toute la base : elle est bornée à son propre scénario** | `search([("account_id", "=", …)])` puis somme | Deux tests comptables du lot L5 mesuraient l'histoire de la base plutôt que leur scénario. Vrais sur une base vide, faux dès qu'elle contient des données — c'est-à-dire faux en pilote. Voir §9 undecies |
| D70 | **Un incident intermittent se catalogue par son symptôme, pas par la nuit où il est apparu** | Une explication d'environnement par occurrence | Trois nuits ont écarté séparément le même symptôme — un chauffeur jamais apparu dans le vivier, suivi d'un silence — chacune avec une cause plausible, la dernière écartant les deux précédentes. Voir §9 duodecies |
| D71 | **Tout appel sortant porte un délai.** Un rattrapage placé derrière un appel qui peut se taire ne s'exécute jamais | Compter sur l'échec ou la réponse | `callOdoo` était le seul appel sortant sans délai du système — et il porte une boucle de réessai, elle-même devant la file de rejeu. Un appel qui ne se termine pas n'atteint ni l'un ni l'autre. Voir §9 terdecies |

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

## 2 quater. Ce que D32 et D33 ne disent pas (D58)

J'ai écrit dans le prompt de la nuit J36 que la facture devait rejoindre « le même point d'accroche que le reste : au commit, jamais depuis un savepoint ». C'était faux, la nuit l'a vérifié avant d'obéir, et le raisonnement mérite d'être fixé ici parce qu'un futur lot financier lira la même phrase.

**D32 et D33 gouvernent une seule chose : un appel sortant vers le service temps réel.** Leur motif tient dans l'en-tête de `realtime_client.py` — un aller-retour HTTP qui modifie Redis produit un effet qu'un `ROLLBACK` PostgreSQL ne peut pas défaire. D'où l'attente jusqu'au commit : on n'annonce à l'extérieur que ce dont on sait qu'il a eu lieu.

**Une facture n'a rien de cette catégorie.** C'est un `account.move`, une écriture PostgreSQL ordinaire, dans la même transaction, annulée par le même `ROLLBACK` que le reste. La sortir du savepoint ne la protégerait de rien — elle la rendrait au contraire possible *après* un encaissement déjà commité, c'est-à-dire recréerait « une course encaissée sans facture », le défaut exact que la tâche fermait.

La règle générale, donc : **l'atomicité se juge sur la nature de l'effet, pas sur son rang dans la séquence.** Ce qui peut être annulé par la transaction reste dedans et échoue avec elle ; ce qui ne le peut pas attend le commit. La remise de caisse posait déjà sa pièce comptable dans le savepoint, et `test_settlement.py` nommait la facture comme le futur occupant de ce même bloc. Deux sources du dépôt disaient juste, et mon prompt disait le contraire.

C'est la deuxième fois qu'une affirmation fausse de ma part voyage dans un prompt de nuit (la première le 27 août). Une erreur dans un débrief se discute ; une erreur dans un prompt s'exécute. La consigne de `CLAUDE.md` — vérifier dans le dépôt plutôt que dans le prompt — vaut d'abord pour moi.

---

## 2 quinquies. Enregistrer un échec sans commiter la requête (D60)

Le bouton d'envoi manuel de la facture écrivait le motif de l'échec, puis levait une erreur pour l'afficher — et Odoo, qui annule la transaction entière dès qu'une exception s'échappe d'un appel RPC, emportait l'écriture avec elle. L'écran affichait bien le message d'erreur, et gardait l'état d'avant le clic. Trouvé en ouvrant l'écran, jamais par un test : les tests appellent la méthode interne, jamais le bouton.

Le correctif retenu la nuit J37 — `env.cr.commit()` juste avant de lever — fonctionne, et c'est le seul `commit()` sur le curseur d'une requête dans tout ce dépôt. Il ne doit pas rester, pour une raison qui n'a rien à voir avec ce bouton : **`Cursor.commit()` exécute au passage les points d'accroche au commit en attente.** Un gestionnaire qui commite puis lève déclenche donc les effets externes d'une requête qui se termine en erreur — exactement le risque que D32 existe pour écarter, pris par l'autre bout. Aujourd'hui rien n'est enregistré avant ce bouton ; la garantie tient au fait que personne n'a encore ajouté de ligne au-dessus.

**La forme juste est de ne pas lever.** Une action qui renvoie une notification (`ir.actions.client`) affiche le même message à l'écran et laisse la transaction se terminer normalement, avec l'écriture dedans. L'erreur n'a jamais eu besoin d'être une exception : elle avait besoin d'être visible.

La règle générale : **dans un gestionnaire, lever est une façon d'annuler, pas une façon d'afficher.** Si un échec doit laisser une trace, il ne peut pas être signalé par une exception.

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

## 3 bis. Une connexion vivante ne prouve rien (D47)

La liste des chauffeurs se vidait après quelques secondes : le premier envoi arrivait, la diffusion périodique suivante n'atteignait jamais la connexion de longue durée de l'application. Aucune fermeture, aucune erreur, aucun rejet — l'état de connexion restait « connecté », et l'écran affichait « aucun chauffeur disponible » avec l'aplomb d'un fait.

**Une connexion ouverte n'est pas une connexion qui livre.** Deux pannes distinctes produisent le même silence, et il faut les traiter séparément :

- **La connexion meurt sans le dire.** Sur un réseau mobile — c'est le cas courant ici, pas l'exception — une connexion à moitié fermée reste ouverte des minutes du côté qui n'émet pas. Rien n'arrive, `onclose` ne se déclenche jamais.
- **Un flux meurt sur une connexion qui vit.** Une boucle de diffusion qui cesse de se réarmer, un abonnement perdu côté serveur : la connexion transporte encore tout le reste.

**Un battement de cœur sur la connexion ne couvre que la première.** Dans le second cas il arriverait normalement, et confirmerait que tout va bien pendant qu'un flux est mort — il masquerait le défaut au lieu de le révéler.

La surveillance se fait donc **par abonnement** : un flux périodique connaît sa propre cadence, donc il sait ce que son silence signifie. Passé un multiple de cette cadence sans rien recevoir, l'application le dit et se réabonne — elle n'attend pas qu'une couche plus basse s'en aperçoive.

**Et le diagnostic passe avant le mécanisme.** Ajouter la surveillance sans avoir compris pourquoi la diffusion s'est arrêtée reviendrait à installer une alarme pour ne pas avoir à réparer la serrure.

---

## 3 ter. Ce qu'on devine faute d'un message qui le porte (D49, D50)

Deux défauts trouvés le même soir avaient la même forme, et elle mérite d'être nommée.

L'écran de proposition attendait **1500 millisecondes devinées** avant de conclure qu'une acceptation avait réussi. Non par négligence : le contrat ne porte aucun accusé de réception positif pour `proposal.accept`. Il porte les échecs — `proposal.expired` — et rien d'autre. Une application qui n'apprend que les échecs doit donc inférer le succès du silence, c'est-à-dire attendre assez longtemps pour être raisonnablement sûre. Sur un réseau de Douala, « assez longtemps » n'existe pas.

Le détecteur de silence, lui, comparait le temps écoulé à une **copie locale** de la cadence du serveur. Deux exemplaires d'une même valeur, dans deux dépôts de code, sans rien pour les tenir d'accord : changer la cadence en base désynchronise le seuil sans qu'aucune alarme ne se déclenche. C'est D23 dans un autre costume.

**Deux règles, une seule idée.** Toute action émise sur le fil reçoit une réponse, positive ou négative — un succès ne s'infère jamais d'un silence. Et un flux annonce sa propre cadence dans son accusé d'abonnement — l'application ne recopie jamais une valeur que le serveur peut lui dire.

Ce qu'elles ont en commun : **là où une application devine, il manque un message.** Un délai deviné est toujours le symptôme d'une information qu'on n'a pas envoyée, et il finit par être trop court ou trop long — jamais juste, puisque rien ne le calibre.

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

## 4 bis. D12 réexaminée, et maintenue (3 septembre)

La capture GPS a été livrée sans service de premier plan Android : Android peut donc suspendre les minuteurs de l'application dès qu'elle passe en arrière-plan. Or D12 — la navigation par lien profond — l'y envoie **pendant toute la course**. L'arrière-plan n'est pas un cas limite du produit, c'est le chemin normal de chaque course, et si la capture s'y arrête, le suivi que le client regarde s'arrête avec elle.

La navigation embarquée a donc été rouverte comme réponse possible. Puis écartée, et le raisonnement mérite d'être gardé, parce que la question reviendra.

**Elle ne résout que la moitié du problème.** Elle garde l'application au premier plan pendant la course. Mais un chauffeur passe l'essentiel de son temps **en ligne à attendre**, téléphone en poche, écran éteint — et c'est cet état-là qui alimente le géo-index, donc la capacité même du produit à proposer un chauffeur. La navigation embarquée n'y change rien.

**Et elle coûte de la batterie là où nous n'en avons pas à perdre.** Un guidage pas à pas, écran allumé, consomme sans commune mesure avec un minuteur d'arrière-plan. C'était la raison de D12 au premier jour, et elle n'a pas faibli : un chauffeur dont la batterie tient trois heures désinstalle.

**Le prix, lui, n'est plus un argument** — le SDK de navigation est facturé par destination, avec mille destinations gratuites par mois depuis la baisse tarifaire de 2026. Un pilote n'en paierait rien. C'est le seul des trois arguments d'origine qui est tombé.

**Ce qui manque n'est pas une décision, c'est une mesure.** Personne ne sait aujourd'hui si la capture tient en arrière-plan sur un terminal réel, et la question se tranche en une demi-journée — voir le protocole dans `06-jalons-et-pilote.md`. Trois issues : elle tient, et il n'y a rien à faire ; elle tient mal, et une bibliothèque de service de premier plan couvre les deux états ; elle ne tient pas du tout, et alors seulement la navigation embarquée redevient une question — en ne réglant toujours que la course.

Décider avant de mesurer aurait été ajouter un lot entier pour un problème dont nous ignorons l'ampleur.

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

**Et ce que D36 coûtait sans le dire (D37, 23 août).** Rejouer un jeton à l'identique suppose de l'avoir gardé sous une forme récupérable — ce qu'un haché ne permet pas. J'ai écrit D36 sans voir que j'exigeais quelque chose que « seul le haché est stocké » interdit. L'implémentation a tranché la contradiction dans le seul sens que ma rédaction laissait ouvert : garder le remplaçant en clair. Et comme il n'est effacé qu'à une représentation tardive de l'ancien jeton — qui n'arrive jamais quand tout se passe bien — **chaque renouvellement laissait en base, définitivement, le jeton de renouvellement valide de l'utilisateur, en clair.** Le hachage ne protégeait plus rien du tout.

La sortie tient en une observation : le client qui a le droit de rejouer est exactement celui qui possède l'ancien jeton. Le remplaçant est donc chiffré avec une clé dérivée de cet ancien jeton, dont la base ne garde que le haché — un vidage de base ne donne rien de déchiffrable, et un client qui présente l'ancien jeton fournit du même geste la clé de son remplaçant. Une tâche périodique efface le chiffré à la fin de la fenêtre, sans attendre que quelqu'un vienne le redemander.

**La leçon dépasse le cas.** Une décision qui ajoute une commodité — ici, ne pas déconnecter un chauffeur sur une coupure réseau — peut retirer une garantie posée ailleurs sans que ni l'une ni l'autre ne paraisse fausse isolément. C'est la même forme que D26 et D33 : deux règles correctes qui ne composent pas. La différence, cette fois, est que la règle perdue était une propriété de sécurité, et qu'aucun test ne la vérifiait — d'où le critère 3 ter de L1-02, qui la rend mécanique.

**Vérification du numéro de téléphone.** Google Sign-In ne fournit pas de numéro vérifié. Le numéro reste indispensable : le chauffeur doit pouvoir appeler le client, et le Mobile Money de la phase 2 en dépendra. Un numéro saisi au clavier et jamais vérifié est un risque à assumer explicitement. Mitigation recommandée, à coût quasi nul : **un seul OTP dans la vie du compte**, au moment du rattachement du numéro — pas à chaque connexion.

---

## 5 bis. Le temps qui traverse le contrat (D40)

Une date sans fuseau paraît un détail de formatage. Elle ne l'est pas : un navigateur qui lit `2026-08-22T06:38:44` l'interprète comme une **heure locale**. À Douala, où l'heure locale est en avance d'une heure sur UTC, un instant stocké en UTC et écrit sans suffixe est donc lu **décalé d'une heure**, silencieusement, partout où il s'affiche. Une estimation valable cinq minutes apparaît expirée, ou valable une heure de trop. Un compte à rebours part faux. Un horodatage de course en dispute désigne le mauvais moment.

Le contrat exigeait un format univoque ; Odoo n'en produisait pas, et **c'est Odoo qui avait tort**. Assouplir le schéma aurait fait disparaître le message d'erreur en gardant l'erreur d'une heure — la pire des deux issues, puisqu'elle est muette.

Toute date qui traverse le contrat est donc écrite en UTC, suffixée, par **un sérialiseur unique** : une conversion recopiée dans chaque contrôleur diverge, et cette divergence-là ne se voit pas à la lecture.

**Le fuseau des comptes est le même problème d'un cran plus bas (D45, 29 août).** Rien ne pose de fuseau à la création d'un compte : tout utilisateur hérite du défaut d'Odoo, `Europe/Brussels`. Autrement dit, pour la base de données, **chaque chauffeur de Douala habite Bruxelles**.

Pris seul, cela paraît cosmétique. Combiné à une requête qui construit ses bornes sur le jour calendaire local et les compare à des dates stockées en UTC, cela donne un défaut quotidien : entre 22 h et minuit UTC, la recette du jour d'un chauffeur **retombe à zéro** — une course encaissée à l'instant disparaît de son propre écran. Il a été trouvé parce qu'une passe de tests est tombée dans cette fenêtre ; il aurait été trouvé en production par un chauffeur qui n'aurait pas compris ce qu'il voyait.

Deux règles, donc, et il faut les deux : **le fuseau se pose à la création** (`Africa/Douala`, paramétrable — le jour où le service dépasse le Cameroun, cette valeur doit pouvoir changer sans toucher au code), et **toute borne dérivée d'un jour calendaire se convertit en UTC avant de servir à une requête**. Une seule des deux ne suffit pas : un fuseau juste avec des bornes naïves reste faux d'une heure à Douala, simplement moins souvent.

**Et ce défaut a tenu six semaines parce qu'aucune suite ne pouvait le voir.** Les tests d'écran simulent le client HTTP ; les tests du client construisent eux-mêmes des réponses déjà bien formées ; les scénarios de bout en bout parlent en `fetch` brut, sans validation de schéma. Aucune suite n'exerçait, en même temps, le vrai Odoo, le vrai client et sa vraie validation. C'est exactement la famille de trou qui avait justifié le critère 5 de C-01 pour le jeton — étendu maintenant aux réponses REST.

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

**Et une suspension ne coupe pas cette vue (D55, 8 septembre).** Les règles d'habilitation exigeaient que le chauffeur soit approuvé pour lire quoi que ce soit — donc un chauffeur suspendu ne voyait plus son compte courant ni ses remises. Il devait de l'argent et n'avait plus aucun moyen de savoir combien, ni de suivre sa régularisation.

C'est le même raisonnement que celui qui a fait accepter les remises partielles : retirer à quelqu'un tout moyen de voir sa dette l'empêche de la régler. Une suspension retire le droit de travailler ; elle ne retire pas le droit de savoir ce qu'on doit.

**Elle ne coupe pas non plus une course en cours.** La règle telle qu'écrite faisait disparaître, pour le chauffeur suspendu, la course qu'il était en train de faire — son application cessait de fonctionner au milieu d'un trajet, avec un passager derrière. Une décision administrative ne doit pas produire cet effet-là.

**Mais elle doit agir immédiatement là où elle compte (constat du 9 septembre).** Suspendre passe bien `is_online` à faux côté Odoo, et **rien ne le dit au service temps réel** : le chauffeur reste dans le vivier géo-indexé et continue de recevoir des propositions jusqu'à l'expiration de sa position. Le franchissement du plafond d'encaisse, lui, prévient le service explicitement — un mécanisme construit avec soin pour un cas, jamais appliqué au cas voisin.

C'est la forme que ce projet connaît bien : ce qui manque n'est pas le mécanisme, c'est son application au second endroit qui en avait besoin.

---

## 7 bis. Restaurer une disponibilité, ou ne pas la restaurer (D56)

Le câblage de la suspension a posé une question qui paraît un détail et qui ne l'est pas : à la levée d'un blocage, remet-on le chauffeur dans le vivier ?

Deux blocages voisins y répondent différemment, et c'est délibéré. Le franchissement du plafond d'encaisse **interrompt** une disponibilité que le chauffeur avait déclarée : il était en ligne, il travaillait. Lever le blocage lui rend l'état qu'il avait choisi. La suspension, elle, **détruit la session** — les jetons sont révoqués, la connexion tombe. À la réactivation, il n'y a aucune intention antérieure à restaurer : le chauffeur rouvre son application et se redéclare en ligne (D7).

**La règle, énoncée pour qu'on n'ait pas à la redécouvrir** : un blocage qui interrompt une disponibilité la restaure à sa levée ; un blocage qui détruit la session ne la restaure pas. La question n'est jamais « les deux routes doivent-elles se ressembler ? » mais « une intention déclarée survit-elle au blocage ? ».

**Une correction au passage, sur un filet mal identifié.** Le rapport de nuit compte la révocation des jetons parmi les protections contre un chauffeur suspendu resté visible. Elle n'en est pas une : révoquer force une reconnexion, elle ne l'interdit pas — une nouvelle authentification Google produit une session valide, et c'est voulu (L1-01 ne rejette jamais un chauffeur non approuvé, elle lui renvoie son statut). Ce qui l'empêche réellement de repasser en ligne, c'est le contrôle d'éligibilité côté Odoo. La distinction compte : quelqu'un qui croirait la révocation suffisante pourrait retirer ce contrôle un jour, et rouvrir le trou.

**Et elle le dit dans la bonne monnaie (D53, 7 septembre).** La devise de la société était le dollar. Un rapport de nuit l'avait classé « cosmétique — le back-office affiche des dollars » ; ce ne l'était pas. Le mouvement de compte courant prend par défaut la devise de la société, et l'écriture comptable aussi : **le compte courant des chauffeurs et le grand livre étaient donc libellés en dollars**, pendant que l'API annonçait « XAF » en dur. Le nombre était le même, la monnaie ne l'était pas — dans un produit dont l'objet entier est la réconciliation d'espèces en francs CFA.

La cause : les données de démonstration d'Odoo créent des écritures comptables dès l'installation, et Odoo refuse ensuite de changer la devise d'une société qui en possède. Le correctif porte donc sur les deux bouts — **ces données n'ont rien à faire dans cette base**, et la devise est exigée à l'installation, vérifiée mécaniquement comme les contraintes de D52.

Ce qui vaut d'être retenu : « cosmétique » est un jugement qu'il faut vérifier avant de le poser. Ici, une phrase sur un affichage cachait un grand livre dans la mauvaise monnaie.

**La comptabilité dit la même chose que le compte courant, jamais autre chose (D34, 20 août).** C'est une évidence tant qu'on ne l'écrit pas, et une source de dérive dès qu'on l'oublie. La créance sur le chauffeur n'est soldée qu'à hauteur de ce qui a été **réellement reçu** ; le reliquat reste dû au bilan, du même montant que celui resté au compte courant. Les deux systèmes se vérifient alors l'un l'autre au lieu de se contredire.

Le compte d'écart n'intervient qu'au moment où une **décision humaine éteint la dette** — retenue, ajustement — parce que c'est le seul moment où la créance cesse réellement d'exister. Reclasser l'écart hors de la créance dès la remise revenait à écrire dans les livres que le chauffeur ne doit plus rien, et produisait, à la remise suivante, une créance en solde créditeur : l'entreprise devant de l'argent à un chauffeur qui lui en doit.

**Comptes et journaux sont provisoires jusqu'à validation par un comptable.** Le plan de la base de développement n'est pas le SYSCOHADA en usage au Cameroun ; les comptes livrés sont des valeurs par défaut plausibles, paramétrables, à repointer avant le pilote. Voir `05-prerequis-et-simulation.md` §5.
5. Tout écart entre montant attendu et montant remis est enregistré, jamais absorbé silencieusement.

Le plafond remplace la clôture de service comme mécanisme de contrôle. Il ne coûte qu'une règle métier et un champ de configuration.

---

## 7 ter. Ce que le client reçoit après avoir payé en espèces (D57)

La spécification d'origine réservait l'envoi de la facture à la demande du client : « un email par course serait subi ». L'argument portait sur la gêne, et il n'était pas absurde — mais il raisonnait sur le cas ordinaire, où rien ne se passe et où la facture ne sert à rien.

**Le cas qui compte est celui de la contestation**, et il a deux propriétés qui renversent l'arbitrage. D'abord, personne ne réclame une facture dont il ignore l'existence : un envoi à la demande, en pratique, est un envoi qui n'a jamais lieu. Ensuite, une facture réclamée arrive trois jours après la course, quand le passager ne sait plus ce qu'il a payé et que le chauffeur non plus. Une trace qui arrive après la discussion n'est plus une trace, c'est un avis.

Sur des courses de mille cinq cents francs payées en espèces, l'écrit immédiat est aussi ce qui protège le chauffeur : c'est lui qu'on accusera d'avoir demandé trop.

**La condition, et elle n'est pas négociable : un échec d'envoi doit se voir.** Un envoi automatique qui échoue en silence est strictement pire que pas d'envoi du tout, parce qu'il retire le dernier humain qui aurait pu constater l'absence. C'est exactement ce que ce projet vient de vivre — la panne SMTP n'a été trouvée que parce que quelqu'un a cliqué et est allé regarder Mailpit. Aucun superviseur ne fera ça tous les jours.

Reste ouvert, hors périmètre pilote : un client qui ne veut pas de ces emails n'a aujourd'hui aucun moyen de le dire.

---

## 7 quater. Ce qu'un pilote ne peut pas rattraper (D67)

La dernière nuit du périmètre s'est terminée sur un avertissement, en réponse à la question « si tu devais prévenir d'une seule chose la personne qui lance les premières vraies courses ». La réponse : **il n'existe aucun journal d'audit immuable.** `_babana_journalize()` écrit chaque transition dans les journaux applicatifs ordinaires depuis le premier jour, et son propre commentaire s'en excuse presque — « point d'accroche unique pour L8-09, pour l'instant journal applicatif standard ».

J'avais laissé L8-09 hors périmètre pilote. C'était une erreur, et elle mérite d'être nommée parce que le raisonnement qui l'a produite est séduisant : le pilote est petit, quelques dizaines de courses par jour, surveillées de près — on arbitrera à la main. C'est vrai de presque tout. **Ce n'est pas vrai de la traçabilité.**

La plupart des manques d'un pilote se rattrapent : une fonction absente s'ajoute, un écran illisible se refait, un seuil mal calibré se change le soir même. **Une donnée qu'on n'a pas enregistrée est perdue définitivement.** Le jour où un chauffeur conteste une remise ou un passager un montant, la question ne sera pas « peut-on développer un journal », elle sera « qu'est-ce qui s'est passé le 14 » — et il n'y aura rien à consulter.

C'est aussi le pilote qui produit précisément les litiges dont on a besoin pour calibrer la suite : un écart de caisse contesté, une course facturée deux fois, un montant discuté au bord de la route. Les perdre, c'est perdre l'essentiel de ce qu'un pilote sert à apprendre.

La règle générale : **ce qu'un pilote ne peut pas rattraper passe devant ce qu'il peut différer**, et la traçabilité est presque toujours dans la première catégorie. Le reste du lot L8 — TLS en recette, chiffrement au repos, conservation des positions — reste différé, et se rattrape.

---

## 8. Écarts assumés avec le cahier des charges

Ces écarts sont des décisions, pas des oublis. Ils doivent être validés par le maître d'ouvrage.

**É1 — Authentification (CDC §VII.1, §X.3.a)**
Le CDC impose inscription et connexion par numéro de téléphone avec OTP SMS. D4 retient Google Sign-In seul. Conséquence : numéro non vérifié, et exclusion des utilisateurs sans compte Google actif — population non négligeable sur la cible chauffeurs. À réévaluer si le taux d'échec d'inscription observé en pilote est élevé.

**Étendu le 17 septembre (D66) : le pilote démarre sans OTP du tout.** L1-09 était la dernière tâche de périmètre pilote suspendue à une démarche externe, et cette démarche n'a pas avancé en dix jours pendant que le développement, lui, finissait. Attendre aurait décalé le pilote de la durée exacte de la contractualisation, sans rien produire entre-temps.

Ce que la décision coûte, honnêtement : **côté chauffeur, rien** — ils sont salariés, recrutés en personne, et leur numéro est vérifié à l'embauche par quelqu'un qui les a en face de lui. C'est une vérification plus forte qu'un SMS. **Côté client, le numéro reste déclaré et non vérifié**, et le risque concret est qu'un chauffeur ne puisse pas rappeler un passager dont le numéro est faux — au moment précis où il ne le trouve pas au point de rendez-vous. Sur quelques dizaines de courses par jour, ce cas se constate, se compte, et décide de la suite.

**Ce qui doit donc être mesuré pendant le pilote** : combien de courses échouent faute de pouvoir joindre le passager. C'est le chiffre qui dira si l'OTP est une commodité ou une nécessité — et le pilote existe pour produire ce genre de chiffre plutôt que pour confirmer une intuition. L1-09 reste écrite, spécifiée, et prête à être faite le jour où une passerelle existe.

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
- **L'export web ne persiste aucune session (D39, 24 août).** Un navigateur n'a pas de trousseau système à qui déléguer : tout ce qu'on y range est lisible par n'importe quelle injection de script. Le jeton de renouvellement, qui vaut une session entière et survit à l'expiration du jeton d'accès, n'y a donc pas sa place. La session web vit en mémoire ; fermer l'onglet déconnecte, rouvrir demande une reconnexion Google — deux clics, puisque la session Google du navigateur est déjà ouverte. C'est le coût réel de D22, et il est acceptable précisément parce que l'export web est un complément de démonstration, pas le canal principal. Un cookie inaccessible au script serait la bonne réponse pour une vraie application web ; il exigerait un second mécanisme d'authentification à côté du porteur, ce que D35 vient d'écarter.

---

## 9 quinquies. Deux gardes, dont une seule s'exécute (D54)

Le lot des habilitations a livré des règles d'enregistrement correctes : un chauffeur ne voit que ses courses, un client aucun document de chauffeur, personne le compte courant d'un autre. Chacune testée, y compris par la négative.

**Et aucune ne s'exécute sur le chemin mobile.** Les contrôleurs lisent tous en `sudo`, donc les règles sont contournées à chaque requête. La protection réelle est le contrôle explicite écrit dans chaque contrôleur — « l'appelant est-il partie à cette course ? » — posé par L4-03.

Rien ne fuit aujourd'hui : les deux mécanismes disent la même chose. Mais c'est exactement la configuration que ce projet a appris à redouter — deux gardes pour une même règle, dont une seule tourne. Le jour où un contrôleur oublie son contrôle, la seconde ligne ne le rattrapera pas, parce qu'elle n'est pas sur le chemin.

**Les lectures se font donc au nom de l'utilisateur.** Les règles deviennent la garantie, et le contrôle du contrôleur devient ce qu'il aurait toujours dû être : la façon de dire *pourquoi* c'est refusé, pas *si* c'est refusé. Les écritures gardent `sudo` — elles passent par les transitions, qui portent leurs propres préconditions (invariant 2).

Effet secondaire souhaitable : la course d'un autre ne se distingue plus d'une course inexistante. On ne confirme même pas qu'elle existe.

---

## 9 quater. Une contrainte déclarée n'est pas une contrainte posée (D52)

Deux fois maintenant, une contrainte SQL déclarée dans le module n'existait pas en base. La première protégeait le solde d'un chauffeur contre le passage sous zéro ; elle ne pouvait pas être créée, parce que le champ n'est pas stocké. La seconde garantit l'unicité de l'identifiant public d'un utilisateur ; elle a échoué parce qu'Odoo remplit une nouvelle colonne sur une table déjà peuplée avec **une seule évaluation de la valeur par défaut** — les sept comptes système ont donc reçu le même identifiant, et la contrainte d'unicité n'a pas pu se poser dessus.

Dans les deux cas, Odoo a **journalisé l'échec et poursuivi l'installation**. C'est un choix défendable de sa part — refuser d'installer un module pour une contrainte est brutal — mais la conséquence pour nous est qu'une garantie annoncée dans le code, documentée dans le contrat, n'existe nulle part ailleurs que dans notre confiance.

**Une contrainte qui échoue silencieusement ressemble exactement à une contrainte qui protège.** C'est ce qui la rend pire qu'une absence de contrainte : personne ne va vérifier ce qui est déjà écrit.

La liste des contraintes déclarées se compare donc à celle des contraintes présentes en base, après installation, mécaniquement. C'est la même famille de vérification que le jeton qui traverse deux services, les endpoints appelés contre le vrai serveur, ou la cartographie des messages : **rendre mécanique une lecture qu'aucune relecture ne fait fiablement.**

Le corollaire vaut au-delà des contraintes : **un identifiant unique généré par valeur par défaut n'est pas unique** sur une table déjà peuplée. Le remplissage se fait en une passe, pas ligne par ligne.

---

## 9 ter. Une configuration qui retombe sur le vrai fournisseur masque sa propre panne (D43)

La recherche de lieu a été routée vers le simulateur, la variable d'environnement injectée, la valeur littérale vérifiée dans le bundle produit — et l'appel réel partait quand même chez Google. La cause probable est une double instanciation du module dans le bundle : deux exemplaires de la même configuration, l'un renseigné, l'autre lu.

Cette cause est banale et se corrigera. **Ce qui l'a rendue invisible ne l'est pas** : la configuration non renseignée retombait sur l'adresse du vrai fournisseur. Le code faisait donc exactement ce qu'il fait quand tout va bien, avec un destinataire différent — et personne ne pouvait le voir sans regarder le trafic réseau.

Une valeur par défaut qui pointe vers le vrai service transforme une erreur de configuration en comportement silencieux. Non configuré, on échoue, bruyamment, à l'appel. C'est le même principe que partout ailleurs ici — une absence explicite plutôt qu'une valeur plausible et fausse — appliqué cette fois à la configuration elle-même.

**Corollaire pour les paquets partagés** : une configuration tenue dans une variable de module suppose qu'il n'existe qu'un exemplaire du module. Un empaqueteur ne le garantit pas. Ce qui doit être configuré une fois et lu partout se passe explicitement, ou se vérifie à l'usage.

**Et le banc de vérification reproduit la production, jamais l'inverse (D46, 29 août).** L'export web a buté sur un préflight CORS refusé, ce qui a fait proposer d'ajouter le support de CORS à l'API. Mais en production, Caddy sert le bundle et l'API **sous le même domaine** (D18) : CORS ne s'y applique jamais. C'est le banc d'essai qui utilisait deux origines, pas la production.

Ajouter des en-têtes CORS à une API qui porte des jetons pour satisfaire un banc d'essai reviendrait à ouvrir une vraie surface d'attaque pour accommoder une erreur de montage. Quand une vérification révèle un problème que la production n'aura pas, **c'est la vérification qu'on corrige** — sinon on finit par durcir le produit contre des contraintes imaginaires, et par manquer les vraies.

---

## 9 bis. Ce qui compte comme une vérification (D38)

Le bundle web se construisait sans erreur depuis quatre nuits. Il affichait une page blanche : le fichier HTML ne chargeait jamais le script. Derrière ce premier défaut s'en cachaient trois autres, chacun masqué par le précédent, dont un qui empêchait l'application de dépasser l'écran de chargement.

Mon critère d'acceptation disait « vérifié par une compilation web réussie, pas par la seule confiance dans la bibliothèque ». Je me méfiais de la bonne chose et j'ai vérifié la mauvaise : **une compilation prouve qu'un assemblage est possible, pas qu'il fonctionne.** Entre les deux, il y a tout ce qui ne s'exécute qu'au chargement.

La règle qui en découle vaut pour tout ce que quelqu'un finira par ouvrir — une application, une page, un document produit, un export : **le critère est que quelqu'un l'ait ouvert**, pas que la chaîne de production se soit terminée sans erreur. Pour le reste — une bibliothèque, un service sans interface — le test automatisé reste la preuve, et il l'est mieux qu'un humain.

C'est la troisième fois qu'un de mes critères vérifie quelque chose d'adjacent à ce qui compte : l'écriture comptable équilibrée plutôt que la créance juste, l'exclusion mutuelle de deux transitions qui ne s'excluent pas, et maintenant la compilation plutôt que l'exécution. À chaque fois le test était vert et la propriété fausse.

---

## 9 sexies. Une variable documentée, gardée, et jamais délivrée (D59)

Trois fois le même défaut, sous trois formes, et il faut le nommer parce qu'il ne se corrigera pas une quatrième fois par hasard.

**Le mot de passe administrateur** (11 septembre) : décrit dans `05-prerequis-et-simulation.md` depuis le premier jour, présent dans la table des variables, jamais posé sur un compte. Le back-office est resté inaccessible trois nuits, et cinq écrans cassés sont restés invisibles derrière.

**Le relais SMTP** (nuit J36) : `SMTP_HOST` et ses quatre compagnes documentées « pour l'envoi de facture », posées sur le conteneur depuis des semaines, refusées par `deploy.sh` si elles pointent vers un simulateur — et traduites nulle part en `ir.mail_server`. Odoo retombait sur sa connexion locale par défaut, `mail.mail.send()` échouait, et l'échec ne vivait que dans un champ que personne n'a de raison d'ouvrir. Aucun email n'est jamais parti de ce projet, y compris ceux d'avant cette tâche.

**Le bundle web de production** (13 septembre, ma revue) : `deploy.sh` lit `.env`, examine `BABANA_MAPS_SEARCH_URL`, avertit si elle pointe vers un simulateur — puis lance `npm run build:web` sans l'exporter. Un `. fichier` en shell pose des variables, il ne les transmet pas aux processus fils. Le garde-fou juge une valeur qu'il ne délivre pas. Même sort pour l'identifiant client Google : le bundle actuellement dans le dépôt porte `MAPS_SEARCH_URL = undefined` et `GOOGLE_WEB_CLIENT_ID = ''`. Déployé tel quel, le Client web ne permet ni de se connecter, ni de chercher un lieu.

**Ce que les trois ont en commun** : une variable a trois moments — elle est *déclarée* (table, `.env.example`), elle est *livrée* (compose, export, hook d'installation), elle est *consommée* (le code qui la lit). Le projet vérifiait le premier et le troisième séparément. Personne ne vérifiait le lien.

Et le motif est plus large que la configuration : c'est celui de `make seed`, de la contrainte d'unicité, du mot de passe administrateur. **Une phrase dans un document ressemble beaucoup à un mécanisme qui fonctionne.** La différence ne se voit qu'en tirant sur le fil jusqu'au bout — ce que fait un test, jamais une relecture.

**Suite, le 14 septembre.** L0-10 est faite, et le mécanisme tient — mais il a fallu lui donner deux listes d'exclusion pour qu'il ne hurle pas sur cinquante réglages métier légitimes. Ces listes sont honnêtes, commentées, et chacune se défend. Une seule entrée me gêne : `BABANA_API_URL` et `BABANA_REALTIME_WS_URL` y figurent au motif que leur repli est « une adresse de production réelle ». C'est vrai, et c'est le problème — **un binaire de recette construit sans ces variables parlerait au serveur de production**, et écrirait de vraies courses dans la base du pilote sans que rien ne le signale. Le repli plausible est plus dangereux que l'absence : c'est exactement D43, appliqué à une adresse qu'on a jugée inoffensive parce qu'elle est juste. D'où D61.

D'où D59, et la tâche L0-10 qui le rend mécanique : une suite qui parcourt les trois moments et échoue dès que l'un manque. C'est la même famille de filet que la poignée de main sur le jeton, la cartographie des messages et la comparaison des contraintes SQL — chacune née d'un défaut que la relecture avait laissé passer.

---

## 9 septies. Deux façons de croire qu'on a vérifié (D62, D63)

La nuit J38 a fait tourner `backup.sh` pour de vrai contre la pile vivante, chiffré les trois sorties, monté des conteneurs neufs, déchiffré, rechargé, et retrouvé une course encaissée, sa facture, un document et un solde — avec les identifiants et l'empreinte de l'objet à l'appui. C'est du travail sérieux, et il a trouvé trois défauts que la relecture n'avait jamais vus : un miroir de documents qui partait en clair, une image MinIO sans `tar`, et un `${VAR:?...}` que bash 3.2 refuse d'analyser.

**Et pourtant `restore.sh` n'a jamais été exécuté.** Ses commandes ont été rejouées une à une. La différence n'est pas de la pédanterie : un script porte un ordre, des gardes, des variables par défaut, des codes de retour et un comportement en cas d'échec partiel, et rien de tout cela n'est exercé quand on en extrait les lignes utiles. Son en-tête affirme d'ailleurs que `.env` est un prérequis, alors que le script le déchiffre lui-même quelques lignes plus bas — le genre de contradiction qu'une exécution réelle tranche en dix secondes.

C'est la même distinction que D38 (une compilation n'est pas une exécution) et D52 (une contrainte déclarée n'est pas une contrainte posée), appliquée cette fois à l'outillage d'exploitation. Et elle porte plus loin ici, parce que **c'est le script qu'on lance à trois heures du matin, quand la base a disparu et que personne n'a envie d'improviser.**

**L'autre façon, c'est de peupler une liste en croyant peupler un écran.** `make seed` crée deux documents par chauffeur, chacun avec sa clé de stockage, et ne téléverse aucune image — pas une seule, dans tout le jeu de données. La nuit J38 en a trouvé un cas en vérifiant sa restauration, l'a signalé comme une occurrence isolée hors périmètre, et avait raison sur le périmètre : le balayage depuis l'autre bout montre qu'il n'y a simplement aucun téléversement dans `seed.py`.

Conséquence concrète : **l'écran où un superviseur regarde un permis pour approuver un chauffeur n'a jamais été vu avec une image.** C'est le geste central de L6-15, une tâche de périmètre pilote. Le corollaire du point 9 disait déjà « le jeu de démonstration doit peupler chaque écran qui existe » ; il faut le dire plus précisément, parce qu'il a été respecté à la lettre et manqué en substance : **un enregistrement qui pointe vers rien peuple une liste, pas un écran.**

---

## 9 octies. Un test qui s'exécute du mauvais côté de la frontière (D64)

`generate_signed_url()` construit son client S3 sur `S3_ENDPOINT`, c'est-à-dire `http://minio:9000` — le nom du service dans le réseau Docker interne. Cette URL est renvoyée telle quelle au navigateur qui clique sur « Voir la pièce ». Aucun navigateur, nulle part, ne résout ce nom. En production non plus : `compose.yaml` ne publie aucun port MinIO et le Caddyfile ne proxifie rien vers lui.

**L'écran où un gestionnaire vérifie un permis avant d'approuver un chauffeur n'aurait pas fonctionné le premier jour du pilote.** C'est le geste central de L6-15 et de L9-01, deux tâches de périmètre pilote, toutes les deux déclarées finies.

Et `test_documents.py` était vert depuis des semaines. Il appelle `generate_signed_url()` **depuis l'intérieur du conteneur Odoo**, où `minio` se résout parfaitement. Le test ne mentait pas : il prouvait une propriété vraie à l'endroit où il s'exécutait, et fausse partout ailleurs.

C'est une variante de D38 qu'on n'avait pas encore rencontrée. Jusqu'ici, le motif était « la chaîne de production s'est terminée sans erreur » contre « quelqu'un l'a ouvert ». Ici la vérification était bien une exécution, pas une compilation — mais elle s'exécutait du mauvais côté d'une frontière réseau. **La question à poser n'est pas seulement « est-ce que ça a tourné », c'est « est-ce que ça a tourné là où le vrai utilisateur se tient ».**

La règle qui en découle : **toute valeur qui traverse la frontière vers un client se vérifie depuis l'extérieur.** Une adresse, un lien, une URL signée, une redirection. Vérifié le 16 septembre que `S3_ENDPOINT` est le seul cas dans ce dépôt : `ODOO_INTERNAL_URL`, `REALTIME_INTERNAL_URL` et `REDIS_URL` restent de service à service, et le lien de partage de trajet se construit sur `BABANA_DOMAIN`. Un seul cas, donc — mais il portait le geste d'approbation d'un chauffeur.

**Et D61 ne s'arrête pas aux applications mobiles.** `controllers/share.py::_share_base_url()` retombe sur `https://babana.cm` si `BABANA_DOMAIN` est absente — une adresse de production en repli, exactement ce que D61 interdit, appliquée jusqu'ici au seul `apps/*/config.ts`. Le risque est faible (`deploy.sh` exige `BABANA_DOMAIN`), la règle est la même : une adresse absente échoue, elle ne se devine pas.

**Portée la nuit J40, et le repli n'était pas un simple filet de sécurité.** Corrigé
(`os.environ['BABANA_DOMAIN']`, plus de `.get(..., 'babana.cm')`). Mais en creusant *pourquoi*
ce repli s'exécutait TOUJOURS plutôt que rarement, un maillon plus grave est apparu :
`infra/compose.yaml` ne délivrait `BABANA_DOMAIN` **qu'au service `caddy`**, jamais au
conteneur `odoo` qui exécute `share.py`. Ce n'était pas un filet de sécurité pour un cas rare —
c'était le seul chemin qui ait jamais existé. Un lien de partage de trajet construit en recette
(`staging.babana.cm`) aurait toujours pointé vers la production. Corrigé en délivrant
`BABANA_DOMAIN` à `odoo` comme à `caddy`.

**Troisième cas, hors de l'application** : `infra/production/monitoring/probe.sh`
(`DOMAIN="${DOMAIN:-babana.cm}"`) — une sonde de supervision externe qui, sans son paramètre,
surveillerait silencieusement la PRODUCTION en croyant surveiller la recette. Son propre voisin,
`probe-host.sh`, avait déjà la bonne discipline pour `SSH_TARGET` (`:?` obligatoire, aucun repli)
— l'incohérence entre les deux scripts était le signal. Corrigé de la même façon.

**Portée le soir même (J40).** Un point d'entrée public dédié (`storage.<domaine>`, Caddy, API
S3 seule — jamais la console), une variable `S3_PUBLIC_ENDPOINT` distincte de `S3_ENDPOINT`
(protocole des trois moments, D59), `generate_signed_url()` signe désormais pour elle. Vérifié
depuis l'extérieur de tout conteneur (`test/storage/public-entrypoint.test.ts`) — la vraie
preuve, là où `test_documents.py` ne pouvait pas aller. Et le bouton « Voir la pièce » cliqué
pour de vrai, dans un navigateur, sur la fiche d'un chauffeur du jeu de démonstration.

---

## 9 nonies. Le contrôle qui a laissé passer le défaut qu'il cherchait (D65)

L0-10 a été écrite pour une raison précise : trois fois, une variable documentée et gardée n'avait jamais été délivrée au code qui la lit. Le contrôle des trois moments — déclarée, livrée, consommée — devait rendre cela mécanique.

La nuit J40 a trouvé, à la main, un quatrième cas. `BABANA_DOMAIN` était bien déclarée, bien consommée par `controllers/share.py`, et livrée… au seul service `caddy`. Le conteneur `odoo`, qui exécute ce fichier, ne la recevait pas. Le repli `https://babana.cm` que j'avais fait retirer comme une imprudence théorique n'était pas un filet pour un cas rare : **c'était le seul chemin qui ait jamais existé.** Chaque lien de partage de trajet, dans tous les environnements depuis le premier jour, portait le domaine de production en dur — un déploiement de recette aurait envoyé ses liens vers la production.

**Et le contrôle était vert.** Parce qu'il traite « livrée » comme un booléen : la variable apparaît quelque part dans un fichier compose, donc elle est livrée. Il ne sait pas *à quel service*, ni *où s'exécute le code qui la lit*.

Ce qui rend ce cas intéressant n'est pas l'oubli — c'est que le mécanisme construit pour cette famille de défaut a regardé celui-ci en face et ne l'a pas vu. Une vérification qui répond à côté de la question est plus dangereuse qu'une absence de vérification : elle produit une confiance.

Vérifié le 17 septembre, après le correctif, qu'aucun autre cas ne subsiste : toute variable lue par le code Odoo figure au bloc `environment` du service `odoo`, et de même pour le service temps réel. Le dépôt est propre — par la correction d'hier, pas par construction. D'où D65 : **la livraison se vérifie par service**, en rapprochant le répertoire du consommateur de l'environnement qui l'exécute.

C'est la deuxième fois que la nuit trouve un défaut en demandant *pourquoi* un repli s'exécutait, plutôt qu'en le supprimant. Le geste mérite d'être nommé : **un repli qui sert est un symptôme, pas une précaution.**

---

## 9 decies. Deux gardes justes qui composent un silence (D68)

L8-09 est bien construite, et j'ai vérifié les deux points où elle pouvait mal tourner. Le savepoint dédié de `_babana_record` est ouvert par l'aide de l'ORM, qui vide l'environnement **avant** de le poser : les écritures métier en attente sont déjà en base quand le savepoint s'ouvre, et son annulation ne les emporte pas. Et `_babana_record` est appelé après l'écriture qu'il décrit à chacun des huit sites. Le mécanisme tient.

Ce qui ne tient pas est ailleurs, et vient de la composition de deux décisions correctes.

**Le journal ne lève jamais** — c'est le critère 3, et il a raison : un journal qui bloque les courses serait désactivé le premier jour d'incident. **L'écriture y est interdite à tous** — c'est le critère 2, et il a raison aussi.

Ensemble, ils produisent ceci : si l'écriture du journal casse un jour, l'opération métier continue, rien ne lève, aucune entrée n'est créée — et la seule trace de la panne part dans `_logger.exception`, c'est-à-dire **dans le journal applicatif ordinaire que L8-09 existe précisément pour remplacer.** La traçabilité peut s'arrêter sans que personne ne l'apprenne, et on ne s'en apercevra qu'au moment d'aller chercher une entrée qui n'a jamais été écrite — le jour du litige, exactement le scénario contre lequel la tâche a été programmée.

C'est la leçon de D57, non appliquée ici : **un mécanisme automatique dont l'échec est invisible est pire que le geste manuel qu'il remplace**, parce qu'il retire le dernier humain qui aurait pu constater l'absence. On l'avait écrit pour l'envoi de facture le 15 septembre, on l'a redécouvert quatre jours plus tard sur un autre objet.

Ce qui rend le motif intéressant, c'est qu'aucune des deux décisions n'est en cause. Le défaut n'est pas dans une pièce, il est dans leur assemblage — comme les trois trous de découpage que j'ai laissés, tous sur les chemins entre composants, jamais dans un composant. **Une revue examine des pièces ; les défauts vivent entre elles.**

---

## 9 undecies. Un test qui mesure l'histoire au lieu du scénario (D69)

La nuit J43 a rencontré un test du lot L5 qui échouait de façon parfaitement reproductible sur une base ancienne — 45 850 attendu contre 45 000 — et passait sur une base fraîche. Elle a supposé un paramètre dérivé par une session antérieure, l'a nommé plutôt que de le taire, et a laissé la question ouverte parce que L5 n'était pas son périmètre. C'était le bon réflexe.

La cause est plus simple, et elle est dans les trois dernières lignes du test :

```python
total_credited = sum(
    self.env["account.move.line"]
    .search([("account_id", "=", int(receivable_account))])
    .mapped("credit")
)
self.assertEqual(total_credited, 45000, "le total réellement crédité égale le total reçu")
```

Ce `search` n'est borné par rien. Il somme **tous** les mouvements du compte de créance présents dans la base, pas les deux que le scénario vient de produire. Sur une base vide, les deux nombres coïncident et le test paraît juste. Dès que la base contient autre chose, il mesure l'histoire de la base — et le message d'assertion, qui parle du « total réellement crédité », décrit alors quelque chose que le scénario ne contrôle pas.

`test_discrepancy.py` porte exactement le même motif sur le même compte.

**Ce n'est pas un test instable, c'est un test qui prouve autre chose que ce qu'il annonce.** Et il le prouve dans le seul lot que `CLAUDE.md` place sous revue humaine obligatoire, pour une raison précise : une matrice fausse produit des tests verts qui valident les mauvaises règles. Ici, deux assertions comptables ne valident rien du tout dès qu'une donnée réelle existe — c'est-à-dire qu'elles cesseront de valider quoi que ce soit exactement au moment où le pilote démarrera.

La règle : **une assertion est bornée à ce que son scénario a produit.** Les pièces de cette remise, les mouvements de ce chauffeur, les lignes de cette course — jamais « tout ce que porte ce compte ». Une agrégation non bornée dans un test est une mesure de l'environnement déguisée en mesure du code.

Et le corollaire pour la lecture des symptômes, qui vaut au-delà de ces deux tests : **un test qui échoue sur une base ancienne et passe sur une base fraîche n'accuse pas toujours la base.** Le dépôt documentait déjà le sens inverse — des tests verts sur une base accumulée, rouges au premier `make reset`. Celui-ci est le même défaut vu de l'autre côté, et il se diagnostique en lisant l'assertion avant d'accuser l'environnement.

---

## 9 duodecies. Trois explications, un seul symptôme (D70)

Quatre incidents intermittents ont été relevés en dix nuits. Deux ont été diagnostiqués et corrigés — une contention Redis entre deux fichiers de test, un `sleep` remplacé par un fait déterministe. Les deux autres sont restés « vus une fois, jamais reproduits », et ont été catalogués comme tels.

En les recoupant, ce ne sont pas deux incidents isolés. **Trois nuits différentes portent le même symptôme** : « chauffeur jamais apparu dans `nearby.drivers` après 20 000 ms », suivi d'un silence complet du processus de test.

- Le 15 septembre, trois fichiers, même message — attribué à une machine mise en veille.
- Le 19 septembre, un scénario — attribué à deux exécutions concurrentes contre la même pile, cause réelle et identifiée.
- Le 20 septembre, un scénario de plus, même message, **même silence de seize minutes** — et cette fois une seule exécution, vérifiée, avec un processus à 0 % de CPU et aucune connexion réseau ouverte.

Chaque explication était plausible pour son occurrence. Aucune ne couvre la dernière, qui écarte explicitement les deux précédentes. Et la signature observée — un processus arrêté, sans connexion, plutôt que lent — ne ressemble pas à une machine chargée : elle ressemble à un figement.

**Ce que le recoupement change** : quatre défauts épars sont une nuisance qu'on tolère ; un même défaut vu trois fois dans un seul mécanisme est une piste. Et le mécanisme concerné n'est pas anodin — c'est celui qui décide si un client voit un chauffeur. Un chauffeur qui n'apparaît pas dans le vivier, en production, c'est un client qui ouvre l'application et ne trouve personne.

La règle : **un incident intermittent se catalogue par son symptôme, jamais par la nuit où il est apparu.** Une explication d'environnement par occurrence est un moyen efficace de ne jamais voir un motif — chacune est raisonnable, aucune n'est fausse, et l'ensemble reste invisible parce que rien ne les rapproche. Le rapport de nuit les enregistre bien ; c'est au débrief du lendemain de les relier, et il a mis trois nuits à le faire.

Note sur L0-09, maintenue hors périmètre : le problème ici n'est pas la détection. Chaque occurrence a été signalée, honnêtement, dans son rapport. Un détecteur d'instabilité aurait produit une quatrième ligne dans une liste, pas le rapprochement.

---

## 9 terdecies. Un filet placé derrière quelque chose qui peut se taire (D71)

La nuit J45 a trouvé son défaut : deux connexions ouvertes avant le `try`, un `finally` qui ne les couvrait donc pas, et un processus qui n'en sortait jamais. Un nettoyage qui ne s'exécute que sur le chemin nominal.

En relisant ce qu'elle avait relevé sans le traiter, le même motif existe une couche plus bas, et il est cette fois dans le service.

**`callOdoo` n'a aucun délai.** `pingOdoo`, dix lignes au-dessus dans le même fichier, en a un. C'est le seul appel sortant du système dans ce cas — vérifié : Odoo vers le routage, vers le service temps réel, vers les notifications, vers le jeu de clés Google, tous en portent un ; le ping de santé aussi. Les deux seuls qui n'en ont pas sont ceux qui transportent le travail réel.

Ce qui rend l'asymétrie coûteuse n'est pas l'attente en elle-même, c'est ce qui est empilé derrière :

- `callOdoo` porte une **boucle de réessai** — trois tentatives, délai croissant. Un premier appel qui ne se termine jamais n'atteint jamais le deuxième.
- Derrière cette boucle, la **file de rejeu** (L3-12), écrite pour qu'un refus dont l'appel Odoo échoue ne bloque pas une course pour toujours. Elle se déclenche sur un échec. Un appel qui se tait n'échoue pas.

**Tout l'édifice de récupération suppose qu'Odoo réponde ou refuse, jamais qu'il se taise.** Et l'hypothèse est fausse dès qu'un verrou de base traîne ou qu'un travailleur sature — sur un VPS unique, ce n'est pas un cas limite.

C'est le motif de la nuit J45, transposé : **un rattrapage placé derrière quelque chose qui peut se taire ne s'exécute jamais.** Le `finally` du test attendait une exception qui sautait par-dessus lui ; la file attend un échec qui ne vient pas.

La règle : tout appel sortant porte un délai, et le délai n'est pas une précaution contre la lenteur — c'est **ce qui transforme un silence en échec**, donc ce qui permet à tout ce qui est placé derrière d'exister.

Deux notes pour la suite. La nuit avait raison de ne pas corriger sans preuve : c'est ce que je lui avais demandé, et le raisonnement ci-dessus n'est pas une preuve d'occurrence, c'est une preuve d'inconsistance avec une hypothèse que le dépôt pose ailleurs. Et le dépassement occasionnel de `waitForDriverVisible` reste sans explication — le figement le masquait, il ne le masque plus.

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

---

## 13. Décisions arbitrées, pas encore portées

**Créé le 2 septembre, après avoir constaté que D42 n'avait jamais été implémentée.** Elle avait
été arbitrée le 27 août, écrite dans la spécification du contrat, et aucun prompt de nuit ne l'a
reprise — quatre nuits pendant lesquelles les spécifications décrivaient un contrat qui n'existait
pas. C'est exactement le défaut que le retrait de `GET /drivers/nearby` avait corrigé, produit
cette fois par le processus plutôt que par une rédaction ancienne.

**Une décision sans porteur s'évapore.** Le débrief du lendemain rappelle ce qui reste à faire, et
c'est précisément ce qui n'a pas suffi : le rappel vit dans un fichier qu'on ne relit pas, tandis
que le prompt de la nuit vit dans l'action. Ce registre existe pour que l'écart entre les deux soit
visible d'un coup, et il se vérifie chaque matin au même titre que la parité entre tâches et
spécifications.

| Décision | Arbitrée le | Portée par |
|---|---|---|
| **D71** — un délai sur `callOdoo`, et la file prouvée derrière | 22 septembre 2026 | J46 |

**D70 a été portée la nuit J45**, close par une reproduction en direct ; **D66** est un retrait de périmètre, consigné en É1 et dans `06-jalons-et-pilote.md`, sans tâche.

**D64 et D61 étendue ont toutes deux été portées la nuit J40** (`amoa/specs/L1-identite.md`,
L1-05 critères 6 et 7 ; `controllers/share.py` et `infra/compose.yaml`), comme D62/D63 la nuit
J39, D60/D61 la nuit d'avant, D57/D59 celle encore avant — retirées de ce tableau, qui liste ce
qui reste à faire et non un historique. **D58** est portée par le code livré la nuit J36.

Cinq nuits de suite où une décision arbitrée le matin est portée le soir même. Le registre a rempli son office : ce qu'il liste part dans le prompt de la nuit qui suit, jamais dans un rappel qu'on relira plus tard.

*Les trois paragraphes ci-dessus ont été écrits par les sessions de nuit J40 elles-mêmes, directement dans ce document. Le contenu est juste ; le canal ne l'est pas — voir le §2 du débrief du 17 septembre. Laissés tels quels plutôt que réécrits : les effacer donnerait au registre l'air d'avoir toujours été tenu par une seule main.*

**Registre vide, vérifié le 2 septembre (J25).** D42 (numéros de téléphone révélés à
l'affectation), seule ligne depuis la création du registre, a été portée ce soir-là
(`amoa/questions/REPONSES-2026-09-02.md` §1) — retirée du tableau plutôt que laissée cochée : ce
registre liste ce qui reste à faire, pas un historique.

Une ligne qui reste ici plus de deux nuits est un signal, pas une note.
