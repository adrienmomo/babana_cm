# babana.cm — Monorepo et services

**Version** 1.4 — 9 août 2026
**Complète** `01-architecture.md` (D1 à D15), `03-decoupage-taches.md` et `05-prerequis-et-simulation.md` (D19 à D21)

---

## 1. Trois décisions complémentaires

Ces choix ne figuraient pas dans l'architecture et méritent d'être posés explicitement. Les deux premiers découlent de la demande d'un monorepo unique, le troisième du choix d'hébergement.

**D16 — Le service temps réel est écrit en TypeScript sur Node.**

L'architecture laissait le choix ouvert entre Node et FastAPI. Le monorepo tranche : les deux applications sont déjà en TypeScript, donc écrire le service temps réel en TypeScript permet de partager **le contrat C-02 sous forme de code exécutable** — les types et les schémas de validation des messages WebSocket deviennent un paquet importé à la fois par les apps et par le serveur. Un message mal formé devient une erreur de compilation plutôt qu'un bug d'intégration découvert en recette.

C'est le principal bénéfice technique du monorepo, et il disparaît si le service est écrit dans un autre langage.

**D17 — Les contrats C-01 et C-02 vivent dans un paquet `@babana/contracts`.**

Source unique de vérité : types TypeScript et schémas de validation. Les apps et le service temps réel l'importent directement. Côté Odoo, qui est en Python, le paquet exporte des schémas JSON générés que les contrôleurs valident à l'entrée. Le contrat cesse d'être un document que quelqu'un oublie de mettre à jour ; il devient du code qui casse la compilation quand il diverge.

**D18 — Le pilote tourne sur un VPS unique en Europe, avec des sauvegardes hors de cet hôte.**

Détail, dimensionnement et conditions au §9. L'essentiel : à l'échelle du pilote, un hôte suffit et la pile entière est un `docker compose` — le coût de migration est faible, ce qui rend la décision réversible. La condition non négociable est que les sauvegardes ne résident jamais sur la machine qu'elles protègent.

---

## 2. Arborescence

Le monorepo vit dans `code/`, à côté de `amoa/` qui porte les décisions et les spécifications. Un seul dépôt git à la racine `babana.cm/`.

```
babana.cm/
├── CLAUDE.md
├── amoa/                          # Décisions et spécifications — lecture seule côté dev
│   ├── 01-architecture.md … 05-prerequis-et-simulation.md
│   ├── specs/
│   └── questions/                 # Écarts relevés pendant le développement
│
└── code/                          # Le monorepo
    ├── apps/
    │   ├── client/                    # Application React Native — passagers
    │   └── driver/                    # Application React Native — chauffeurs
    │
    ├── packages/
    │   ├── contracts/                 # C-01 + C-02 : types, schémas, codes d'erreur
    │   ├── api-client/                # Client REST + JSON-RPC + WebSocket
    │   ├── ui/                        # Design system partagé
    │   └── maps/                      # Abstraction carte et navigation (C3, L6-01)
    │
    ├── services/
    │   ├── odoo/
    │   │   ├── addons/
    │   │   │   └── babana/            # Module métier
    │   │   ├── config/odoo.conf
    │   │   └── Dockerfile
    │   ├── realtime/
    │   │   ├── src/
    │   │   ├── test/
    │   │   └── Dockerfile
    │   └── mocks/                     # Services simulés, développement seul (L0-08)
    │       ├── google-identity/
    │       └── maps/
    │
    ├── infra/
    │   ├── compose.yaml               # Services communs
    │   ├── compose.dev.yaml           # Surcharges développement
    │   ├── caddy/
    │   │   ├── Caddyfile
    │   │   └── wellknown/assetlinks.json
    │   ├── minio/bootstrap.sh
    │   ├── production/                # Durcissement, déploiement, supervision (L0-07)
    │   └── env/.env.example
    │
    ├── test/
    │   ├── e2e/                       # Scénarios de bout en bout (L10-01)
    │   └── load/                      # Tests de charge (L10-06)
    │
    ├── tools/
    │   └── map-benchmark/             # Mesure cartographique (L10-02)
    │
    ├── docs/                          # Documentation technique produite par le développement
    ├── Makefile
    ├── package.json                   # Espaces de travail npm
    └── README.md
```

