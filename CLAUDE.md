# babana.cm — Protocole de travail

Application de moto-taxi à Douala. React Native, Odoo 18, service temps réel dédié.

**À placer à la racine `babana.cm/`.** Ce fichier est lu à chaque session : il dit comment travailler ici, pas quoi construire. Le quoi est dans `amoa/specs/`.

---

## Organisation du dépôt

```
babana.cm/
├── CLAUDE.md          ← ce fichier
├── amoa/              ← maîtrise d'ouvrage : décisions, spécifications. En lecture.
│   ├── 01-architecture.md … 05-prerequis-et-simulation.md
│   ├── specs/         ← une spécification par tâche
│   ├── questions/     ← écarts relevés pendant le développement
│   └── Cahier des charges.pdf
└── code/              ← tout le code produit. Le monorepo vit ici.
```

**Deux règles de localisation, sans exception.**

Tout code, toute configuration, tout test va dans `code/`. **Les chemins indiqués dans les spécifications sont relatifs à `code/`** : `services/odoo/addons/babana/` signifie `code/services/odoo/addons/babana/`. Idem pour `docs/` mentionné dans une spécification — il s'agit de `code/docs/`, la documentation technique produite par le développement.

`amoa/` ne se modifie pas depuis une session de développement, à deux exceptions près : déposer un écart dans `amoa/questions/`, et corriger une spécification lorsque je l'ai explicitement demandé. Une spécification réécrite en silence pour arranger le code annule tout l'intérêt du protocole d'écart.

Un seul dépôt git, à la racine `babana.cm/`. Les corrections de spécification voyagent ainsi avec le code qui les a révélées.

---

## Documents de référence

| Document | Contenu |
|---|---|
| `amoa/01-architecture.md` | Décisions D1 à D15, écarts É1 à É9, règle de partition |
| `amoa/02-comparatif-cartographie.md` | Pourquoi Google Maps, et la contrainte É8 |
| `amoa/03-decoupage-taches.md` | 112 tâches, dépendances, jalons, traçabilité |
| `amoa/04-monorepo-et-services.md` | D16 à D18, arborescence, compose, domaines, hébergement |
| `amoa/05-prerequis-et-simulation.md` | D19 à D22, services simulés, valeurs par défaut, export web |
| `amoa/specs/*.md` | Une spécification par tâche, avec critères d'acceptation |

**Une session peut être interrompue à tout moment** — limite atteinte, plantage, coupure. Travailler en conséquence : commiter chaque tâche finie plutôt que d'accumuler, écrire l'entrée de rapport avec elle, ne jamais laisser l'arbre de travail dans un état intermédiaire à la fin d'une tâche. Une session qui reprend doit trouver un dépôt cohérent et un compte rendu à jour.

**Le lot rétrécit à mesure que le code grandit.** Chaque tâche coûte plus de lecture que la précédente, parce qu'il y a davantage de code existant à comprendre avant d'y toucher. Un lot calibré sur un dépôt vide ne l'est plus trois nuits plus tard. Si le lot proposé paraît trop grand au vu de ce qu'il faut lire, le dire dans le rapport plutôt que de le tronquer en silence.

**Une tâche à la fois.** Lire sa spécification en entier avant d'écrire du code. Respecter l'ordre des dépendances du §5 de `amoa/03-decoupage-taches.md`.

**Une dépendance supposée absente se vérifie dans le dépôt, jamais dans le prompt.** Constaté le 15 août : L3-01 a été écrite en supposant que L1-02 n'avait pas encore émis de jetons applicatifs, et a posé une forme de jeton « hypothétique » — alors que L1-02 était faite depuis trois nuits et que le vrai jeton, lisible en dix lignes de `controllers/auth.py`, avait une forme différente. Résultat : deux implémentations vertes, en désaccord total, et un service temps réel qui aurait refusé toutes les connexions réelles. Avant d'écrire « X n'existe pas encore, je pose une hypothèse », ouvrir le fichier. Une hypothèse posée à côté d'une vérité déjà écrite est pire qu'une hypothèse posée dans le vide : elle a l'air raisonnable et personne ne la relit.

---

## Les cinq invariants

Ils priment sur toute considération de commodité. Une solution qui viole un invariant n'est pas une solution, même si elle fonctionne.

**1. Une écriture Odoo par événement métier, jamais par tick GPS.**
Le nombre d'écritures d'une course est **borné par le nombre de décisions humaines** qu'elle a comportées — jamais par sa durée ni par sa distance. Écrivent : demande, proposition, acceptation, refus, **démarrage**, annulation, fin de course, encaissement. N'écrivent jamais : position, ETA, distance en cours, compte à rebours. Le service temps réel ne possède aucune donnée durable et n'a aucune dépendance à un client PostgreSQL. Voir `amoa/01-architecture.md` §2 — ne pas compter les écritures, vérifier qu'elles ne dépendent ni du temps ni de la distance.

