# L0 — Socle technique

Référence complète du monorepo et des services : `amoa/04-monorepo-et-services.md`.

---

## L0-01 — Infrastructure Docker

### Objectif

`git clone` puis `make up` produit une pile saine sur une machine vierge, sans configuration manuelle : six services de base, plus trois services simulés en développement.

### Fichiers

```
infra/compose.yaml
infra/compose.dev.yaml
infra/caddy/Caddyfile
infra/caddy/wellknown/assetlinks.json
infra/env/.env.example
infra/minio/bootstrap.sh
services/odoo/Dockerfile
services/odoo/config/odoo.conf
Makefile
```

### Spécification

Implémenter les fichiers `compose.yaml`, `compose.dev.yaml`, `Caddyfile` et `Makefile` tels que décrits dans `amoa/04-monorepo-et-services.md` §4 à §7.

**Note de séquencement** : `compose.yaml` référence `services/realtime/Dockerfile` et, via `compose.dev.yaml`, `services/mocks/*/Dockerfile` — produits par L0-04 et L0-08. Créer pour cette tâche des squelettes minimaux clairement marqués (un `/health` qui répond, rien d'autre), que L0-04 et L0-08 remplaceront entièrement. Sans eux, le critère 1 est invérifiable.

Les trois hôtes — apex, `api.` et `admin.` — sont servis dès le développement sur `localhost`, avec les mêmes chemins qu'en production. Une application qui fonctionne sur `localhost` mais casse sur `babana.cm` parce que les hôtes diffèrent est le défaut que cette structure évite.

`services/odoo/Dockerfile` part de `odoo:18` et ajoute les dépendances Python du module : bibliothèque de vérification de jeton Google, client S3, client HTTP.

`infra/minio/bootstrap.sh` crée le compartiment `babana-documents` au premier démarrage, en accès privé. Aucun objet ne doit être lisible sans URL signée.

`infra/env/.env.example` liste **toutes** les variables avec des valeurs de développement fonctionnelles, sauf les secrets réels qui portent une valeur manifestement factice.

### Critères d'acceptation

1. Sur une machine sans image préexistante, `make up` termine sans erreur : six services de base sains, plus trois services simulés en développement.
2. `curl -k https://api.localhost/web/health` répond ; `curl -k https://api.localhost/rt/health` répond ; `https://admin.localhost` sert le back-office.
3. `make reset && make up` reconstruit un environnement complet et vierge.
4. Aucune valeur secrète n'est présente dans un fichier suivi par git. Vérifié par une recherche automatisée.
5. Un objet déposé dans MinIO n'est **pas** accessible sans URL signée. Vérifié par un appel direct qui doit échouer.
6. Les trois hôtes répondent en développement, avec la même structure de chemins qu'en production.
7. `admin.` renvoie 403 quand l'adresse appelante est hors de la liste autorisée.

### Piège

`depends_on` avec `condition: service_healthy` est indispensable : sans lui, Odoo démarre avant PostgreSQL et échoue au premier lancement, ce qui donne l'impression que la configuration est cassée alors qu'il suffit de réessayer. Un premier démarrage qui échoue est un mauvais accueil pour un projet.

---

## L0-02 — Squelette du module Odoo `babana`

### Objectif

Un module qui s'installe, se désinstalle et se réinstalle proprement, avec ses groupes de sécurité.

### Fichiers

```
services/odoo/addons/babana/
├── __init__.py
├── __manifest__.py
├── models/__init__.py
├── controllers/__init__.py
├── security/
│   ├── babana_groups.xml
│   └── ir.model.access.csv
├── views/
├── data/
└── tests/__init__.py
```

### Spécification

Manifeste : nom, version `18.0.1.0.0`, dépendances `base`, `mail`, `hr`, `account`. Licence `LGPL-3`, alignée sur Odoo Community. Auteur.

**Données de démonstration** : activées en développement, jamais en recette ni en production (`--without-demo=all`). Le `Makefile` doit rendre ce choix explicite par environnement, pas dépendre d'un défaut Odoo. Voir `amoa/05-prerequis-et-simulation.md` §4 ter.

**Mot de passe administrateur** : jamais `admin`/`admin` au-delà du poste de développement. Généré depuis une variable d'environnement au premier démarrage.

Groupes de sécurité à créer, dans une catégorie `Babana` :

| Groupe | Rôle |
|---|---|
| `group_babana_supervisor` | Valide les remises de caisse, consulte les courses |
| `group_babana_manager` | Valide les chauffeurs, gère la flotte et les tarifs |
| `group_babana_admin` | Configuration complète, hérite de `manager` |

Les utilisateurs mobiles (clients et chauffeurs) n'appartiennent à **aucun** de ces groupes. Leurs droits passeront exclusivement par des règles d'enregistrement (L8-01).

### Critères d'acceptation

1. `odoo -d babana -i babana --stop-after-init` termine sans erreur ni avertissement.
2. Désinstallation puis réinstallation sans erreur.
3. Les trois groupes apparaissent dans l'interface, dans une catégorie dédiée.
4. `--test-enable` s'exécute et trouve la suite de tests, même vide.
5. Une installation avec `--without-demo=all` réussit et ne crée aucun partenaire fictif.
6. Le mot de passe administrateur vient d'une variable d'environnement, il n'est pas laissé au défaut Odoo.

---

## L0-03 — Monorepo React Native

### Objectif

Deux applications qui démarrent, consommant un paquet partagé, avec un build Android fonctionnel.

### Contexte

**C'est la tâche la plus sous-estimée du projet.** Un monorepo React Native mal posé se paie pendant toute la durée du développement, en résolution de modules, en duplication de dépendances natives et en builds qui marchent sur une machine et pas sur une autre.

**Prérequis d'outillage, à vérifier avant de commencer** : Node ≥ 22.11.0 (exigé par React Native 0.86), SDK Android en ligne de commande, Java. Détail dans `amoa/05-prerequis-et-simulation.md` §4 bis. Le critère 4 est invérifiable sans SDK Android — si l'outillage manque, le signaler immédiatement plutôt que de livrer une tâche partielle en fin de session.

### Fichiers

```
package.json                    # workspaces: apps/*, packages/*, services/realtime
apps/client/                    # @babana/client
apps/driver/                    # @babana/driver
packages/contracts/             # @babana/contracts
packages/api-client/            # @babana/api-client
packages/ui/                    # @babana/ui
packages/maps/                  # @babana/maps
tsconfig.base.json
.eslintrc.cjs
```

### Spécification

Espaces de travail npm. React Native avec la nouvelle architecture activée. TypeScript en mode strict, sans exception.

**Contrainte D22** : `packages/ui` n'emploie que des composants compatibles React Native Web, parce que l'application Client sera exportée en web (L6-18). C'est un choix de composants, pas un travail supplémentaire — à condition d'être décidé maintenant. Rétrofité après quinze écrans, c'est une reprise.

Les quatre paquets partagés sont créés avec un export minimal fonctionnel dès cette tâche, même si leur contenu est vide. Ils doivent être **importables par les deux apps immédiatement** : un paquet partagé créé plus tard n'est jamais adopté, le code aura déjà été dupliqué.

Configurer la résolution de modules pour le bundler Metro afin qu'elle suive les liens des espaces de travail. C'est le point qui casse le plus souvent.

Règles de lint implémentant les frontières de `amoa/04-monorepo-et-services.md` §8 :

- `apps/*` ne peut importer aucun SDK de carte directement — seulement `@babana/maps`
- `services/realtime` ne peut importer aucun paquet de `apps/`

### Critères d'acceptation

1. `npm install` à la racine installe tout l'arbre.
2. `npm run start -w @babana/client` et `-w @babana/driver` démarrent chacun leur bundler.
3. Un symbole exporté par `@babana/ui` s'importe et s'affiche dans les deux apps.
4. Le build Android en mode release produit un APK pour chaque app. **Prérequis** : SDK Android présent et `ANDROID_HOME` défini.
5. Une tentative d'import direct d'un SDK de carte dans `apps/client` fait échouer le lint.
6. `tsc --noEmit` passe sur tout l'arbre.
7. Aucune adresse de serveur n'est codée en dur : les apps lisent l'hôte depuis leur configuration de build, avec `api.babana.cm` en production.

---

## L0-04 — Squelette du service temps réel

### Objectif

Un serveur qui expose un point de santé et accepte une connexion WebSocket authentifiée.

### Contexte

D16 : TypeScript sur Node. Dépend de C-02 pour les types de messages.

### Fichiers

```
services/realtime/
├── package.json                # @babana/realtime
├── Dockerfile
├── src/
│   ├── index.ts
│   ├── server.ts
│   ├── ws/connection.ts
│   ├── redis/client.ts
│   ├── odoo/client.ts
│   └── config.ts
└── test/
```

### Spécification

Serveur HTTP avec un endpoint `/health` renvoyant l'état des dépendances : Redis joignable, Odoo joignable.

Serveur WebSocket sur `/rt/ws`. L'authentification se fait à l'établissement de la connexion, par le jeton applicatif. Une connexion non authentifiée est fermée immédiatement, avec un code de fermeture explicite.

Toute la configuration vient de variables d'environnement, validées au démarrage par un schéma. **Le service refuse de démarrer si une variable requise manque** — un démarrage silencieux avec une configuration incomplète produit des pannes incompréhensibles plus tard.

Client Odoo sortant, authentifié par le secret partagé `REALTIME_SHARED_SECRET`, avec temporisation et réessais.

**Aucune dépendance à un client PostgreSQL.** L'absence de ce paquet dans `package.json` est la garantie mécanique de la règle de partition.

### Critères d'acceptation

1. `/health` renvoie 200 quand Redis et Odoo répondent, 503 sinon, avec le détail par dépendance.
2. Une connexion WebSocket sans jeton valide est refusée avec un code de fermeture documenté.
3. Le service refuse de démarrer si une variable d'environnement requise manque, avec un message qui nomme la variable.
4. `package.json` ne contient aucun client PostgreSQL. Vérifié par un test.

---

## L0-05 — Intégration continue

### Objectif

Chaque commit déclenche lint, tests et build.

### Fichiers

`.github/workflows/ci.yml` — ou l'équivalent selon la forge retenue.

### Spécification

Étapes, dans cet ordre, échec bloquant à chaque étape :

1. Lint sur tous les espaces de travail
2. `tsc --noEmit` sur tout l'arbre
3. Tests unitaires des paquets et du service temps réel
4. Tests Odoo dans un conteneur, base éphémère
5. Build Android en release des deux apps
6. Recherche de secrets dans le diff

Mise en cache des dépendances npm et des couches Docker.

### Critères d'acceptation

1. Un commit qui casse le lint fait échouer la chaîne.
2. Un test Odoo en échec fait échouer la chaîne.
3. Un secret introduit dans un fichier suivi fait échouer la chaîne.
4. La chaîne complète tient sous quinze minutes.

---

## L0-06 — Environnements et secrets

### Objectif

Trois environnements — développement, recette, production — avec des secrets injectés à l'exécution.

### Fichiers

```
infra/env/.env.example
infra/env/README.md
```

### Spécification

Documenter **chaque** variable : rôle, format, valeur de développement acceptable, origine de la valeur de production.

Variables au minimum : `BABANA_DOMAIN`, `ACME_EMAIL`, `ADMIN_ALLOWED_IPS`, accès PostgreSQL, adresse Redis, identifiants clients Google OAuth (Android client, iOS client, backend), secret de signature des jetons applicatifs, secret partagé entre Odoo et le service temps réel, accès S3, SMTP, identifiants FCM, identifiants de la passerelle SMS, clé Google Maps.

`BABANA_DOMAIN` vaut `localhost` en développement, `staging.babana.cm` en recette, `babana.cm` en production. Aucune adresse ne doit apparaître en dur ailleurs, ni dans le code des apps, ni dans le service temps réel.

En production, les secrets viennent d'un gestionnaire de secrets ou de variables d'environnement de la plateforme d'hébergement, jamais d'un fichier déposé sur le serveur.

**Rotation** : documenter la procédure pour chaque secret. Un secret dont personne ne sait comment le remplacer ne sera jamais remplacé, y compris après une fuite.

**Aucune valeur par défaut ne pointe vers un service simulé** (application de D43, constatée le 6 septembre). `SMTP_HOST=mailpit` figurait dans le fichier d'exemple, que la commande de démarrage recopie quand aucune configuration n'existe. Une mise en production qui suit le chemin documenté enverrait donc ses factures à un simulateur — qui les **accepte** et les garde, sans erreur, sans trace côté client.

C'est le symétrique exact de D43 : là une configuration absente retombait sur le vrai fournisseur, ici elle retombe sur le simulateur. Le défaut est le même — une valeur par défaut qui produit un comportement faux au lieu d'un échec bruyant — et il est pire dans ce sens-là, parce qu'un simulateur répond « envoyé ».

Les réglages qui désignent un fournisseur réel n'ont donc **pas de valeur par défaut** : vides dans le fichier d'exemple, renseignés explicitement par la configuration de développement pour les simulateurs. Non configuré, on échoue à l'envoi, bruyamment.

**Le jeu de données de démonstration n'est complet que s'il se montre.** Une position de chauffeur ne vit que dans Redis, et le pool n'a qu'un seul écrivain (D26) : aucun script de données ne peut poser un chauffeur sur la carte sans violer cette frontière. Cette tâche livre donc aussi **l'outil qui met en ligne les chauffeurs du jeu de données par le vrai chemin** — authentification, connexion, déclaration de disponibilité, émission de positions — et les fait se déplacer dans Douala.

Ce n'est pas un utilitaire de circonstance : les nuits de vérification le réécrivent à la main depuis un mois, et chaque répétition avant le pilote en aura besoin.

### Critères d'acceptation

1. `.env.example` est complet : un nouveau développeur le copie et `make up` fonctionne.
2. Chaque variable est documentée.
3. La procédure de rotation est écrite pour chaque secret.
4. Aucune valeur secrète réelle n'est présente dans le dépôt.

---

## L0-07 — Mise en production de l'hôte

### Objectif

Un serveur de production durci, déployé, sauvegardé et supervisé.

### Contexte

D18 : VPS unique en Europe pour le pilote. Dimensionnement et justification dans `amoa/04-monorepo-et-services.md` §9.

**Cette tâche n'est pas de la configuration système ordinaire.** Trois de ses étapes conditionnent la survie des données du pilote : la restauration prouvée, la supervision hors hôte, et la valeur de latence de référence.

### Fichiers

```
infra/production/
├── bootstrap.sh              # durcissement de l'hôte
├── deploy.sh
├── rollback.sh
└── monitoring/
docs/operations/production.md
docs/operations/latency-baseline.md
```

### Spécification

Suivre la procédure en dix étapes de `amoa/04-monorepo-et-services.md` §9, dans l'ordre.

Points qui demandent une attention particulière :

**Le port 80 reste ouvert au pare-feu.** Caddy en a besoin pour renouveler les certificats. Le fermer produit une expiration silencieuse environ trois mois après la mise en service, au moment où plus personne n'y pense.

**Le DNS précède le déploiement.** Caddy échoue à obtenir un certificat pour un nom non encore résolu, et l'échec se présente comme un problème de configuration alors que c'est une question de propagation.

**La supervision est hébergée ailleurs.** Une sonde qui tourne sur la machine qu'elle surveille est muette exactement quand elle serait utile. Métriques minimales : disponibilité des trois hôtes, expiration des certificats, occupation disque, **vol de CPU**, taille de la file d'attente vers Odoo (L3-12), réussite de la dernière sauvegarde.

Le vol de CPU est spécifique au choix D18 : sur un hôte partagé, une dégradation due au voisinage est indiscernable d'une régression applicative si personne ne mesure cette métrique.

**La latence de référence depuis Douala** est mesurée et consignée à la mise en service, vers l'API et vers le WebSocket. Sans valeur de référence, une dégradation ultérieure est invérifiable et se discutera à l'impression.

**Seuil de bascule d'hébergeur** défini avant la mise en service : au-delà de quel percentile 95 de temps de réponse d'API faut-il migrer. Défini après avoir vu les chiffres, ce seuil justifierait simplement la décision déjà prise.

### Critères d'acceptation

1. L'accès SSH est par clé uniquement, mot de passe désactivé, port restreint.
2. Le pare-feu n'ouvre que 80, 443 et le port SSH ; le 80 est bien ouvert.
3. Les trois hôtes servent un certificat valide.
4. `admin.babana.cm` refuse une adresse hors liste.
5. Les sauvegardes vont vers un stockage **hors de cet hôte**, et **une restauration complète a réussi sur un hôte vierge** — compte rendu daté dans le dépôt.
6. La supervision est hébergée ailleurs et alerte effectivement, vérifié en provoquant volontairement une panne.
7. Le vol de CPU est mesuré et alerté.
8. La latence de référence depuis Douala est mesurée et consignée.
9. Le seuil de bascule d'hébergeur est écrit et daté avant la mise en service.
10. La procédure de retour arrière est documentée, avec la liste des détenteurs d'accès.

### Piège

Le point 5 est le seul qui compte vraiment le jour d'un incident, et c'est celui qu'on est le plus tenté de reporter parce que « les sauvegardes tournent ». Une sauvegarde jamais restaurée n'est pas une sauvegarde. Tant que l'exercice n'a pas eu lieu, considérer que le projet n'a pas de sauvegarde.

---

## L0-08 — Services simulés

### Objectif

Cloner le dépôt, `make up`, parcourir un scénario complet de course — **sans aucun compte externe**.

### Contexte

D19. Principe directeur : **on simule le fournisseur, jamais notre logique.** Le contrôleur d'authentification vérifie une vraie signature contre un vrai jeu de clés ; c'est l'émetteur des clés qui est local. Le code de production n'a aucune branche conditionnelle — il lit une adresse dans une variable d'environnement.

Un mock qui court-circuite la logique ne prouve rien. Un mock qui remplace l'interlocuteur prouve presque tout.

### Fichiers

```
services/mocks/
├── google-identity/          # jeu de clés JWKS + émission de jetons
│   ├── src/
│   └── Dockerfile
├── maps/                     # doublures de routage et recherche de lieu
│   ├── fixtures/douala.json
│   └── src/
└── README.md
infra/compose.dev.yaml        # ajout des services simulés
```

### Spécification

**`mock-google-identity`**, service HTTP exposant :

- `GET /.well-known/jwks.json` — jeu de clés publiques, paire générée au démarrage
- `POST /token` — émet un jeton d'identité signé, avec `sub`, `email`, `email_verified`, `aud`, `iss`, `exp` fournis par l'appelant

Odoo lit l'adresse dans `GOOGLE_JWKS_URL` : `mock-google-identity` en développement, Google en production. **Le code de vérification est identique dans les deux cas** — aucune branche `if development`.

Ce service doit permettre de produire des jetons **volontairement invalides**, chacun d'une façon distincte : mauvais `aud`, `exp` dépassé, `email_verified` faux, signature d'une autre clé, `iss` inattendu. Les tests négatifs de L1-01 en dépendent entièrement — contre le vrai Google, ils seraient impossibles à écrire.

**`mock-maps`**, service HTTP renvoyant des réponses enregistrées :

- Itinéraire entre deux points : distance, durée, tracé
- Recherche de lieu : jeu de repères de Douala

Les doublures sont dans `fixtures/douala.json`, avec des coordonnées et des distances **plausibles pour Douala** — pas des valeurs arbitraires. Un couple de points inconnu renvoie une réponse déterministe dérivée de la distance à vol d'oiseau, pour que les tests ne dépendent pas d'une liste exhaustive.

Le service doit pouvoir **simuler une panne** sur demande, afin de tester le comportement de L2-05 en cas d'indisponibilité de l'API.

**SMS et notifications** : implémentations de développement, spécifiées en L1-09 et L7-01. Elles journalisent au lieu d'envoyer, et exposent un endpoint d'inspection permettant à un test de récupérer le dernier code OTP ou la dernière notification émise.

Tous ces services sont dans `compose.dev.yaml` uniquement. Ils ne doivent **jamais** pouvoir démarrer en production : un contrôle au démarrage vérifie que `NODE_ENV` n'est pas `production`, et le service refuse de se lancer sinon.

### Critères d'acceptation

1. Sur une machine sans aucun compte externe, `make up` puis le scénario de L10-01 se déroulent entièrement.
2. Le code de vérification de jeton est identique en développement et en production — aucune branche conditionnelle, vérifié par revue et par recherche.
3. Le service d'identité produit les cinq types de jetons invalides listés.
4. Le service de cartographie simule une panne sur demande.
5. Les endpoints d'inspection permettent à un test de récupérer le dernier OTP et la dernière notification.
6. Les services simulés refusent de démarrer en production.
7. Les doublures de Douala portent des coordonnées et distances plausibles.

### Piège

La tentation sera d'ajouter un `if settings.dev: return True` dans la vérification de jeton — c'est plus rapide et ça marche. Ça détruit aussi toute la valeur de la tâche : la logique réellement exécutée en production ne serait jamais testée, et une faille d'authentification passerait inaperçue jusqu'à la mise en service.

---

## L0-09 — Harnais de non-régression

### Objectif

Rendre la suite de tests exécutable, rapide et digne de confiance.

### Contexte

Une suite de tests n'a de valeur que si elle est verte en permanence et qu'on la croit. Un test instable toléré emporte la confiance dans toute la suite : au bout de quelques semaines, plus personne ne lit les échecs.

### Fichiers

```
Makefile                          # cible test complète
.github/workflows/ci.yml
docs/testing/strategy.md
tools/flaky-detector/
```

### Spécification

**`make test` exécute tout** : tests unitaires des paquets, tests du service temps réel, tests Odoo sur base éphémère, scénarios de bout en bout, tests de concurrence. En une commande, sans étape manuelle, sans secret.

**Découpage par vitesse.** Une cible rapide — unitaires et lint — exécutable en quelques secondes pendant le développement. La cible complète, plus lente, exécutée avant chaque fusion. Une suite complète trop lente finit par n'être lancée que par l'intégration continue, donc trop tard.

**Installation fraîche obligatoire.** La suite Odoo s'exécute sur une base créée pour l'occasion, jamais sur une base accumulée. Une base ancienne masque les défauts qui ne se produisent qu'à la première installation — et donc exactement ceux qui se produiront en recette et en production.

**Détection des tests instables** : réexécution périodique de la suite complète plusieurs fois d'affilée sur la même base de code. Tout test qui n'a pas un résultat constant est signalé et traité comme un défaut, pas toléré comme un inconvénient.

**Seuils de couverture sur les modules sensibles uniquement** : moteur de cotation, machine à états, mouvements de compte courant, réservation atomique. Pour ceux-là, viser la couverture de tous les chemins. Ailleurs, aucun seuil chiffré — un pourcentage global pousse à écrire des tests sans valeur pour atteindre un chiffre.

**Blocage de fusion sur suite rouge**, sans exception ni contournement.

**Documenter la stratégie** dans `docs/testing/strategy.md` : quelles suites existent, ce que chacune protège, comment ajouter un test, et la politique de non-régression du `CLAUDE.md` — tout défaut corrigé donne d'abord un test qui échoue.

### Critères d'acceptation

1. `make test` exécute toutes les suites en une commande, sans secret externe.
2. La cible rapide s'exécute en quelques secondes.
3. La suite complète tient dans une durée compatible avec un usage avant chaque fusion.
4. Le détecteur de tests instables fonctionne et signale un test volontairement rendu instable.
5. Les seuils de couverture s'appliquent aux quatre modules sensibles et échouent si la couverture baisse.
6. La fusion est bloquée sur suite rouge.
6 bis. La suite Odoo s'exécute sur une base créée pour l'occasion, jamais réutilisée.
7. `docs/testing/strategy.md` existe et décrit la politique de non-régression.

---

## L0-10 — Cohérence de la chaîne de configuration

**Créée le 13 septembre 2026** (D59, `amoa/01-architecture.md` §9 sexies), après le troisième défaut de la même famille : une variable documentée, gardée par un contrôle, et jamais délivrée au code qui la lit.

### Objectif

Rendre mécanique ce qu'aucune relecture n'a attrapé trois fois de suite : le lien entre les trois moments d'une variable de configuration.

### Fichiers

```
code/tools/config-coherence/
code/infra/production/deploy.sh
code/docs/operations/configuration.md
```

### Spécification

**Une variable a trois moments, et le test parcourt les trois.**

1. **Déclarée** — présente dans `infra/env/README.md` et dans `infra/env/.env.example` (vide quand D43 l'exige, jamais absente).
2. **Livrée** — transmise à ce qui la consommera : `infra/compose.yaml` pour un conteneur, l'environnement exporté du processus de build pour une variable lue à la compilation, un `_post_init_hook` pour ce qu'Odoo doit traduire en enregistrement.
3. **Consommée** — lue quelque part dans `services/`, `apps/`, `packages/` ou `infra/`.

**Le test échoue dès qu'un maillon manque**, dans les deux sens : une variable consommée mais non déclarée, une variable déclarée mais livrée à personne, une variable livrée mais que rien ne lit. Les exceptions légitimes — `SMS_GATEWAY_*` en attente de L1-09 — sont **listées explicitement avec la tâche qui les fermera**, jamais ignorées par défaut. Une exception silencieuse rouvrirait précisément le trou.

*Corrigé le 14 septembre* (`amoa/questions/L0-10.md`) : cette phrase citait aussi « `FCM_*` sans fournisseur ». C'était faux — les trois variables Firebase sont déclarées, livrées et consommées par `services/push.py` depuis L7-01. Je l'avais généralisé depuis `SMS_GATEWAY_*` sans revérifier. Ce qui manque à FCM n'est pas de la configuration mais une exécution contre un vrai compte, et ce n'est pas ce que ce protocole mesure.

**Un repli n'excuse pas l'absence de déclaration quand il porte une adresse de production** (D61). Une variable dont le repli est `undefined` ou `''` est un défaut évident ; une variable dont le repli est `https://api.babana.cm` est un défaut discret, et pire : un binaire de recette construit sans elle écrirait de vraies courses dans la base du pilote. Les adresses de serveur n'entrent jamais dans la liste des replis suffisants — elles échouent quand elles manquent.

**La réparation qui a motivé la tâche** : `deploy.sh` fait `. infra/env/.env`, ce qui pose des variables de shell sans les exporter, puis lance `npm run build:web`. Le bundle de production est donc construit sans aucune des variables lues à la compilation — `BABANA_MAPS_SEARCH_URL`, `BABANA_GOOGLE_WEB_CLIENT_ID`, `BABANA_GOOGLE_MAPS_API_KEY`. Le script avertit même que la première pointe vers un simulateur, puis ne la transmet pas. Les variables de build sont exportées, et le contrôle porte sur ce qui est **réellement embarqué dans le bundle produit**, pas sur ce que le fichier contenait.

**Un bundle qui manque une variable de build ne se construit pas.** Pas d'avertissement, pas de repli sur `undefined` : `deploy.sh` s'arrête. C'est D43 appliquée à la chaîne de build — un déploiement à moitié configuré doit échouer bruyamment, jamais servir une page où l'on ne peut ni se connecter ni chercher un lieu.

**Documenter la chaîne** dans `docs/operations/configuration.md` : les trois moments, où chacun se vérifie, et la liste des exceptions avec leur tâche de fermeture.

**Et corriger une affirmation fausse au passage** : `infra/env/README.md` écrit que le fichier `.env` « n'a pas d'équivalent en production » et que la procédure de déploiement injecte les variables directement dans l'environnement du conteneur. L0-07 a tranché autrement — `deploy.sh` lit bien `infra/env/.env` sur le serveur. Le choix est défendable pour un VPS unique ; la phrase, elle, enverra quelqu'un chercher un gestionnaire de secrets qui n'existe pas. Même famille que le reste de cette tâche : un document qui décrit un mécanisme absent.

### Critères d'acceptation

1. Le test recense les variables aux trois moments et échoue si l'un manque, dans les deux sens.
2. Une variable ajoutée au code sans être déclarée fait échouer la suite — prouvé en en ajoutant une.
3. Une variable déclarée que rien ne livre fait échouer la suite — prouvé de même.
4. Les exceptions sont une liste explicite, chacune nommant la tâche qui la fermera ; une exception sans tâche fait échouer la suite.
5. `deploy.sh` exporte les variables de build, et **échoue** si l'une d'elles est absente ou pointe vers un simulateur — il n'avertit plus.
6. Le contrôle porte sur le bundle produit : un bundle construit sans adresse de recherche fait échouer le déploiement, vérifié sur le fichier de sortie.
7. Le défaut du 13 septembre est couvert par un test qui échoue sur le `deploy.sh` d'avant la correction.
8. `docs/operations/configuration.md` existe et décrit les trois moments.
