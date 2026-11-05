# Serveur de développement 75.119.155.162 — écarts relevés en préparant le déploiement

Préparation du 4 et 5 novembre 2026, avec vous, avant toute exécution sur la machine. Rien de ce
qui suit ne concerne l'environnement de développement local (`make up`, `compose.dev.yaml`,
`Makefile`, `infra/env/.env`), qui reste tel quel, ni la production décrite par
`code/docs/operations/production.md`.

## La machine

VPS Contabo, Ubuntu 24.04.5, 4 vCPU, 7,8 Go, 96 Go, sans swap. Vierge au premier examen : ni
Docker, ni nginx, ni Node ; pare-feu inactif ; SSH sur 22 ouvert à tous, **connexion par mot de
passe et connexion `root` effectivement actives** (`sshd -T` : `passwordauthentication yes`,
`permitrootlogin yes` — `50-cloud-init.conf` l'emporte sur `60-cloudimg-settings.conf`).

Ce n'est pas la machine de `amoa/09-recette-babana-dev.md` (nginx partagé, sept piles) : celle-là
porte encore l'apex `babana.dev` (5.189.160.12). Ce serveur-ci reçoit `api.`, `admin.`,
`storage.` et `share.babana.dev`.

## 1. Installation sans conteneur, sauf les données (écart à D16/D18)

**Ce que disent les décisions** : la pile est un `docker compose` (D16), et la mise en production
passe par `deploy.sh` (D18, §9).

**Ce que vous avez demandé pour ce serveur** : Odoo, le service temps réel, le simulateur de
routage et nginx installés sur l'hôte (systemd) ; seuls PostgreSQL, Redis, MinIO et Mailpit dans
Docker, liés à `127.0.0.1`.

**Conséquences** : `deploy.sh`, `rollback.sh`, `backup.sh`, `restore.sh` et `smoke-test.sh`
supposent `docker compose exec` sur les services applicatifs ; aucun ne s'applique tel quel. Les
fichiers propres à ce serveur vivent dans `code/infra/devserver/`, que rien d'autre ne lit.

Je propose D-suivant : **le serveur de développement est installé hors conteneur pour les
services applicatifs ; D16 et D18 restent la règle pour la production et pour le poste local.**

## 2. `bootstrap.sh` enferme dehors sur Ubuntu 24.04

Ubuntu 24.04 démarre SSH par activation de socket (`ssh.socket` activé). Le port d'écoute est
celui du socket, régénéré depuis `sshd_config` au `daemon-reload` ; un `systemctl reload ssh` ne
le change pas.

`bootstrap.sh` écrit `Port ${SSH_PORT}`, recharge `ssh`, puis active `ufw` en n'autorisant **que**
le nouveau port. Avec `SSH_PORT` différent de 22 : sshd reste sur 22, que ufw vient de fermer, et
rien n'écoute sur le nouveau port. Seule issue : la console de l'hébergeur.

Corrigé sur la branche `L0-07-bootstrap-ubuntu-2404`, avec un test qui reproduit d'abord
l'enfermement. Le changement de port se fait désormais en deux passages : 22 et le nouveau port
ensemble, puis 22 retiré seulement après une session ouverte sur le nouveau port. Le script
vérifie que le port écoute réellement avant d'activer le pare-feu.

Défaut voisin, même correction : la prison fail2ban `sshd` surveillait le port par défaut (22),
donc plus rien après un changement de port.

## 3. Exceptions SSH de ce serveur à §9

§9 demande « authentification par clé uniquement, mot de passe désactivé, port restreint aux
adresses d'administration ». Pour ce serveur, vous avez décidé : **mots de passe et connexion
`root` laissés tels qu'ils sont**, SSH ouvert à toute adresse, sur le port 44646, avec fail2ban.

`bootstrap.sh` garde le comportement de §9 par défaut. Les deux exceptions sont des options
explicites (`SSH_ADMIN_IPS=any`, `SSH_KEEP_PASSWORD_LOGIN=1`), jamais un défaut.

Risque, pour mémoire : `root` a un mot de passe et accepte la connexion par mot de passe depuis
Internet. Le port non standard et fail2ban réduisent le bruit ; la longueur du mot de passe fait
le reste.

## 4. Pas d'adaptateur pour l'API Google Routes

`services/routing.py` envoie `GET ?originLat=…&originLng=…&destLat=…&destLng=…` et lit
`distanceMeters` / `durationSeconds` : la forme du simulateur (`services/mocks/maps`). L'API
Google Routes attend `POST …/directions/v2:computeRoutes`, un corps JSON, les en-têtes
`X-Goog-Api-Key` et `X-Goog-FieldMask`, et rend `routes[0].duration` sous la forme `"123s"`.
Aucune variable ne porte de clé serveur. Poser `GOOGLE_ROUTING_URL` vers Google casserait toute
cotation.

La recherche de lieu et le géocodage inverse, eux, reproduisent déjà Google à l'identique
(`packages/maps/src/providers/google/places.ts`).

Sur ce serveur : simulateur de routage sur `127.0.0.1`, jamais publié. **À ouvrir comme tâche,
avec sa spécification, avant le pilote** — `deploy.sh` refuse déjà de partir sans
`GOOGLE_ROUTING_URL` réelle, mais il n'existe rien de réel à y mettre.

## 5. Les appels REST de l'app ne portent aucun en-tête Android

L'app Client appelle Places (New) et Geocoding par un `fetch` qui n'envoie que `X-Goog-Api-Key`
(`places.ts:47-52`), sans `X-Android-Package` ni `X-Android-Cert`. Une clé restreinte aux
« applications Android » est donc refusée sur ces appels ; cette restriction ne vaut que pour le
SDK natif de carte, qui lit une autre variable (`GOOGLE_MAPS_API_KEY`, `build.gradle:110`).

Vérifié le 5 novembre avec la clé actuelle (`BABANA_GOOGLE_MAPS_API_KEY`) : Places répond 403
`API_KEY_HTTP_REFERRER_BLOCKED` (clé restreinte aux sites web depuis L6-18), Geocoding répond
`REQUEST_DENIED` (API non activée sur le projet).

Retenu pour ce serveur : deux nouvelles clés. A, SDK natif, restreinte à `cm.babana.client` et
`cm.babana.driver` ; B, REST, restreinte par API (Places New + Geocoding), sans restriction
d'application, avec plafond journalier. La clé B est lisible dans l'APK : c'est le plafond qui la
protège. Ajouter les en-têtes Android dans `@babana/maps` n'y changerait rien, les deux valeurs
étant elles aussi lisibles dans l'APK.

## 6. MinIO ne distribue plus rien de prêt à l'emploi — concerne tout le dépôt

Constaté le 5 novembre en installant le serveur : `quay.io/minio/minio` répond **401** (même
`latest`), `minio/minio` n'existe plus sur Docker Hub, et `dl.min.io` répond **410 Gone** pour les
binaires du serveur comme pour ceux du client `mc`. Seules les sources restent, sur GitHub.

**Ce n'est pas propre au serveur de développement.** `infra/compose.yaml` tire
`quay.io/minio/minio` sans version : le `make up` local ne fonctionne que parce que l'image est
déjà en cache sur le poste (ARM, du 7 septembre). Un poste neuf, une intégration continue ou
`deploy.sh` en production échoueraient à cette étape. Le `Dockerfile.release` de MinIO lui-même
téléchargeait depuis `dl.min.io` : il ne construit plus rien.

**Retenu pour le serveur de développement** (votre choix) : `code/infra/devserver/minio/Dockerfile`
compile `minio` et `mc` depuis leurs étiquettes source, aux versions de l'image locale
(`RELEASE.2025-09-07T16-13-09Z` et `RELEASE.2025-08-13T08-35-41Z`).

**Pour le reste du dépôt, à arbitrer.** Deux options :

- **A** — la même compilation depuis les sources pour `infra/compose.yaml`. Même version partout ;
  plus aucune mise à jour de sécurité en amont sans recompiler depuis une étiquette plus récente,
  et MinIO communautaire est désormais en maintenance seule.
- **B** — remplacer MinIO par un autre serveur compatible S3 (Garage, SeaweedFS…). Touche D18,
  L1-05, D64 et les tests de stockage ; à peser avant le pilote, pas dans l'urgence.

Je propose D-suivant : **A maintenant, pour que `make up` fonctionne sur un poste neuf ; B étudié
avant le pilote.**
