# Serveur de développement 75.119.155.162 — rapport de mise en place

Session menée avec vous, à partir du 5 novembre 2026. Décisions et écarts :
`amoa/questions/DEVSERVER-2026-11-05.md`. Rien ici ne touche l'environnement local.

---

## L0-07 — `bootstrap.sh` sur Ubuntu 24.04 (branche `L0-07-bootstrap-ubuntu-2404`)

**Le défaut.** Sur Ubuntu 24.04, SSH démarre par activation de socket ; `bootstrap.sh` changeait
le port dans `sshd_config`, rechargeait `ssh` (sans effet sur le socket), puis n'autorisait au
pare-feu que le nouveau port. Enfermé dehors. Trois défauts voisins, corrigés ensemble :

- la prison fail2ban surveillait 22, plus rien après un changement de port ;
- le garde-fou « aucune clé publique » venait **après** l'écriture de la configuration sshd : il
  arrêtait le script mais laissait le fichier, appliqué au prochain redémarrage ;
- `systemctl enable --now fail2ban || true` : un fail2ban qui ne démarre pas passait en silence.

**Le test d'abord.** `test/config/bootstrap.test.sh` exécute le vrai script dans un conteneur
`ubuntu:24.04` (dash), avec des doublures de `systemctl`/`ss`/`ufw` qui reproduisent ce que
`systemctl cat ssh.socket ssh.service` montre sur le serveur. Il demande, après chaque passage,
si une nouvelle session SSH peut encore s'ouvrir. Contre l'ancien script : **13 vérifications sur
22 en échec**, dont « une nouvelle session SSH peut encore s'ouvrir ». Contre le nouveau : 22/22.
Ajouté à `make test`.

**La correction.** Changement de port en deux passages (22 et le nouveau port ensemble, puis 22
retiré avec `SSH_PORT_CONFIRMED=1`) ; `daemon-reload` + `restart ssh.socket` en mode socket ;
vérification que chaque port écoute réellement **avant** de toucher au pare-feu ; prison
fail2ban réglée sur les ports ouverts, et échec si fail2ban ne démarre pas ; garde-fou des clés
avant toute écriture. Exceptions à §9 en options explicites : `SSH_ADMIN_IPS=any`,
`SSH_KEEP_PASSWORD_LOGIN=1`. Comportement par défaut inchangé.

Ce que j'avais annoncé et que je n'ai **pas** mis dans `bootstrap.sh` : la liaison par défaut de
Docker à `127.0.0.1`. En production, Caddy publie `80:80` et `443:443` ; ce défaut les aurait
liés à la boucle locale. Il ira dans l'installation propre au serveur de développement.

**Exécuté comme script sur le serveur, d'un bout à l'autre (D62).**

| Passage | Commande | Résultat |
|---|---|---|
| 1 | `SSH_ADMIN_IPS=any SSH_PORT=44646 SSH_KEEP_PASSWORD_LOGIN=1` | Code 0. `ss` : sshd sur 22 et 44646, IPv4 et IPv6. Nouvelle session sur 44646 ouverte depuis ce poste. |
| 2 | même chose + `SSH_PORT_CONFIRMED=1` | Code 0. ufw : 80, 443, 44646 (limité) seulement. 22 fermé vu de l'extérieur. Nouvelle session sur 44646 : ouverte. |

Configuration effective (`sshd -T`) : `port 44646`, `passwordauthentication yes` et
`permitrootlogin yes` conservés comme vous l'avez demandé, `maxauthtries 3`,
`x11forwarding no`. fail2ban actif : trois adresses de robots bannies dans les minutes qui ont
suivi.

**Ce qui m'a surpris.**

- `sshd -T` contredisait le fichier qu'on lit en premier : `60-cloudimg-settings.conf` dit
  `PasswordAuthentication no`, mais `50-cloud-init.conf` (`yes`) passe avant — premier fichier
  lu, premier gagnant. La connexion `root` par mot de passe était ouverte à Internet sans
  pare-feu avant cette session.
- Une première nouvelle session sur 44646, juste après le second passage, a expiré. Le serveur
  n'a rien reçu (ni journal ufw, ni entrée dans la table de limitation, ni bannissement
  fail2ban) ; la tentative suivante, capturée par `tcpdump`, a abouti normalement. Cause non
  établie — réseau entre ce poste et le serveur, vraisemblablement. Je le note plutôt que de
  l'expliquer.
- `ufw limit` refuse une adresse au-delà de 6 connexions en 30 s. Mes outils ouvrent une
  connexion par commande : j'ai mis le multiplexage SSH (`ControlMaster`) dans l'alias
  `babana-dev` de `~/.ssh/config` sur ce poste avant d'activer le pare-feu.

