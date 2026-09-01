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
| 4 | DNS | Noms fixés (`babana.cm`, `api.`, `admin.` + recette) | Accès registrar ; **propagation à vérifier avant l'étape 5** |
| 5 | Déployer la pile | `deploy.sh` (compose.yaml seul, build web, module Odoo) | `infra/env/.env` de production avec les vrais secrets ; DNS résolu |
| 6 | Vérifier certificats + `admin.` fermé | `deploy.sh` lance `infra/smoke-test.sh` ; le critère 7 (403 hors liste) se teste depuis une IP hors liste | Une vraie IP hors liste pour le test complet du 403 |
| 7 | Sauvegardes externes + **restauration prouvée** | `backup.sh`, `restore.sh` | Un stockage objet chez un **autre** hébergeur ; un hôte vierge ; l'exécution réelle de `restore.sh` |
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

Enregistrements A pour `babana.cm`, `api.babana.cm`, `admin.babana.cm`, et les sous-domaines de
recette. `dig +short babana.cm` doit renvoyer l'IP du VPS **partout** avant l'étape 5 — Caddy
échoue à obtenir un certificat pour un nom non encore résolu, et l'échec ressemble à une erreur
de configuration.

### 5. Déployer

Cloner le dépôt dans `/opt/babana`, renseigner `code/infra/env/.env` à partir de
`.env.example` — avec les **secrets de production** (origine de chaque valeur :
`infra/env/README.md`). Points qui diffèrent du développement, vérifiés par `deploy.sh` :

- `BABANA_DOMAIN=babana.cm`, `NODE_ENV=production` ;
- `GOOGLE_JWKS_URL=https://www.googleapis.com/oauth2/v3/certs` (pas de mock) ;
- `GOOGLE_ROUTING_URL` et `BABANA_MAPS_SEARCH_URL` = vraies API Google (le défaut compose pointe
  `mock-maps`, absent en prod) ;
- `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD` = relais SMTP réel (mailpit n'est que dans
  `compose.dev.yaml`, jamais démarré ici) ;
- `PUSH_PROVIDER=fcm` + `FCM_*` si les notifications doivent partir ;
- `ADMIN_ALLOWED_IPS` et `WEB_ALLOWED_IPS` = adresses réelles (le pilote reste fermé tant que
  L8-01/L8-02 n'existent pas).

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

Stockage objet chez un **autre** hébergeur que le VPS. Puis, sur un hôte **vierge** :

```sh
BACKUP_REMOTE=b2:babana-backups RESTORE_TS=<horodatage> sh infra/production/restore.sh
```

**Tant que `restore.sh` n'a pas réussi, le projet n'a pas de sauvegarde** (L8-08). Consigner le
succès ci-dessous.

#### Restauration prouvée — journal

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
