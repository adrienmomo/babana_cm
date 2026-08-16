# babana.cm — Prérequis externes et stratégie de simulation

**Version** 1.2 — 10 août 2026
**Objet** Permettre à Claude Code d'avancer sans attendre les comptes externes, et poser la politique de valeurs par défaut.

---

## 1. Correction d'une évaluation antérieure

J'avais annoncé que six tâches seraient bloquées d'entrée par l'absence de comptes externes. **C'était trop pessimiste.** En simulant les services tiers, une seule dépendance résiste vraiment, et elle n'apparaît pas avant les tests sur appareil réel.

Le principe qui rend cela possible : **on simule le fournisseur, jamais notre logique.** Le contrôleur d'authentification vérifie une vraie signature contre un vrai jeu de clés — c'est l'émetteur des clés qui est local au lieu d'être Google. Le code de production n'a aucune branche conditionnelle : il regarde une variable d'environnement pour savoir où chercher les clés, et c'est tout.

Un mock qui court-circuite la logique ne prouve rien. Un mock qui remplace l'interlocuteur prouve presque tout.

---

## 2. D19 — Développement en mode simulé par défaut

**Toutes les dépendances externes ont une implémentation simulée, activée par défaut en développement.** Aucun compte tiers n'est requis pour cloner le dépôt, lancer `make up` et parcourir un scénario complet de course.

Corollaire : le scénario de bout en bout de L10-01 s'exécute entièrement en simulé, donc en intégration continue, sans secret et sans coût.

### Ce qui est simulé

| Dépendance | Simulation | Ce qui reste réel |
|---|---|---|
| Google Identity | Service `mock-google` : sert un jeu de clés JWKS et émet des jetons signés à la demande | La **vérification** de signature, `aud`, `iss`, `exp` — code de production inchangé |
| Firebase Cloud Messaging | Implémentation qui journalise la notification et l'expose sur un endpoint d'inspection | Le déclenchement, le routage, la déduplication |
| Passerelle SMS | Implémentation qui journalise le code OTP | La génération, le hachage, l'expiration, la limitation de tentatives |
| API de routage Google | Serveur de doublures renvoyant des réponses enregistrées pour un jeu de couples de points | Le cache, le calcul tarifaire, la gestion d'erreur |
| Recherche de lieu Google | Même serveur, jeu de repères de Douala | La logique de désignation de point |
| S3 | MinIO, déjà au compose | Tout — MinIO parle le protocole S3 |
| SMTP | Mailpit, déjà au compose | Tout |

### La seule chose qui résiste

**Le rendu des tuiles de carte dans les applications.** Sans clé Google Maps valide, l'écran affiche une grille grise. Aucune simulation raisonnable n'existe : c'est un SDK propriétaire qui appelle ses propres serveurs.

Conséquence pratique, limitée : les écrans cartographiques se développent avec une clé de développement, que n'importe qui obtient en quelques minutes avec une carte bancaire, dans le palier gratuit. Ce n'est pas un blocage de projet, c'est une formalité de dix minutes — mais elle doit être faite avant L6-06.

L'abstraction `packages/maps` (L6-01) prévoit d'ailleurs une implémentation simulée pour les tests : les tests d'écran n'ont pas besoin de tuiles, seulement de savoir qu'une carte a été demandée avec les bons paramètres.

### Le service `mock-google` en détail

C'est la pièce qui débloque le plus, elle mérite d'être décrite précisément.

Un service HTTP minimal, ajouté au compose en développement uniquement, qui expose :

- `/.well-known/jwks.json` — un jeu de clés publiques, généré au démarrage
- `POST /token` — émet un jeton d'identité signé avec la clé privée correspondante, avec les champs `sub`, `email`, `email_verified`, `aud`, `iss`, `exp` fournis par l'appelant

