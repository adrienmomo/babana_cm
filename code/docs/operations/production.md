# Mise en production de l'hôte (L0-07)

Runbook de la procédure en dix étapes de `amoa/04-monorepo-et-services.md` §9. Chaque étape :
ce qui l'exécute, sa vérification, et **la frontière entre ce qui est fait dans le dépôt et ce
qui attend une vraie machine / un vrai DNS / de vrais secrets**.

État au 1er octobre 2026 (J29) : **aucune étape n'a été exécutée sur une machine.** Les scripts
de `infra/production/` sont écrits et relisibles ; leur première exécution réelle attend le VPS.

---

## Frontière — fait / attend une machine

| # | Étape | Dans le dépôt | Attend, hors de cet environnement |
|---|---|---|---|
| 1 | Provisionner le VPS | Dimensionnement fixé (§9 : 6 vCPU / 16 Go / 200 Go **NVMe**, Europe) | Compte hébergeur, commande de la machine, choix Contabo vs Hetzner |
| 2 | Durcir l'accès (SSH, pare-feu) | `bootstrap.sh` complet et idempotent | Root sur le VPS ; la liste `SSH_ADMIN_IPS` réelle |
| 3 | MAJ de sécurité auto | `bootstrap.sh` (unattended-upgrades) | idem étape 2 |
| 4 | DNS | Noms fixés (`babana.cm`, `api.`, `admin.`, `storage.` (D64) + recette) | Accès registrar ; **propagation à vérifier avant l'étape 5** |
| 5 | Déployer la pile | `deploy.sh` (compose.yaml seul, build web, module Odoo) | `infra/env/.env` de production avec les vrais secrets ; DNS résolu |
| 6 | Vérifier certificats + `admin.` fermé | `deploy.sh` lance `infra/smoke-test.sh` ; le critère 7 (403 hors liste) se teste depuis une IP hors liste | Une vraie IP hors liste pour le test complet du 403 |
| 7 | Sauvegardes externes + **restauration prouvée** | `backup.sh`, `restore.sh` -- chiffrement (age) et mécanique de restauration (pg_restore + miroir MinIO) prouvés le 14/09/2026 contre des conteneurs neufs de ce dépôt (voir plus bas) | Un stockage objet chez un **autre** hébergeur ; un hôte **vierge** ; l'exécution réelle de `restore.sh` contre les deux -- seul ce geste-là clôt le critère 4 de L8-08 |
| 8 | Supervision hébergée ailleurs | `monitoring/probe.sh`, `probe-host.sh`, README | Une machine de supervision distincte ; un webhook d'alerte ; le test « panne provoquée » |
| 9 | Latence de référence depuis Douala | Gabarit `latency-baseline.md` | Une connexion camerounaise réelle |
| 10 | Retour arrière documenté + détenteurs d'accès | `rollback.sh` ; section ci-dessous | La liste nominative réelle des détenteurs d'accès |

**Critère de fin de la mise en production (§9)** : l'étape 7 a réussi (restauration sur hôte
vierge, compte rendu daté plus bas) **et** l'étape 8 alerte effectivement (vérifié en provoquant
une panne). Aucune des deux n'est faite.

---

## Déroulé

### 1. Provisionner

VPS NVMe, distribution Linux LTS (Debian 12 / Ubuntu 24.04). Dimensionnement §9. **Avant de
payer** : mesurer la latence réelle depuis une connexion camerounaise vers l'emplacement
proposé (Contabo l'affiche à l'inscription) — c'est la valeur qui remplira `latency-baseline.md`.

Choix d'hébergeur : **Hetzner par défaut** (meilleure réputation d'entrées-sorties pour une
application adossée à PostgreSQL) ; Contabo si une raison particulière plaide pour lui. La pile
étant un `docker compose`, une migration ultérieure tient en une soirée.

### 2–3. Durcir

```sh
sudo SSH_ADMIN_IPS="<vos adresses>" SSH_PORT=22 sh infra/production/bootstrap.sh
```