**Accès** : `ssh babana-dev` (port 44646). Le script de premier passage est resté dans
`/home/ubuntu/bootstrap.sh` sur le serveur ; il disparaîtra quand le dépôt y sera cloné.

**Définition de fini.** `make test` vert en entier : suite Odoo 997 tests, 0 échec ; suites npm ;
`bootstrap.test.sh` ; résilience L3-14. `make lint` vert. **`make typecheck` rouge, mais pas de
mon fait** : deux erreurs `TS2345` dans `services/realtime/test/internal.test.ts:794` et
`outbox.test.ts:448` (`redis.zrange(..., 0, -1)` — un `number` là où le typage attend une
chaîne), présentes à l'identique sur `master` sans mes changements. Dernière modification de ces
fichiers : `1b0dbcd` (L4-12, 31 octobre). Hors du périmètre de cette tâche : signalé, non corrigé
ici.

---

## DEVSERVER — installation hors conteneur (branche `devserver-setup`)

Fichiers : `code/infra/devserver/` (README = procédure). Données dans Docker sur `127.0.0.1`,
Odoo sous systemd, temps réel et simulateur de routage sous pm2 (votre demande), nginx.

**Posé et vérifié, le 5 novembre.**

| Élément | Vérification |
|---|---|
| Swap 4 Go, utilisateur `babana` (`/var/lib/babana`) | `free`, `id babana` |
| Docker 29.1 (paquets Ubuntu), `daemon.json` `"ip": "127.0.0.1"` | publication volontairement négligente `-p 18999:6379` : liée à `127.0.0.1`, injoignable depuis ce poste |
| Node 22.23 (NodeSource, clé vérifiée), pm2 7.1 | `pm2-babana` activé au démarrage |
| wkhtmltopdf 0.12.6.1 *patched qt* | empreinte identique par deux chemins réseau (pas de somme publiée) ; PDF rendu ; factures reçues avec PDF |
| Odoo 18 source, épinglé à `db1315502` (8 sept., = nightly 20260908 de l'image locale), venv Python 3.12 | `pip check` propre ; module installé, 50 modules, `rc=0` |
| PostgreSQL 16.15, Redis 7.4, MinIO, Mailpit | tous `healthy`, ports sur `127.0.0.1` seulement ; compartiment privé (GET anonyme : 403) |
| MinIO + `mc` compilés depuis les sources | identifiants de commit identiques à l'image locale (`07c3a429…`, `7394ce0d…`) |
| Odoo sous systemd, 2 workers + gevent | `/web/health` pass ; 8069 et 8072 sur `127.0.0.1` |
| Temps réel sous pm2 | `/health` : `redis ok, odoo ok` ; `ws` 8.21.3 (le piège du Dockerfile évité) |
| Données de démonstration | `seed rc=0` : 6 zones, 5 chauffeurs, 21 courses réglées ; 23 factures dans Mailpit |
| Connexion OTP par l'API réelle | demande → code lu dans `journalctl` → échange : session « Emmanuel Ndoumbè », chauffeur approuvé |
| nginx, étape HTTP | IP nue : connexion fermée (444) ; `api.babana.dev` forcé vers ce serveur : 301 vers HTTPS |

**Ce qui m'a surpris.**

- **MinIO ne distribue plus rien** (quay.io 401, Docker Hub absent, `dl.min.io` 410). Concerne tout
  le dépôt : `amoa/questions/DEVSERVER-2026-11-05.md` §6.
- **Le garde de D19 a fonctionné** : `mock-maps` refuse `NODE_ENV=production`, et je le lui avais
  donné. Corrigé dans la configuration pm2 (`development`, comme `compose.dev.yaml`), pas dans le
  garde.
- **Mon propre `gen-env.sh`** créait `/etc/babana` en 700 root : `babana` n'atteignait jamais son
  fichier 640. Ma vérification locale avait regardé le fichier, pas sa lecture par `babana`.
  Revérifié depuis en lisant réellement en tant que `babana` (et refusé à `nobody`).
- **Les factures partent de `odoobot@example.com`** (« No mail server matches the from_filter »).
  Pas propre au serveur : 266 occurrences dans le journal Odoo local. Défaut existant, non traité
  ici.
- **GitHub refuse les poussées sur `devserver-setup`** (`fatal error in commit_refs_rules`, trois
  fois, statut GitHub nominal). Les commits ont rejoint le serveur par `git bundle` : sa copie est
  identique à cette branche.

**Reste à faire, et pourquoi.**

- Certificat et étape HTTPS : les quatre noms ne pointent pas encore vers ce serveur
  (`api.`, `admin.`, `storage.` → 5.189.160.12 ; `share.` absent).
- Clés Google A et B, puis les APK.
- Redémarrage complet du serveur pour prouver que tout revient seul (systemd, pm2, Docker) — pas
  encore fait.