Odoo lit l'adresse du jeu de clés dans `GOOGLE_JWKS_URL`. En développement elle pointe sur `mock-google`, en production sur Google. **Le code de vérification est rigoureusement le même dans les deux cas.**

Bénéfice inattendu : les tests négatifs de L1-01 deviennent faciles à écrire. Émettre un jeton avec un mauvais `aud`, un `exp` dépassé, `email_verified` à faux ou une signature d'une autre clé — chacun de ces cas est une requête au service simulé. Contre le vrai Google, ces tests seraient impossibles à produire.

---

## 3. D20 — Interface générique au pilote

Aucune maquette ne sera produite avant le pilote. Les applications utilisent un design system minimal et cohérent, construit dans `packages/ui`, sans direction artistique.

**Contrainte associée** : générique ne veut pas dire négligé. Trois exigences restent non négociables, parce qu'elles relèvent de l'usage et non de l'esthétique.

**Les cibles tactiles de l'application Chauffeur** respectent une taille minimale confortable. Le chauffeur est sur sa moto, parfois avec des gants (L6-12).

**La hiérarchie de l'information prime sur la décoration.** Sur l'écran d'estimation, le montant et le détail décomposé sont les éléments dominants (L6-07). Sur l'écran de recette, le solde dû et la marge avant plafond (L5-07).

**Les messages d'erreur sont écrits, pas techniques.** Chaque code du catalogue de C-01 a une phrase en français compréhensible par quelqu'un qui n'a jamais utilisé d'application de transport (L6-03).

Une refonte visuelle après le pilote sera d'autant plus simple que ces trois points auront été tenus — et d'autant plus coûteuse qu'ils auront été négligés.

---

## 3 bis. D22 — Version web de l'application Client uniquement

L'application Client est exportée en web via React Native Web et déployée sur Vercel, en **canal de démonstration**. L'application Chauffeur reste mobile exclusivement.

### Pourquoi le Client seulement

Les deux fonctions centrales de l'application Chauffeur sont précisément celles qu'un navigateur ne sait pas faire.

**La capture GPS en arrière-plan** (L6-05) s'arrête dès que l'onglet passe en arrière-plan ou que l'écran se verrouille. Un chauffeur qui range son téléphone cesse d'émettre sa position : l'application devient inutilisable dès la première course.

**La proposition de course** (L6-12) doit réveiller l'appareil, s'afficher en plein écran, sonner et vibrer. Un navigateur n'a pas d'équivalent. Un chauffeur en circulation ne regarde pas son écran ; sans ce réveil, il rate toutes les courses.

Ce ne sont pas des limitations à contourner, ce sont des propriétés du navigateur. Une version web de l'application Chauffeur serait une démonstration trompeuse.

### Ce que la version web est, et ce qu'elle n'est pas

**Elle est** un canal de démonstration : une adresse à transmettre à un partenaire, un investisseur ou un testeur, sans installation d'APK et sans attendre la validation du canal de test fermé. C'est particulièrement utile pendant que le compte Google Play est en cours de validation.

**Elle n'est pas** une cible de test qui fasse foi. Deux tâches existent pour mesurer exactement ce que le web ne reproduit pas : L6-17 (consommation batterie et données sur terminaux d'entrée de gamme) et L6-16 (mode dégradé réseau). Un parcours réussi dans un navigateur de bureau ne dit rien d'un téléphone d'entrée de gamme sur un réseau intermittent à Douala. **Les APK sur appareils réels restent la seule preuve.**

### Ce que cette décision impose, dès maintenant

Deux contraintes qui ne coûtent rien si elles sont posées tôt, et cher si elles sont rétrofitées après quinze écrans.

**`packages/ui` n'emploie que des composants compatibles React Native Web.** C'est un choix de composants, pas un travail supplémentaire — à condition de le décider avant L0-03.

**`packages/maps` reçoit une troisième implémentation** pour le rendu web, aux côtés de Google natif. L'abstraction de L6-01 est prévue pour ça ; c'est même une bonne occasion de vérifier qu'elle en est réellement une.