Vérifications (depuis une **nouvelle** session, sans fermer l'actuelle) : login par clé OK,
login par mot de passe refusé, `ufw status` montre 80 + 443 ouverts et SSH restreint. **Le port
80 reste ouvert** : Caddy en a besoin pour ACME ; le fermer provoque une expiration silencieuse
~3 mois plus tard.

### 4. DNS

Enregistrements A pour `babana.cm`, `api.babana.cm`, `admin.babana.cm`, `storage.babana.cm`
(D64 — point d'entrée public du stockage, `amoa/01-architecture.md` §9 octies), et les
sous-domaines de recette. `dig +short babana.cm` doit renvoyer l'IP du VPS **partout** avant
l'étape 5 — Caddy échoue à obtenir un certificat pour un nom non encore résolu, et l'échec
ressemble à une erreur de configuration.

### 5. Déployer

Cloner le dépôt dans `/opt/babana`, renseigner `code/infra/env/.env` à partir de
`.env.example` — avec les **secrets de production** (origine de chaque valeur :
`infra/env/README.md`). `.env.example` ne contient **aucune** adresse de fournisseur externe
(D43 retournée, `amoa/questions/REPONSES-2026-09-06.md` §2) : celles-ci sont vides et doivent
être renseignées ici. Points qui diffèrent du développement, `deploy.sh` **refuse de partir**
si l'un manque ou pointe vers un simulateur :

- `BABANA_DOMAIN=babana.cm`, `NODE_ENV=production` ;
- `GOOGLE_JWKS_URL=https://www.googleapis.com/oauth2/v3/certs` (vide dans `.env.example`) ;
- `GOOGLE_ROUTING_URL` et `BABANA_MAPS_SEARCH_URL` = vraies API Google (vides dans
  `.env.example` ; le développement les reçoit de `compose.dev.yaml` / des cibles `make client`) ;
- `SMTP_HOST`/`SMTP_PORT` = relais SMTP réel + `SMTP_USER`/`SMTP_PASSWORD` (vides dans
  `.env.example` ; `mailpit` n'est que dans `compose.dev.yaml`. Un `SMTP_HOST=mailpit` recopié
  ici enverrait les factures dans le vide sans erreur — `deploy.sh` le refuse) ;
- `PUSH_PROVIDER=fcm` + `FCM_*` si les notifications doivent partir ;
- `ADMIN_ALLOWED_IPS` et `WEB_ALLOWED_IPS` = adresses réelles (le pilote reste fermé tant que
  L8-01/L8-02 n'existent pas) ;
- `S3_PUBLIC_ENDPOINT=https://storage.babana.cm` (D64 — vide dans `.env.example` ; le
  développement pose `http://localhost:9000` dans `compose.dev.yaml`. Un repli vers l'adresse
  interne (`minio:9000`) ou vers `localhost` produirait le défaut trouvé le 16 septembre : un
  bouton « Voir la pièce » qui ne charge rien pour personne en dehors du réseau Docker).

```sh
sh infra/production/deploy.sh
```

`deploy.sh` n'utilise **que** `infra/compose.yaml` (jamais `compose.dev.yaml`, qui expose les
ports internes, monte les sources et démarre mailpit + les mocks). `make up` reste un confort
de développement ; en production, c'est `deploy.sh`.

### 6. Vérifier

`deploy.sh` lance `infra/smoke-test.sh`. Le critère 7 (une IP hors `ADMIN_ALLOWED_IPS` reçoit
403) se teste depuis une machine hors liste — `curl -I https://admin.babana.cm/` doit renvoyer
`403`.

### 7. Sauvegardes + restauration prouvée

```sh
# cron sur l'hôte
0 2 * * *  cd /opt/babana/code && BACKUP_REMOTE=b2:babana-backups BACKUP_AGE_RECIPIENTS=age1... \
           sh infra/production/backup.sh >> /var/log/babana-backup.log 2>&1
```

Stockage objet chez un **autre** hébergeur que le VPS. **Chiffrée (age) avant de quitter la
machine** — les trois pièces (dump PostgreSQL, miroir MinIO des pièces d'identité de chauffeurs,
`.env`), pas seulement le `.env` : corrigé le 14 septembre 2026 (L8-08, première exécution réelle,
`amoa/questions/REPONSES-2026-09-14.md`), le dump et les documents partaient en clair jusque-là.
`BACKUP_AGE_RECIPIENTS` porte une ou plusieurs clés **publiques** age (séparées par des virgules) ;
la clé **privée** correspondante (`age-keygen`) vit dans le gestionnaire de secrets, jamais dans
le dépôt, et sert à la restauration ci-dessous.

**Redis n'est délibérément pas sauvegardé** (L8-08, critère 5) : c'est l'invariant 1 (règle de
partition, `amoa/01-architecture.md` §2) — le service temps réel ne possède aucune donnée durable,
rien à restaurer. Une reprise après incident se retrouve par L3-14 (test de résilience), jamais par
une restauration Redis.

Puis, sur un hôte **vierge** :

```sh
BACKUP_REMOTE=b2:babana-backups RESTORE_TS=<horodatage> \
BACKUP_AGE_IDENTITY_FILE=<chemin vers la clé privée age> sh infra/production/restore.sh
```

**Tant que `restore.sh` n'a pas réussi, le projet n'a pas de sauvegarde** (L8-08). Consigner le
succès ci-dessous.

#### Restauration prouvée — mécanique (conteneur neuf, ce dépôt)

Ce que cette session pouvait prouver, et rien de plus : que `backup.sh`/`restore.sh`
fonctionnent réellement — chiffrement compris — de bout en bout, contre des conteneurs **neufs**
(projet `docker compose` isolé, volumes vides), pas contre un hôte vierge chez un autre hébergeur.
Ce second geste reste entièrement hors de portée d'une session de développement (pas de compte
chez un hébergeur tiers, pas de seconde machine) et reste à faire par vous — voir le journal
ci-dessous, toujours à sa première ligne.