**2. Les transitions sont les seules portes d'écriture sur une course.**
Aucune écriture directe de `state`. Aucune modification après `settled`. Si un besoin semble exiger le contraire, c'est le besoin qui est mal formulé.

**3. Aucune règle métier dans les applications.**
Ni calcul de tarif, ni décision d'affectation, ni validation de solde. L'application affiche ce que le serveur décide. C'est ce qui permet de corriger une règle sans passer par les stores.

**4. La réservation d'un chauffeur est atomique.**
Un seul script Redis. Jamais de lecture suivie d'une écriture conditionnelle en TypeScript. Deux clients ne gagnent jamais le même chauffeur.

**5. Aucune valeur de configuration codée en dur.**
Délais, rayons, plafonds, tarifs, seuils. Tout est paramétrable — en base pour les valeurs métier, en variable d'environnement pour les adresses et secrets. Aucun secret dans le dépôt, jamais.

---

## Frontières, vérifiées par le lint

| Règle | Motif |
|---|---|
| `apps/*` n'importe aucun SDK de carte, seulement `@babana/maps` | Permet de changer de fournisseur (D13) |
| `services/realtime` n'a aucun client PostgreSQL en dépendance | Invariant 1, garanti mécaniquement |
| `services/realtime` ne dépend d'aucun paquet de `apps/` | Le service ne sait rien de l'interface |
| Les types de requête et de message ne sont jamais redéclarés | `@babana/contracts` est la source unique (D17) |
| La charge utile du jeton d'accès n'est déclarée qu'une fois | Même règle, étendue à un format de fil qui n'est ni une requête ni un message (D23) |
| `services/odoo` n'a aucun client Redis en dépendance | Miroir de la première ligne : un seul sens de dépendance entre les deux services (D27) |
| Aucun `GEOADD` sur la clé du pool hors du script d'éligibilité | Le pool n'a qu'un écrivain, sinon la réservation atomique ne garantit rien (D26) |
| Aucun appel sortant vers le service temps réel hors d'un point d'accroche au commit | Une transaction annulée ou rejouée aurait déjà modifié Redis (D32) |
| Aucun enregistrement au commit depuis l'intérieur d'un savepoint | L'accroche au commit ignore les savepoints, et on commite des transactions dont un savepoint a été annulé (D33) |

Une règle de lint qui échoue vaut mieux qu'une revue qui oublie. Si une frontière gêne, la signaler — ne pas la contourner.

Les chemins de ce tableau sont relatifs à `code/`.

---

## Commandes

Toutes depuis `code/` :

```bash
make up          # démarre toute l'infrastructure
make down        # arrête
make reset       # arrête et efface les données
make logs        # journaux agrégés
make seed        # jeu de données de démonstration
make client      # bundler de l'app Client
make driver      # bundler de l'app Chauffeur
make test        # suite complète
make lint
make verify      # vérifications de bout en bout de l'infrastructure
make secrets-scan # recherche de secrets dans les fichiers suivis
```

Tout fonctionne **sans aucun compte externe** : les dépendances tierces sont simulées par défaut (D19). Un scénario complet de course est parcourable dès le premier `make up`.

---

## Conventions

**Code en anglais, interface en français.** Noms de modèles, champs, fonctions, variables, commentaires : anglais. Textes affichés à l'utilisateur : français, via le mécanisme de traduction Odoo côté back-office.

**Nommage Odoo** : modèles en `babana.chose`, fichiers en `babana_chose.py`. Le point est le séparateur Odoo, pas un domaine.

**TypeScript strict**, sans exception ni suppression d'erreur. Si le typage résiste, c'est souvent le contrat qui est mal posé.

**Une branche par tâche**, nommée d'après son identifiant : `L3-06-atomic-reservation`. Message de commit préfixé de l'identifiant.

**Différences de plateforme dans les paquets partagés, jamais dans les écrans.** L'application Client est exportée en web (D22) ; ses différences vivent dans `@babana/maps` et `@babana/api-client`. Un `Platform.OS === 'web'` dans un écran annonce quinze écrans dans le même état six mois plus tard.

**Champs-pont : tracés, datés, condamnés.** L'ordre des tâches oblige parfois à créer un champ transitoire en attendant le modèle qui le portera vraiment — un compteur calculé qui renvoie zéro, un champ plat en attendant un `Many2one`. C'est légitime : un `Many2one` vers un modèle absent empêche l'installation du module. Deux règles alors, sans exception :

- Le champ porte dans son `help` la mention `[PONT — remplacé par <ID-TACHE>]`
- Il est inscrit dans `code/docs/bridge-fields.md`, avec la tâche qui doit le faire disparaître