Un second chemin d'authentification est également nécessaire : Google Sign-In natif et flux OAuth web ne sont pas la même intégration. À prévoir dans L6-02.

### Ce qui reste hors de la version web

Notifications push, capture GPS en arrière-plan, et le lien profond de navigation. Sur le web, ces fonctions sont soit absentes, soit dégradées — l'application doit le signaler explicitement plutôt que de faire semblant.

---

## 4. D21 — Valeurs par défaut plausibles, jamais aléatoires

Sur la question des valeurs métier non fixées, la nuance compte.

**Pour les secrets** — clés de signature, mots de passe de développement — une valeur aléatoire générée au premier `make up` est la bonne réponse. Personne n'a besoin de les connaître.

**Pour les valeurs métier** — tarifs, plafond d'encaisse, rayons, délais — l'aléatoire est dangereux, et pas pour la raison qu'on croit. Le risque n'est pas que le calcul soit faux : c'est qu'un test passe avec des chiffres absurdes sans que personne le remarque, et surtout qu'une valeur de remplissage parte en production parce que personne ne se souvenait qu'elle en était une.

Trois règles, donc.

**Des valeurs plausibles, pas aléatoires.** Un prix au kilomètre de l'ordre de ce qui se pratique à Douala, un plafond d'encaisse de l'ordre d'une journée de recette. Une valeur plausible permet de repérer une anomalie de calcul à l'œil ; une valeur aléatoire ne le permet pas.

**Marquées comme provisoires, de façon lisible par une machine.** Chaque valeur non validée porte un marqueur explicite dans la configuration. Un rapport listant toutes les valeurs encore marquées provisoires est consultable dans le back-office.

**Refus de démarrage en production.** Le service refuse de démarrer en environnement de production si une valeur métier est encore marquée provisoire. C'est le garde-fou qui rend les deux premières règles réelles plutôt que déclaratives.

### Où vivent ces valeurs

Distinction importante, souvent mal placée :

| Type | Emplacement | Pourquoi |
|---|---|---|
| Secrets et adresses de services | `infra/env/.env` | Ne changent pas en exploitation |
| Valeurs métier — tarifs, plafonds, délais, rayons | **Base de données**, via les réglages Odoo (L9-06) et `babana.fare.rule` (L2-01) | Ajustées dix fois pendant le pilote, sans déploiement |

Les valeurs métier ne sont donc **pas** dans le `.env`. Elles sont dans des données initiales chargées à l'installation du module, modifiables ensuite depuis le back-office. Un `.env` contenant un prix au kilomètre imposerait un redéploiement pour changer un tarif — exactement ce que L9-06 cherche à éviter.

### Zones de Douala

Cas particulier : les polygones de zones ne peuvent pas être « plausibles ». La réponse simple pour le pilote est **une zone unique couvrant Douala**, avec la grille tarifaire de repli. Le découpage fin viendra quand les données de L9-07 montreront où sont les heures de pointe réelles — le deviner d'avance serait de la fiction.

---

## 4 bis. Outillage requis sur les machines de développement et d'intégration continue

Ajouté le 10 août 2026, après que L0-03 s'est révélée invérifiable faute d'outillage. Ce n'était pas une erreur de spécification mais une omission : les spécifications décrivaient quoi construire sans dire avec quoi.

| Outil | Version minimale | Pourquoi | Bloque |
|---|---|---|---|
| Node | **22.11.0** | Exigé par `engines` de React Native 0.86. Node 20 fonctionne pour Metro, TypeScript et les tests, mais rien ne garantit qu'un build natif passe | L0-03, L0-05 |
| SDK Android, ligne de commande | API 34 ou ultérieure | Build d'APK. Android Studio complet n'est pas nécessaire | L0-03 critère 4, L0-05, L10-07 |
| Java | Selon la version de Gradle du projet | Chaîne de build Android | L0-03, L0-05 |
| Docker | Récent, avec `compose` intégré | Toute la pile | L0-01 et suivantes |

