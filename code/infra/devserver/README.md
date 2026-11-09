# infra/devserver — serveur de développement 75.119.155.162

**Ce serveur seulement.** Ni le poste local (`make up`, `compose.dev.yaml`, `infra/env/.env`), ni
la production (`infra/production/`, `docs/operations/production.md`) ne lisent ces fichiers.
Décisions et écarts : `amoa/questions/DEVSERVER-2026-11-05.md`.

| Où | Quoi | Géré par |
|---|---|---|
| Docker, `127.0.0.1` seulement | PostgreSQL 16, Redis 7.4, MinIO (compilé depuis les sources), Mailpit | `compose.yaml`, projet `babana-devserver` |
| Hôte | Odoo 18 (sources épinglées, `/opt/odoo/18.0` + `/opt/odoo/venv`) | systemd, `babana-odoo` |
| Hôte | Service temps réel, simulateur de routage | pm2, utilisateur `babana` |
| Hôte | nginx + certbot | systemd |

| Chemin | Contenu |
|---|---|
| `/var/www/babana_cm` | le dépôt (propriétaire `ubuntu`, en lecture seule pour `babana`) |
| `/etc/babana/babana.env` | configuration et secrets (`640 root:babana`), écrit une seule fois par `gen-env.sh` |
| `/var/lib/babana` | données de `babana` : filestore Odoo, `~/.pm2`, journaux pm2 |

Domaines : `api.`, `admin.`, `storage.` et `share.babana.dev`. L'apex `babana.dev` est sur une autre
machine. Accès SSH : port 44646 (`infra/production/bootstrap.sh`, deux passages).

## Commandes, depuis `/var/www/babana_cm/code`

```sh
DC="sudo docker compose -f infra/devserver/compose.yaml --env-file /etc/babana/babana.env"
ODOO="sh infra/devserver/odoo.sh"   # odoo-bin en tant que babana, secrets dans l'environnement, jamais en ligne de commande
```

Jamais une cible `make` ici : elles visent la pile locale (`infra/compose.yaml`), pas celle-ci.

### Première installation

1. `sudo GOOGLE_OAUTH_CLIENT_IDS=<id> sh infra/devserver/gen-env.sh`
2. `$DC build minio && $DC up -d --wait`, puis le compartiment :
   `$DC exec -T minio sh /bootstrap.sh`
3. Module Odoo : `$ODOO -d babana -i babana --stop-after-init --no-http`
4. `sudo ln -sf $PWD/infra/devserver/systemd/babana-odoo.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now babana-odoo`
5. Temps réel : `npm ci`, `npm run build -w @babana/contracts`, `npm run build -w @babana/realtime`,
   puis `sudo -u babana pm2 start infra/devserver/pm2/ecosystem.config.cjs && sudo -u babana pm2 save`
   et `sudo env PATH=$PATH pm2 startup systemd -u babana --hp /var/lib/babana`.
6. nginx, HTTP d'abord : lier `nginx/00-babana-http.conf` dans `sites-enabled`, `nginx -t`, recharger.
7. Certificat (DNS propagé d'abord — `dig +short api.babana.dev` doit rendre l'IP du serveur) :
   `sudo certbot certonly --webroot -w /var/www/letsencrypt --cert-name babana-devserver --email yannick.m@htc-it.cm --agree-tos -n -d api.babana.dev -d admin.babana.dev -d storage.babana.dev -d share.babana.dev --deploy-hook "systemctl reload nginx"`
8. Lier `nginx/10-babana-https.conf`, `nginx -t`, recharger.
9. Données de démonstration : `$ODOO shell -d babana --no-http < services/odoo/scripts/seed.py`

### Mise à jour du code

```sh
git pull
$ODOO -d babana -u babana --stop-after-init --no-http && sudo systemctl restart babana-odoo
npm ci && npm run build -w @babana/contracts && npm run build -w @babana/realtime && sudo -u babana pm2 reload babana-realtime
```

### Lire ce qui n'est pas publié

- **Codes OTP** (SMS simulé) : `sudo journalctl -u babana-odoo --since -10min | grep "sms:console"` —
  la ligne dit `[sms:console] -> 237… | Babana : votre code est NNNNNN`, sans le mot « otp ».
- **Mailpit** : `ssh -L 8025:127.0.0.1:8025 babana-dev`, puis http://localhost:8025
- **Console MinIO** : `ssh -L 9001:127.0.0.1:9001 babana-dev`, puis http://localhost:9001
- **Journaux** : `journalctl -u babana-odoo -f` ; `sudo -u babana pm2 logs`

## APK pour téléphones réels (depuis le poste de développement)

Release signées avec la clé debug du dépôt (empreinte SHA-1 `5e8f16…f625`, celle de la clé A).
Les adresses sont figées au bundle (`transform-inline-environment-variables`) : les poser à la
construction, depuis `code/apps/<app>/android`, après `npm run build` des paquets partagés.

| Variable | Babana (client) | Babana Pro (chauffeur) |
|---|---|---|
| `BABANA_API_URL` | `https://api.babana.dev` | idem |
| `BABANA_REALTIME_WS_URL` | `wss://api.babana.dev/rt/ws` | idem |
| `GOOGLE_MAPS_API_KEY` (manifeste, clé A) | clé A | clé A |
| `BABANA_GOOGLE_MAPS_API_KEY` (REST, clé B) | clé B | vide — le chauffeur n'appelle ni Places ni Geocoding |
| `BABANA_MAPS_SEARCH_URL` | `https://places.googleapis.com/v1/places:searchText` | — |
| `BABANA_MAPS_GEOCODE_URL` | `https://maps.googleapis.com/maps/api/geocode/json` | — |
| `BABANA_MAP_TILE_URL` | vide (carte Google) | vide (carte Google) |
| `BABANA_ROUTING_URL` | — | `https://router.project-osrm.org` (comme `make driver`) |

Puis `./gradlew --no-daemon assembleRelease`. Deux pièges :

- **Cache Metro** : il ne tient pas compte de l'environnement. Arrêter les Metro de
  développement et vider `$TMPDIR/metro-cache` avant chaque app, sinon un `config.ts` transformé
  avec d'autres adresses peut finir dans l'APK. Vérifier ensuite :
  `unzip -p app-release.apk assets/index.android.bundle | grep -a -c api.babana.dev`.
- **JDK 17.0.6 d'Android Studio sur arm64** : plantage de la JVM (« Field too big for insn »)
  pendant le Lint de release, toujours sur la même méthode. Contournement :
  `-Dorg.gradle.jvmargs="-Xmx2048m -XX:MaxMetaspaceSize=512m -XX:CompileCommand=exclude,org.jetbrains.uast.kotlin.FirKotlinUastResolveProviderService::resolveSyntheticJavaPropertyAccessorCall"`.

Comptes semés : client `+237 699 450 102`, chauffeurs `+237 690 110 201` à `205` ; code OTP dans
le journal (ci-dessus).