Tous les chemins de ce document et des spécifications sont **relatifs à `code/`**. `code/docs/` porte la documentation technique — contrats, mesures, procédures d'exploitation — à ne pas confondre avec `amoa/`.

**Pourquoi `test/` à la racine plutôt que dans chaque paquet** : les scénarios de bout en bout et les tests de charge traversent Odoo, le service temps réel et Redis simultanément. Ils n'appartiennent à aucun composant. Les tests unitaires, eux, restent dans leur paquet.

**Pourquoi `packages/maps` séparé** : l'abstraction carte (C3, décisions D12 et D13) doit être physiquement isolée pour que la règle « aucun écran n'importe le SDK » soit vérifiable mécaniquement. Une règle de lint interdisant l'import direct du SDK hors de ce paquet transforme une bonne intention en contrainte tenue.

---

## 3. Services Docker

Sept services. Chacun correspond à un composant de l'architecture ou à une dépendance externe qu'il faut pouvoir simuler localement.

| Service | Image | Rôle | Correspond à |
|---|---|---|---|
| `postgres` | `postgres:16` | Source de vérité | §2 de l'architecture |
| `redis` | `redis:7-alpine` | État éphémère, géo-index | §2 de l'architecture |
| `odoo` | Construit sur `odoo:18` | Domaine métier et back-office | Module `babana` |
| `realtime` | Construit, Node 22 | Positions, réservation, suivi | Service temps réel |
| `caddy` | `caddy:2` | Entrée unique, TLS automatique | Exigence L8-06 |
| `minio` | `minio/minio` | Stockage de documents compatible S3 | L1-05, accès signés |
| `mailpit` | `axllent/mailpit` | SMTP de test | CDC §III.3, envoi de facture |

### Justification des trois services non évidents

**`caddy`** — L8-06 exige TLS partout, y compris en recette. Un proxy en frontal donne un point d'entrée unique et des certificats automatiques, et surtout il fait que l'adresse de l'API est **la même en développement et en production**. Sans lui, les apps embarquent des adresses conditionnelles et le premier déploiement révèle des bugs de configuration qu'on aurait pu éviter.

Routage par hôte : l'apex sert le partage de trajet public (L8-03) et les liens d'application, `api.` sert Odoo et le service temps réel, `admin.` sert le back-office derrière une liste d'adresses autorisées. Détail au §6.