**L'intégration continue a les mêmes besoins que le poste de développement.** L0-05 construit un APK en release à chaque commit : sans SDK Android sur l'agent, cette étape est impossible. À vérifier au moment d'écrire la chaîne, pas après.

**Note d'exploitation macOS** : trois blocages de bind mount Docker Desktop ont été observés pendant la nuit du 9 août (répertoire vu vide côté conteneur après recréation d'un autre service). `docker compose restart <service>` résout à chaque fois. Si le phénomène gêne, basculer le partage de fichiers de Docker Desktop sur VirtioFS. Ce n'est pas un défaut du dépôt — le réflexe est de redémarrer le conteneur avant de chercher plus loin.

---

## 4 ter. Données de démonstration et compte administrateur

**Données de démonstration Odoo : activées en développement, jamais ailleurs.** Elles rendent l'exploration du back-office plus commode. Deux conséquences à tenir :

- Les environnements de recette et de production s'installent avec `--without-demo=all`. Des partenaires et des factures fictifs dans une base de production sont ingérables.
- **Le scénario de bout en bout de L10-01 crée ses propres données** et ne s'appuie jamais sur celles d'Odoo. Un test qui dépend des données de démonstration échoue dès qu'on installe sans elles — c'est-à-dire en recette, au pire moment.
- `make seed` fournit un jeu de démonstration **maison** : chauffeurs, motos, zones, grille tarifaire. C'est celui-là qui sert aux démonstrations, pas celui d'Odoo.

**Compte administrateur.** Odoo crée `admin` / `admin` à la création de la base. C'est acceptable sur un poste de développement, jamais au-delà. Le mot de passe est généré aléatoirement au premier démarrage à partir d'une variable d'environnement, et la procédure de mise en production (L0-07) vérifie qu'il a été changé. Un back-office en `admin`/`admin` derrière une liste d'adresses autorisées reste un back-office en `admin`/`admin`.

---

## 5. Comptes externes : ce qu'il faut, et quand

Rien dans cette liste ne bloque le démarrage. Les délais indiqués justifient de lancer les démarches tôt, pas d'attendre.

| Compte | Nécessaire pour | Quand le lancer | Délai typique |
|---|---|---|---|
| Clé Google Maps (palier gratuit) | Écrans cartographiques réels — L6-06 | Avant L6-06 | Minutes |
| Projet Google Cloud, identifiants OAuth | Connexion Google sur appareil réel — L6-02 | Avant les tests sur appareil | Heures |
| Projet Firebase | Notifications sur appareil réel — L7-01 | Avant les tests sur appareil | Heures |
| Nom de domaine `babana.cm` et DNS | Mise en production — L0-07 | Dès maintenant | Heures à jours |
| VPS | Mise en production — L0-07 | Avant J5 | Heures |
| Compte Google Play Developer | **Publication sur le Store uniquement** — L10-07 | Avant la publication | Jours — validation d'identité |
| Vérification développeur Android | Installation directe sur appareil certifié, à terme | Avant fin 2026 | Jours — validation d'identité |
| Passerelle SMS | Vérification de numéro réelle — L1-09 | Avant J4 | Jours — contractualisation locale |
| Stockage de sauvegarde externe | L8-08 | Avec le VPS | Heures |
| **Validation du plan comptable par un comptable** | Écritures de remise réelles — L5-05 | Avant le pilote | Jours — disponibilité d'un tiers |

**Correction du 18 août — j'ai surestimé ce blocage pendant huit jours.** J'ai répété que le compte Google Play était le seul délai que rien ne rattraperait. C'est faux pour ce qui nous occupe : **le compte Play n'est nécessaire que pour publier sur le Store.** Tester un APK n'en demande aucun. On construit, on transfère le fichier sur le téléphone, on autorise l'installation depuis une source inconnue, et l'application tourne.