**J38 avait prouvé la mécanique en rejouant les commandes de `restore.sh` une à une — pas le
script.** J39 (ci-dessous) l'a relancé comme script, d'un bout à l'autre, avec
`sh infra/production/restore.sh` tel quel (D62, critère 6 de L8-08).

| Date | Sauvegarde restaurée | Cible | Résultat | Par |
|---|---|---|---|---|
| 2026-09-03 (J38) | `20260903T130122Z` (pile de développement vivante, 101 courses) | conteneurs `docker compose -p babana-restore-test -f infra/compose.yaml` (volumes neufs, projet isolé de la pile de développement -- démonté après la preuve, reproductible avec la séquence ci-dessous) | Réussi. `backup.sh` réel exécuté (pg_dump + miroir MinIO, chacun chiffré age avant `rclone copy` -- vérifié : seuls des `.age` atteignent la destination) ; déchiffrement + `pg_restore` + rechargement MinIO réels dans les conteneurs neufs, **commandes rejouées une à une, pas le script `restore.sh` lui-même** (constaté par la session, voir D62). 4 éléments retrouvés, vérifiés par requête directe : course **C2026000355** (`state=settled`) et sa facture **BINV/2026/00029** (`state=posted`, 1425 FCFA) ; document chauffeur **id 189** (chauffeur 421, permis) et son objet MinIO `drivers/421/id_card/24f2394…jpg` -- même somme de contrôle (ETag) avant/après ; solde de compte courant du chauffeur 410 : mouvement `collection` de 425 FCFA retrouvé intact. Détail complet : `amoa/rapport-nuit-J38.md` §3. | session J38 |
| 2026-09-03 (J39) | `20260903T154913Z` (pile de développement vivante, jeu de démonstration D63 compris) | `RESTORE_COMPOSE_PROJECT=babana-restore-test sh infra/production/restore.sh` -- **le script lui-même, tel quel**, `age`/`rclone` réellement installés sur l'hôte (`age` 1.3.2, `rclone` 1.75.0 -- plus de contournement par image Docker) | Réussi, code de sortie 0. Smoke-test intégré au script vert (4 `OK`, la vérification manuelle du critère 7 signalée comme à faire à la main) ; `RESTORE-CHECK rides=39 approved_drivers=29 cash_movements=9`. Objet MinIO du permis de démonstration `seed/babana-demo-driver-1/license.pdf` retrouvé avec le **même ETag** avant/après (`d25d8429965d99443455aad98e478051`) -- les pièces de D63 survivent elles aussi à la sauvegarde/restauration. Contradiction de l'en-tête signalée par la nuit précédente vérifiée en pratique : `infra/env/.env` n'était **pas** un prérequis, le script l'a déchiffré lui-même depuis `env-<TS>.age` sans intervention -- l'en-tête reste correct (« ou laisser ce script le faire »), seulement ambigu à la première lecture. **Un vrai piège trouvé en exécutant, invisible à la lecture** : `$COMPOSE up -d --build --wait --wait-timeout 300` (ligne qui amène Caddy) échoue si la pile de développement principale tourne déjà sur ce même hôte -- les deux projets `docker compose` sont isolés (conteneurs, volumes, réseau) mais **pas les ports hôte** 80/443, que Caddy publie sans condition dans les deux. `docker compose … stop caddy` sur le projet principal avant l'exercice, `start caddy` après -- geste sans objet sur un hôte vraiment vierge (rien d'autre n'y tourne), mais à connaître pour quiconque rejoue cet exercice sur cette même machine de développement. | session J39 |