La tâche cible commence par supprimer les champs-pont qui la nomment. Un champ-pont qui survit à sa tâche cible devient un champ permanent que personne n'ose retirer, et le modèle porte alors deux vérités pour la même donnée.

**Pas de dépendance nouvelle sans nécessité.** Chaque paquet ajouté est une surface à maintenir. Si une dépendance lourde semble nécessaire, le signaler avant de l'ajouter.

---

## Définition de fini

Une tâche est finie quand **tous** ces points sont vrais. Pas avant, quel que soit l'état apparent du code.

1. Tous les critères d'acceptation de la spécification sont satisfaits
2. Chaque critère est couvert par un test automatisé
3. `make test` passe en entier — pas seulement les tests de la tâche
4. `make lint` et `tsc --noEmit` passent
5. Aucune valeur de configuration n'a été codée en dur
6. Aucun secret n'a été introduit dans un fichier suivi
7. Les cinq invariants sont respectés
8. **L'entrée de rapport de la tâche est écrite et commitée avec elle**, pas à la fin de la session

Le point 8 a été ajouté le 15 août, après une session interrompue en cours de route — limite atteinte, plantage de l'éditeur, reprise dans une autre session. Le lot a été mené à bien, mais le compte rendu, rédigé en un seul geste final, n'a jamais existé.

**Le rapport n'est pas une documentation, c'est l'état de la session.** Une session qui reprend derrière une autre doit pouvoir savoir où la précédente s'est arrêtée, ce qu'elle a supposé, ce qu'elle a laissé rouge. Reconstituer cela depuis les messages de commit marche, mais mal. Écrit tâche par tâche, le rapport devient le document de passation — et il survit à une interruption, quelle qu'en soit la cause.

Le point 3 est celui qu'on est tenté de sauter. C'est aussi celui qui empêche les régressions.

---

## Tests et non-régression

### Ce que porte chaque tâche

Chaque tâche livre les tests qui couvrent ses propres critères d'acceptation. Une tâche dont les critères ne sont pas testés n'est pas finie — c'est le point 2 ci-dessus.

### Les quatre suites qui protègent l'ensemble

Elles existent en plus des tests de tâche et tournent à chaque commit.

**Tests générés depuis des données.** La machine à états (L4-10) et la matrice d'habilitations (L8-02) génèrent leurs tests depuis un fichier de données. Conséquence voulue : ajouter une transition ou un modèle sans l'ajouter au fichier fait échouer la suite. C'est un filet contre l'oubli, pas seulement contre l'erreur.

**Scénarios de bout en bout** (L10-01) : la boucle complète, plus les variantes — refus puis nouvelle sélection, annulation, plafond d'encaisse, remise de caisse, notifications désactivées. Contre l'environnement réel, en simulé, donc exécutable en intégration continue sans secret.

**Test de concurrence** (L3-13) : N réservations simultanées sur le même chauffeur, contre un Redis réel, répété. Ce test doit échouer si l'on remplace la réservation atomique par une implémentation naïve — à vérifier une fois, sinon il ne prouve rien.

**Test de résilience** (L3-14) : tuer le service temps réel en pleine course, redémarrer, la course doit se retrouver et se terminer. C'est la vérification de l'invariant 1.

### Politique de non-régression

**Tout défaut corrigé donne d'abord un test qui échoue.** Écrire le test, le voir échouer, corriger, le voir passer. Un correctif sans test rouvrira le même défaut plus tard, et personne ne s'en souviendra.

**Ne jamais désactiver ni ignorer un test qui échoue.** Un test rouge signale soit un défaut, soit une spécification fausse. Les deux se traitent — aucun ne se contourne. Si un test semble obsolète, appliquer le protocole d'écart ci-dessous plutôt que de le supprimer.

**Ne jamais adapter un test au code.** Si le code produit 1 250 FCFA et le test en attend 1 200, la question est laquelle des deux valeurs est juste — pas comment faire passer le test. Modifier l'attendu pour faire passer un test est la façon la plus efficace de rendre une suite inutile.

**Les modules sensibles ont une couverture élevée et exhaustive** : moteur de cotation, machine à états, mouvements de compte courant, réservation atomique. Pour ceux-là, viser la couverture de tous les chemins, pas un pourcentage.

**La base de développement est jetable, et doit être jetée régulièrement.** Une base accumulée depuis plusieurs sessions masque tout ce qui ne se produit que sur une installation fraîche — un drapeau `noupdate` figé dans `ir.model.data`, un index créé sous une ancienne définition, une donnée initiale qui ne se recharge jamais. Constaté le 12 août : cent vingt-sept tests verts sur une base ancienne, un vrai défaut découvert au premier `make reset`. Avant de déclarer une tâche finie, exécuter la suite au moins une fois sur une base fraîche.