**`minio`** — Les documents chauffeurs (permis, pièce d'identité) ne doivent jamais être servis par URL publique, seulement par accès signé à durée limitée. Le filestore Odoo ne fournit pas ça nativement. MinIO parle le protocole S3 : le même code fonctionnera en production contre S3 ou équivalent, sans branche conditionnelle.

**`mailpit`** — La facture doit être envoyable par email (CDC §III.3). Sans SMTP local, cette fonction n'est jamais testée avant la production, ou pire, testée en envoyant de vrais emails depuis un poste de développement.

### Ce qui n'est délibérément pas un service

**Les applications React Native.** Metro tourne sur l'hôte, pas dans un conteneur : la connexion aux appareils et aux émulateurs passe par `adb` et par le réseau local, ce qui rend la conteneurisation pénible pour un bénéfice nul. La commande `make up` démarre l'infrastructure ; `make client` et `make driver` démarrent les apps. C'est un compromis assumé, pas un oubli.

**Firebase Cloud Messaging et la passerelle SMS.** Pas d'équivalent local raisonnable. Traités par abstraction (D19) : en développement, l'implémentation journalise le message au lieu de l'envoyer et l'expose sur un endpoint d'inspection. Le code de vérification OTP de L1-09 est donc lisible dans la console pendant le développement.

### Services simulés, en développement uniquement

Deux services supplémentaires figurent dans `compose.dev.yaml` et **jamais** dans `compose.yaml` (D19, L0-08) :

| Service | Rôle |
|---|---|
| `mock-google-identity` | Sert un jeu de clés JWKS et émet des jetons d'identité signés, valides comme volontairement invalides |
| `mock-maps` | Renvoie des itinéraires et des résultats de recherche de lieu depuis des doublures de Douala, et sait simuler une panne |

Principe : **on simule le fournisseur, jamais notre logique.** Le contrôleur d'authentification vérifie une vraie signature contre un vrai jeu de clés — seul l'émetteur change, via la variable `GOOGLE_JWKS_URL`. Aucune branche conditionnelle dans le code de production. Détail dans `05-prerequis-et-simulation.md` §2.

Conséquence : `git clone` puis `make up` suffit à parcourir un scénario complet de course, sans aucun compte externe, et le scénario de bout en bout de L10-01 s'exécute en intégration continue sans secret ni coût.

---

## 4. `infra/compose.yaml`

À implémenter tel quel dans L0-01. Les valeurs sensibles viennent de `infra/env/.env`, jamais du dépôt (L0-06).

```yaml
name: babana

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: postgres
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 5s
      retries: 10
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "no", "--maxmemory-policy", "noeviction"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      retries: 10
    restart: unless-stopped

  odoo:
    build:
      context: ../services/odoo
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      HOST: postgres
      USER: ${POSTGRES_USER}
      PASSWORD: ${POSTGRES_PASSWORD}
      GOOGLE_OAUTH_CLIENT_IDS: ${GOOGLE_OAUTH_CLIENT_IDS}
      JWT_SECRET: ${JWT_SECRET}
      REALTIME_INTERNAL_URL: http://realtime:3000
      REALTIME_SHARED_SECRET: ${REALTIME_SHARED_SECRET}
      S3_ENDPOINT: http://minio:9000
      S3_BUCKET: babana-documents
      S3_ACCESS_KEY: ${MINIO_ROOT_USER}
      S3_SECRET_KEY: ${MINIO_ROOT_PASSWORD}
      SMTP_HOST: mailpit
      SMTP_PORT: "1025"
    volumes:
      - ../services/odoo/addons:/mnt/extra-addons
      - ../services/odoo/config/odoo.conf:/etc/odoo/odoo.conf:ro
      - odoo-filestore:/var/lib/odoo
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:8069/web/health || exit 1"]
      interval: 10s
      retries: 20
    restart: unless-stopped

  realtime:
    build:
      context: ..
      dockerfile: services/realtime/Dockerfile
    depends_on:
      redis:
        condition: service_healthy
      odoo:
        condition: service_started
    environment:
      NODE_ENV: ${NODE_ENV:-development}
      PORT: "3000"
      REDIS_URL: redis://redis:6379
      ODOO_INTERNAL_URL: http://odoo:8069
      REALTIME_SHARED_SECRET: ${REALTIME_SHARED_SECRET}
      JWT_SECRET: ${JWT_SECRET}
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/health || exit 1"]
      interval: 10s
      retries: 10
    restart: unless-stopped

  caddy:
    image: caddy:2
    depends_on:
      - odoo
      - realtime
    environment:
      BABANA_DOMAIN: ${BABANA_DOMAIN:-localhost}
      ACME_EMAIL: ${ACME_EMAIL}
      ADMIN_ALLOWED_IPS: ${ADMIN_ALLOWED_IPS:-0.0.0.0/0}
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy/wellknown:/srv/wellknown:ro
      - caddy-data:/data
      - caddy-config:/config
    restart: unless-stopped

  minio:
    image: minio/minio
    command: ["server", "/data", "--console-address", ":9001"]
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    volumes:
      - miniodata:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 10s
      retries: 10
    restart: unless-stopped

  mailpit:
    image: axllent/mailpit
    restart: unless-stopped

volumes:
  pgdata:
  odoo-filestore:
  miniodata:
  caddy-data:
  caddy-config:
```

### `infra/compose.dev.yaml`

Surcharges de développement uniquement : ports exposés sur l'hôte pour l'inspection, rechargement à chaud du service temps réel, interfaces d'administration accessibles.

```yaml
services:
  postgres:
    ports: ["5432:5432"]
  redis:
    ports: ["6379:6379"]
  odoo:
    ports: ["8069:8069"]
    command: ["odoo", "--dev=reload,qweb,xml"]
  realtime:
    ports: ["3000:3000"]
    volumes:
      - ../services/realtime/src:/app/services/realtime/src
      - ../packages/contracts:/app/packages/contracts
    command: ["npm", "run", "dev", "-w", "@babana/realtime"]
  minio:
    ports: ["9000:9000", "9001:9001"]
  mailpit:
    ports: ["8025:8025"]

  # Services simulés — développement uniquement (D19, L0-08)
  mock-google-identity:
    build:
      context: ..
      dockerfile: services/mocks/google-identity/Dockerfile
    ports: ["4000:4000"]
  mock-maps:
    build:
      context: ..
      dockerfile: services/mocks/maps/Dockerfile
    ports: ["4001:4001"]
```

Les deux services simulés n'existent que dans `compose.dev.yaml`. Ils refusent de démarrer si `NODE_ENV` vaut `production` — un garde-fou, parce qu'un service d'émission de jetons accessible en production serait une porte ouverte sur tous les comptes.

---

## 5. Makefile

Une commande pour tout démarrer, comme demandé.

```makefile
COMPOSE = docker compose -f infra/compose.yaml -f infra/compose.dev.yaml --env-file infra/env/.env

.PHONY: up down logs reset seed client driver test lint

up:              ## Démarre tous les services
	@test -f infra/env/.env || cp infra/env/.env.example infra/env/.env
	$(COMPOSE) up -d --build
	@$(MAKE) --no-print-directory wait
	@echo "Odoo         http://localhost:8069"
	@echo "API          https://api.localhost"
	@echo "Back-office  https://admin.localhost"
	@echo "Partage      https://localhost/s/<token>"
	@echo "MinIO        http://localhost:9001"
	@echo "Mailpit      http://localhost:8025"

wait:            ## Attend que les services soient sains
	$(COMPOSE) ps --format json | grep -q healthy || sleep 5

down:            ## Arrête tout
	$(COMPOSE) down

reset:           ## Arrête et efface les données
	$(COMPOSE) down -v

logs:            ## Journaux agrégés
	$(COMPOSE) logs -f

seed:            ## Jeu de données de démonstration
	$(COMPOSE) exec odoo odoo shell -d babana --no-http < services/odoo/scripts/seed.py

client:          ## Démarre l'app Client
	npm run start -w @babana/client

driver:          ## Démarre l'app Chauffeur
	npm run start -w @babana/driver

test:            ## Tests de tous les paquets et services
	npm run test --workspaces --if-present
	$(COMPOSE) exec -T odoo odoo -d babana --test-enable --stop-after-init -i babana

lint:
	npm run lint --workspaces --if-present
```

**Critère de fin de L0-01** : sur une machine vierge, `git clone` puis `make up` produit sept services sains, Odoo répond, le service temps réel répond, et aucune configuration manuelle n'a été nécessaire.

---

## 6. Domaines et environnements

Domaine racine : **babana.cm**.

| Hôte | Sert | Exposition |
|---|---|---|
| `babana.cm` | Page publique de partage de trajet, `/.well-known/assetlinks.json`, site vitrine ultérieur | Public, non authentifié |
| `api.babana.cm` | API mobile, JSON-RPC, WebSocket temps réel | Public, authentifié |
| `admin.babana.cm` | Back-office Odoo | Restreint |
| `staging.babana.cm` et ses sous-domaines | Recette, même structure | Restreint |
| `localhost` | Développement, certificat interne | Locale |

**Pourquoi séparer `admin` de `api`** alors que les deux pointent sur Odoo : cela permet de placer le back-office derrière une liste d'adresses autorisées ou un VPN sans toucher à l'API mobile. Le gain de sécurité est réel et le coût nul — c'est une ligne de configuration Caddy.

**Pourquoi le partage de trajet est sur l'apex** et non sur un sous-domaine : le lien est envoyé par SMS à un proche, souvent sur un forfait limité et lu sur un petit écran. `babana.cm/s/aB3xK9` est court, lisible et inspire confiance ; `share.api.babana.cm/...` ne l'est pas.

**Point d'action hors code** : l'apex `babana.cm` doit servir `/.well-known/assetlinks.json` en HTTPS pour que la vérification des liens d'application Android fonctionne (L10-07). Sans ce fichier, les notifications qui ouvrent l'app sur le bon écran (L7-02) déclencheront un sélecteur d'application au lieu d'ouvrir babana directement.

**Second point d'action** : dans la console Google Cloud, `babana.cm` doit être déclaré comme domaine autorisé de l'écran de consentement OAuth. Sur Android, l'identifiant client repose sur l'empreinte de signature et non sur le domaine, mais l'écran de consentement, lui, exige le domaine vérifié.

---

## 7. Caddyfile

```
{
	email {$ACME_EMAIL}
}

# Apex — partage de trajet public et liens d'application
{$BABANA_DOMAIN:localhost} {
	handle /.well-known/assetlinks.json {
		root * /srv/wellknown
		file_server
	}

	handle /s/* {
		reverse_proxy realtime:3000
	}

	handle {
		respond "babana.cm" 200
	}
}

# API mobile et temps réel
api.{$BABANA_DOMAIN:localhost} {
	handle /rt/* {
		reverse_proxy realtime:3000
	}

	handle {
		reverse_proxy odoo:8069
	}
}

# Back-office — accès restreint
admin.{$BABANA_DOMAIN:localhost} {
	@allowed remote_ip {$ADMIN_ALLOWED_IPS:0.0.0.0/0}
	handle @allowed {
		reverse_proxy odoo:8069
	}
	respond 403
}
```

En développement, `BABANA_DOMAIN` vaut `localhost` et Caddy émet un certificat interne. En production, la variable vaut `babana.cm` et Caddy obtient et renouvelle les certificats automatiquement, y compris pour les sous-domaines.

`ADMIN_ALLOWED_IPS` reste ouvert en développement et se restreint en production. La restriction est une variable d'environnement, pas une modification de configuration : elle peut évoluer sans nouveau déploiement.

---

## 8. Frontières entre paquets, à faire respecter par le lint

Ces règles ne sont pas du style, ce sont des invariants d'architecture. Une règle de lint qui échoue vaut mieux qu'une revue de code qui oublie.

| Règle | Motif |
|---|---|
| `apps/*` n'importe jamais un SDK de carte directement, seulement `@babana/maps` | C3 : rend le changement de fournisseur possible (D13) |
| `apps/*` n'écrit jamais de règle métier — tarif, décision d'affectation, validation de solde | §4 de l'architecture : les règles restent serveur |
| `services/realtime` n'écrit jamais dans PostgreSQL | Règle de partition §2 : passe par Odoo |
| `services/realtime` ne dépend d'aucun paquet de `apps/` | Le service ne doit rien savoir de l'interface |
| Tout message WebSocket est validé par un schéma de `@babana/contracts` | D17 : le contrat est exécutable |
| Aucun secret dans le dépôt | L0-06 |

**Sur la troisième règle** : c'est la matérialisation de la règle de partition. Si le service temps réel gagne un accès direct à PostgreSQL « juste pour une lecture », l'invariant est perdu et les garanties de résilience du §2 tombent. Cette règle doit être vérifiée par l'absence de client PostgreSQL dans les dépendances du service, pas seulement par convention.

---

## 9. Hébergement (D18)

### Dimensionnement

Toute la pile sur un hôte unique, pour le pilote Bonanjo — environ 50 chauffeurs et 20 000 courses par mois.

| Ressource | Minimum | Confortable |
|---|---|---|
| vCPU | 6 | 8 |
| RAM | 16 Go | 24 Go |
| Disque | 200 Go **NVMe** | 400 Go NVMe |
| Bande passante | Illimitée ou généreuse | — |

Le **NVMe n'est pas négociable**. Odoo est très bavard avec PostgreSQL : chaque appel d'API se traduit en plusieurs allers-retours base. Une latence disque instable devient directement un temps de réponse instable, donc un écran d'attente pour un client qui a le moto-taxi informel à portée de main.

Répartition indicative de la mémoire : PostgreSQL 4 à 6 Go, Odoo avec quelques processus 4 à 6 Go, service temps réel 1 Go, Redis moins de 1 Go à cette échelle, MinIO et Caddy marginaux, le reste en cache système — dont PostgreSQL tire un bénéfice direct.

### Localisation

**Europe.** Contabo n'a pas de datacenter en Afrique et positionne son hub allemand pour l'Europe, l'Afrique et le Moyen-Orient. C'est cohérent avec le routage réel : les câbles sous-marins camerounais remontent vers l'Europe. Les États-Unis et l'Asie ajouteraient de la latence sans contrepartie.

Bénéfice secondaire : l'hébergement en Union européenne simplifie la conformité aux exigences de protection des données du CDC §VII.4.

**À vérifier avant de payer** : la latence réelle depuis une connexion camerounaise, pas depuis un poste européen. Contabo affiche le temps de réponse vers chaque emplacement pendant l'inscription.

### Ce que le choix Contabo implique

Contabo densifie fortement ses hôtes. Les retours de 2026 convergent sur du vol de CPU visible et des chutes d'IOPS quand les machines voisines s'activent. Trois conséquences opérationnelles :

**Les mesures de charge de L10-06 seront bruitées.** Sur un hôte partagé, la moyenne ment. Relever les percentiles hauts et la variance, pas la moyenne, et refaire les mesures à plusieurs moments de la journée.

**Surveiller le vol de CPU en continu**, avec une alerte. Une dégradation progressive due au voisinage est indiscernable d'une régression applicative si personne ne mesure la métrique.

**Prévoir le seuil de bascule à l'avance.** Au-delà de quel percentile 95 de temps de réponse d'API faut-il changer d'hébergeur ? Défini avant la mise en service, pas après avoir vu les chiffres.

**Alternative** : Hetzner, prix comparable, même zone géographique, réputation d'entrées-sorties nettement meilleure. Si aucune raison particulière ne plaide pour Contabo, c'est le choix par défaut pour une application adossée à une base de données. La pile étant un `docker compose`, la migration tient en une soirée — commencer sur Contabo et basculer si les mesures déçoivent reste défendable, à condition de mesurer.

### Ce qui reste hors de l'hôte, sans exception

| Élément | Où | Pourquoi |
|---|---|---|
| Sauvegardes (L8-08) | Stockage objet distinct, autre fournisseur de préférence | Un instantané chez le même hébergeur disparaît avec l'incident |
| Secrets de production | Gestionnaire de secrets ou variables de la plateforme | L0-06 |
| Journaux d'exploitation | Service externe ou copie hors hôte | Un serveur perdu emporte les journaux qui expliqueraient pourquoi |
| Supervision et alertes | Service externe | Une supervision hébergée sur la machine surveillée ne prévient pas de sa panne |

La dernière ligne est celle qu'on oublie le plus souvent. Une sonde qui tourne sur le serveur qu'elle surveille est muette exactement quand elle serait utile.

### Procédure de mise en production

À exécuter dans cet ordre. Chaque étape a une vérification, et aucune ne se saute.

1. **Provisionner** le VPS avec NVMe, distribution Linux à support long terme.
2. **Durcir l'accès** : authentification SSH par clé uniquement, mot de passe désactivé, port 22 restreint aux adresses d'administration, pare-feu n'ouvrant que 80, 443 et le port SSH. **Le port 80 reste ouvert** — Caddy en a besoin pour renouveler les certificats. Le fermer « par sécurité » est la cause classique d'une expiration silencieuse trois mois après la mise en service.
3. **Mises à jour de sécurité automatiques** activées.
4. **DNS** : enregistrements A pour `babana.cm`, `api.babana.cm`, `admin.babana.cm`, et les sous-domaines de recette. Vérifier la propagation avant l'étape suivante — Caddy échouera à obtenir un certificat pour un nom non résolu.
5. **Déployer** la pile : cloner, renseigner `infra/env/.env` avec `BABANA_DOMAIN=babana.cm`, `make up`.
6. **Vérifier les certificats** sur les trois hôtes, et vérifier que `admin.` refuse une adresse hors liste.
7. **Configurer les sauvegardes** vers le stockage externe, puis **exécuter une restauration complète sur un hôte vierge**. L8-08 n'est pas satisfait tant que cette restauration n'a pas réussi.
8. **Installer la supervision externe** : disponibilité des trois hôtes, expiration des certificats, occupation disque, vol de CPU, taille de la file d'attente vers Odoo (L3-12), réussite de la dernière sauvegarde.
9. **Mesurer la latence** depuis Douala vers l'API et le WebSocket, et consigner la valeur de référence. Toute dégradation ultérieure se comparera à elle.
10. **Documenter le retour arrière** : que faire si un déploiement casse la production, et qui a les accès.

**Critère de fin de la mise en production** : l'étape 7 a réussi et l'étape 8 alerte effectivement — vérifié en provoquant volontairement une panne.