**Reproduire cette preuve** (`age`/`rclone` maintenant de vrais binaires hôte -- `brew install rclone` ; `age`/`age-keygen` depuis les archives officielles `github.com/FiloSottile/age/releases`, le bottle Homebrew d'`age` exigeant une compilation Go que l'Xcode installé ici ne permet pas. `bootstrap.sh` installe les deux par `apt-get` sur un vrai VPS Debian/Ubuntu, critère 7 de L8-08) :
```sh
docker compose -f infra/compose.yaml -f infra/compose.dev.yaml --env-file infra/env/.env stop caddy   # libère 80/443, uniquement si la pile de développement tourne déjà
age-keygen -o /tmp/restore-test-key.txt   # clé jetable, jamais commitée
BACKUP_REMOTE=<répertoire local> BACKUP_AGE_RECIPIENTS=<clé publique ci-dessus> sh infra/production/backup.sh
BACKUP_REMOTE=<même répertoire> RESTORE_TS=<horodatage imprimé par backup.sh> \
  BACKUP_AGE_IDENTITY_FILE=/tmp/restore-test-key.txt RESTORE_COMPOSE_PROJECT=babana-restore-test \
  sh infra/production/restore.sh
docker compose -p babana-restore-test -f infra/compose.yaml down -v   # nettoyage
docker compose -f infra/compose.yaml -f infra/compose.dev.yaml --env-file infra/env/.env start caddy
```

#### Restauration prouvée — hôte vierge, autre hébergeur (le critère réel de L8-08)

| Date | Sauvegarde restaurée | Hôte cible | Résultat | Par |
|---|---|---|---|---|
| _(à remplir au premier exercice)_ | | | | |

### 8. Supervision externe

`infra/production/monitoring/` — sur une machine distincte. Métriques : disponibilité des trois
hôtes, expiration des certificats, disque, vol de CPU, âge de la dernière sauvegarde, file
Odoo (L3-12, en attente). Test obligatoire : couper `realtime` sur l'hôte, constater l'alerte,
redémarrer.

### 9. Latence de référence

`docs/operations/latency-baseline.md` — à remplir depuis Douala à la mise en service. Sans
valeur de référence, toute dégradation ultérieure se discutera à l'impression.

### 10. Retour arrière

- **Code seul** (le déploiement fautif n'a pas migré le schéma) : `sh infra/production/rollback.sh`
  — revient au commit enregistré dans `.state/previous_commit`, reconstruit, `smoke-test`.
- **Avec migration de schéma** : `rollback.sh` s'arrête sur l'échec du rechargement du module.
  Restaurer alors la base depuis la dernière sauvegarde (`restore.sh` sur l'hôte, fenêtre
  d'indisponibilité annoncée), puis redéployer le code cible.

#### Détenteurs d'accès

_(à remplir — liste nominative, par rôle)_

| Rôle | Accès | Personne |
|---|---|---|
| SSH root / sudo sur le VPS | | |
| Registrar DNS | | |
| Gestionnaire de secrets de production | | |
| Stockage des sauvegardes | | |
| Console de l'hébergeur | | |

---

## Seuil de bascule d'hébergeur (§9)

À définir **avant** la mise en service, pas après avoir vu les chiffres — sinon le seuil ne fait
que justifier la décision déjà prise.

- **Métrique de décision** : percentile 95 du temps de réponse d'API mesuré depuis Douala
  (même méthode que `latency-baseline.md`), moyenné sur une semaine glissante, relevé à
  plusieurs moments de la journée (l'hôte est partagé, la moyenne ment).
- **Seuil** : _(à fixer avec la valeur de référence — proposition : p95 > 2 × la référence de
  mise en service, ou p95 > 800 ms dans l'absolu, la plus basse des deux)_.
- **Déclencheur secondaire** : vol de CPU (`probe-host.sh`) au-delà de 8 % en moyenne sur 24 h,
  répété plus de trois jours — signe de voisinage, indépendamment de la latence applicative.
- **Cible de repli** : Hetzner, même zone. Migration = une soirée (`docker compose` + restauration
  de sauvegarde).