Et le pilote lui-même n'en a pas besoin non plus. Les chauffeurs sont salariés (D5) : l'entreprise installe l'application sur les téléphones qu'elle équipe. Une distribution directe, ou un service de distribution aux testeurs, suffit — avec l'avantage de maîtriser la cadence des mises à jour, ce que le Store ne permet pas.

**En revanche, un délai que je n'avais pas vu existe.** Google impose une **vérification du développeur pour installer une application sur un appareil Android certifié**, même hors du Store. Ouverte à tous depuis mars 2026, elle devient obligatoire le 30 septembre 2026 au Brésil, en Indonésie, à Singapour et en Thaïlande, puis mondialement à partir de 2027. Le Cameroun n'est pas dans la première vague : l'installation directe y reste possible sans vérification pendant le pilote. Mais le déploiement mondial la rattrapera, et cette vérification passe par une console distincte de celle du Play Store — ce n'est pas la même démarche, elle ne s'obtient pas « en même temps ».

Deux conséquences pratiques :

- **La vérification développeur est la démarche à lancer**, pas seulement le compte Play. Elle demande la même validation d'identité, avec les mêmes jours d'attente, et elle conditionne à terme l'installation directe elle-même.
- Un compte gratuit existe pour la distribution vers un nombre limité d'appareils, sans pièce d'identité officielle. À vérifier au moment venu : selon la taille de la flotte pilote, il peut suffire.

Reste que rien de tout cela ne bloque aujourd'hui. **Un APK est testable dès qu'un APK existe** — et il en existe un depuis le 13 août. Mieux : l'application Client s'exporte en web (D22), donc elle est testable dans un navigateur sans passer par Android du tout.

**Le plan comptable livré est provisoire, et c'est le seul prérequis qui produise de vraies conséquences légales.** La base de développement installe le plan générique d'Odoo, pas le SYSCOHADA en usage au Cameroun. Le module pose donc trois comptes et un journal qui lui sont propres, numérotés dans la famille classe 4 à titre indicatif — des valeurs par défaut plausibles au sens de D21, pas une prétention d'exactitude.

Les quatre références sont des paramètres : un comptable qui installe un vrai plan OHADA les repointe sans qu'une ligne de code change. Mais tant que personne ne l'a fait, **les écritures produites sont plausibles et fausses** — et c'est le genre d'erreur qui se découvre au premier audit, pas en test. À faire valider avant le pilote, au même titre que la grille tarifaire.

**L'empreinte de signature Android** mérite une mention : l'identifiant client OAuth Android est lié à l'empreinte du certificat de signature. Il en faut une pour le certificat de développement et une pour celui de publication. Oublier la seconde produit une connexion Google qui fonctionne en développement et échoue en production — un classique, et découvert tard.

---

## 6. Ce qui reste hors de portée d'un développement autonome

Sans rapport avec les comptes ou les valeurs : ces éléments demandent une présence humaine, à Douala pour la plupart.

**Les mesures de terrain.** L10-02 (trente trajets réels chronométrés, cinquante repères testés), L10-05 (arbitrage sur données réelles), L6-17 (consommation batterie sur terminaux réels). Aucune simulation ne les remplace.

**Les revues à forte conséquence.** L3-06 et L3-13 (réservation atomique), tout le lot L5 (logique financière), L8-01 et L8-02 (une matrice d'habilitations fausse produit des tests qui passent en validant les mauvaises règles).

**Les décisions d'entreprise.** Les valeurs tarifaires définitives, les seuils de réouverture de D10, D11 et É1 à écrire avant le pilote (L10-08), la politique de traitement des écarts de caisse.

Ce sont des points de synchronisation prévus, pas des blocages. Le développement peut atteindre J4 sans eux.