**Les pièges de plateforme se documentent.** Quand Odoo se comporte autrement que le bon sens le suggère, l'écrire dans `code/docs/odoo-pitfalls.md` plutôt que dans un message de commit. Trois cas déjà rencontrés : les routes `auth='none'` sont en lecture seule par défaut depuis Odoo 18, `env.user` vide sous `uid=None` casse des hooks internes, et un `write()` n'est pas toujours poussé en base avant qu'un `create()` suivant ne heurte une contrainte SQL dans la même transaction — `flush_recordset()` explicite. **Règle générale à en tirer** : tout code qui s'appuie sur une contrainte au niveau base doit provoquer le vidage avant de la déclencher.

**L'intégration continue est bloquante.** Aucune fusion avec une suite rouge. Un test instable est traité comme un défaut, pas toléré comme un inconvénient — un test qui échoue une fois sur dix finit par être ignoré, et il emporte la confiance dans toute la suite.

---

## Protocole d'écart

**Le point le plus important de ce document.**

Une spécification peut être fausse, incomplète, ou en contradiction avec une autre. Cela arrivera. La bonne réaction n'est pas de choisir silencieusement une interprétation.

**Signaler, ne pas contourner.** Quand une spécification semble exiger la violation d'un invariant, ou qu'elle contredit une décision d'architecture, ou qu'elle est ambiguë sur un point qui change le résultat : s'arrêter et le dire. Une question posée coûte quelques minutes ; une architecture contournée en silence coûte des semaines et se découvre en production.

**Ce qui justifie un arrêt :**

- Une tâche semble impossible sans violer un des cinq invariants
- Deux spécifications se contredisent
- Un critère d'acceptation est invérifiable tel qu'il est écrit
- Une décision d'architecture semble erronée au vu de ce que le code révèle
- Une dépendance externe se comporte autrement que la spécification le suppose

**Ce qui ne justifie pas un arrêt :** un choix d'implémentation non spécifié. Nommage interne, structure de fichiers, bibliothèque utilitaire, forme d'un test. Décider, avancer, et le mentionner dans le message de commit.

**Comment signaler.** Décrire l'écart, ce que la spécification demande, pourquoi cela pose problème, et une ou deux options avec leurs conséquences. Ne pas se contenter de « cette spécification est ambiguë » — proposer.

Les écarts relevés sont déposés dans `amoa/questions/<ID-TACHE>.md`, **et commités sur `master`, jamais uniquement sur la branche de la tâche**. Une tâche qui n'est pas fusionnée laisserait sinon son fichier d'écart invisible — c'est précisément quand une tâche demande une revue que sa question doit être lisible. Constaté le 11 août : le fichier d'écart de L4-02 est resté sur sa branche non fusionnée.

Une fois arbitrés, ils sont consignés dans `amoa/01-architecture.md` comme décisions ou écarts numérotés. Une décision non écrite sera reprise différemment dans trois mois.

---

## Ce qui demande une validation humaine

Ne pas fusionner sans revue :

- **L3-06 et L3-13** — réservation atomique : un défaut ici est intermittent et invisible en test unitaire
- **Tout le lot L5** — logique financière : compte courant, plafond, remises, écarts
- **L8-01 et L8-02** — habilitations : une matrice fausse produit des tests verts qui valident les mauvaises règles
- **L4-02** — machine à états : elle porte l'invariant 2
- **Toute modification d'une décision D1 à D22**

---

## Contexte à ne pas perdre de vue

Trois réalités du terrain expliquent une bonne part des choix, et rendent inutiles des solutions qui sembleraient naturelles ailleurs.

**Le réseau mobile est intermittent.** Ce n'est pas un cas limite, c'est le cas courant. Toute fonction doit se comporter correctement hors connexion : file locale, rejeu idempotent, état affiché sans ambiguïté.

**Les terminaux sont d'entrée de gamme.** Batterie limitée, mémoire limitée, forfait de données compté. Un chauffeur dont la batterie tient trois heures désinstalle l'application, et la flotte se vide sans que personne comprenne pourquoi.

**L'adresse formelle n'existe quasiment pas à Douala.** La navigation se fait par repères. Un écran qui suppose une saisie d'adresse échoue ; la désignation d'un point sur la carte doit être le chemin le plus court.

Et une contrainte technique qui surprend : **ni Google ni Mapbox ne calculent d'itinéraire deux-roues au Cameroun** (É8). Toutes les distances et durées sont calculées sur un modèle voiture. C'est pour cela que le tarif n'a pas de composante temporelle (D15) et que l'ETA affiché passe par un facteur de correction (L10-03). Ce n'est pas un oubli à corriger.
