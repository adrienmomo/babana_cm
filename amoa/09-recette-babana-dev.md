# Recette sur babana.dev — VPS existant, nginx en frontal

**Écrit le 25 septembre 2026.** Déploiement de recette sur un second domaine, derrière un nginx
déjà en place, avec les services simulés (aucun compte externe).

Ce n'est **pas** la mise en production décrite par `code/docs/operations/production.md` : celle-là
suppose Caddy, `deploy.sh`, et de vrais fournisseurs. Ici on cherche un environnement à montrer et
à essayer, pas un environnement qui encaisse de l'argent.

---

## 1. Ce qu'il faut savoir avant de commencer

### Le danger principal : `compose.dev.yaml` publie tout sur 0.0.0.0

C'est le point qui compte plus que tous les autres. Le fichier de développement publie, tel quel :

| Port | Service | Sur un VPS public, ça veut dire |
|---|---|---|
| 5432 | PostgreSQL | **La base, ouverte à Internet** |
| 6379 | Redis | **Le vivier et les réservations, ouverts et sans mot de passe** |
| 9001 | Console MinIO | L'administration du stockage des pièces d'identité |
| 8025 | Mailpit | Toute la messagerie de l'instance |
| 4000 / 4001 | Simulateurs | Le faux fournisseur d'identité, joignable de l'extérieur |
| 8069 / 3000 / 9000 | Odoo, temps réel, S3 | À proxifier par nginx, jamais à publier directement |

Il a été écrit pour `localhost`, et il n'a jamais eu à se méfier.

**Et le pare-feu ne vous protège pas** : Docker écrit ses propres règles `iptables` en amont de
`ufw`. Un port publié par Docker est joignable même si `ufw` le refuse. La seule protection fiable
est de **lier explicitement chaque port à `127.0.0.1`**, ce que fait le fichier de surcharge du §4.

### Le second danger : les simulateurs authentifient n'importe qui

`mock-google-identity` délivre un jeton valide à qui le demande — c'est son rôle en développement
(D19). Sur un domaine public, **c'est une porte d'entrée ouverte** : n'importe qui peut se
présenter comme n'importe quel utilisateur.

Conséquence : **tout `babana.dev` doit rester fermé par liste d'adresses**, pas seulement le
back-office. C'est exactement ce que fait `WEB_ALLOWED_IPS` côté Caddy ; il faut le refaire côté
nginx, et c'est fait au §3.

### Le déploiement est suspendu à L6-18 — révision du 25 septembre

**Ce document a été écrit avant d'avoir vérifié ce que le Client web sait faire.** La vérification a
trouvé trois manques, tous annoncés par le dépôt lui-même, tous relevant de L6-18 dont le commit
porte `(part)` :

| Ce qui manque | État réel |
|---|---|
| Le flux OAuth web | N'existe pas — `googleSignIn.ts` est le module natif, et renvoie à « un futur `webGoogleSignIn.ts` » |
| Le fournisseur de carte web | Un bouchon qui rend **un cadre vide**. À Douala, la carte *est* l'interface |
| Le stockage de session web | Un bouchon qui écrit **en clair dans le stockage du navigateur** — **D39 violée**, et son propre commentaire dit « à remplacer avant tout déploiement » |

**Le troisième est bloquant, et pas seulement gênant** : déployer ce bundle, même derrière une liste
d'adresses, poserait des jetons de session en clair dans le navigateur — exactement ce que D39
interdit, et pour la raison qu'elle donne (tout ce qu'on range là est lisible par n'importe quelle
injection de script).

**Décision du 25 septembre** : L6-18 est finie d'abord, avec un projet Google Cloud pour porter le
vrai flux OAuth web et une vraie carte. La recette montrera alors le produit tel qu'il sera, pas une
maquette — et le compte servira de toute façon au pilote. Le reste de ce document (nginx, ports,
surcharge Compose) reste valable et attend.

*La section ci-dessous décrivait un contournement de connexion pour la recette. Elle est conservée
parce que le raisonnement sur le garde-fou vaut toujours, mais elle est **sans objet** dès lors que
le vrai flux OAuth existe.*

### Le troisième, trouvé en préparant : personne ne peut se connecter au Client web

`packages/api-client/src/auth/googleSignIn.ts` est le module **natif** React Native. Le flux OAuth
web est nommé dans le code lui-même comme « un futur `webGoogleSignIn.ts` (L6-18) » — **il n'existe
pas.** En simulé, le seul chemin qui produit un jeton est `mock-google-identity` interrogé
directement, ce que font les scripts (`demo-drivers.mjs`), jamais un navigateur.

Autrement dit : **le premier écran de toute démonstration ne fonctionne pas**, et ce n'est pas à
cause des simulateurs — c'est une pièce jamais construite. Le bundle web a été vérifié en septembre
comme s'exécutant réellement (D38) ; ce que personne n'avait fait, c'est s'y connecter.

**Ce qu'on fait, arbitré le 25 septembre** : un chemin de connexion de recette dans le bundle —
un bouton qui obtient un jeton auprès du simulateur, puis emprunte le même échange
(`exchangeGoogleIdToken`) que tous les autres chemins. Trois conditions, et la troisième n'est pas
négociable :

- **Il n'existe que si l'adresse du simulateur est configurée au build.** Pas de drapeau, pas de
  `NODE_ENV` : l'absence de valeur le supprime, exactement comme D43 traite les autres adresses de
  fournisseur. En production cette variable est vide, donc le bouton n'est pas dans le bundle.
- **Il ne touche pas `exchangeGoogleIdToken`.** Le contournement porte sur la seule production de
  l'`idToken` ; l'échange contre le jeton applicatif reste le chemin commun, sans quoi la recette
  ne prouverait plus rien de l'authentification réelle.
- **Un test prouve qu'un bundle construit sans cette adresse ne contient pas ce chemin.** Sinon
  c'est une porte dérobée qui attend une erreur de configuration — et ce dépôt a déjà vu une
  variable de build partir vide sans que personne ne s'en aperçoive (§9 sexies).

Ce n'est pas L6-18 : le vrai flux OAuth web reste à construire pour le pilote, et il exigera un
projet Google Cloud.

### Caddy ne doit pas démarrer

Il réclame les ports 80 et 443, que nginx tient déjà. Le fichier de surcharge du §4 le neutralise
proprement, sans modifier `compose.yaml`.

### `deploy.sh` va refuser de partir, et il a raison

Il exige un vrai relais SMTP, un vrai jeu de clés Google, une vraie API de routage. Vous n'en avez
aucun, et c'est le but de cette recette. **Ne l'utilisez pas ici** — le §5 décrit le chemin
correct.

---

## 2. Ce qu'il reste à préparer

**Trois enregistrements DNS de plus.** L'apex ne suffit pas : la pile sert quatre noms.

```
babana.dev          A   <IP du VPS>     (déjà fait)
api.babana.dev      A   <IP du VPS>
admin.babana.dev    A   <IP du VPS>
storage.babana.dev  A   <IP du VPS>
```

**Un certificat qui couvre les quatre.** Une seule commande, après les enregistrements :

```sh
certbot --nginx -d babana.dev -d www.babana.dev -d api.babana.dev \
        -d admin.babana.dev -d storage.babana.dev
```

**Votre adresse IP publique**, pour la liste d'autorisation. Si elle est dynamique, prévoyez plutôt
une authentification HTTP simple (`auth_basic`) — le §3 donne les deux.

**Vérifier qu'aucun port n'est déjà pris** sur le VPS : `ss -ltnp | grep -E '5432|6379|8069|3000|9000'`.
Si votre vieux VPS fait déjà tourner un PostgreSQL, il faudra décaler le port côté hôte dans la
surcharge.

**De vrais secrets**, même en recette : la machine est publique. `POSTGRES_PASSWORD`,
`JWT_SECRET`, `REALTIME_SHARED_SECRET`, `ADMIN_PASSWORD`, `MINIO_ROOT_PASSWORD`. Jamais les valeurs
d'exemple du dépôt, qui sont lisibles par quiconque a lu le code.

---

## 3. La configuration nginx

Traduction fidèle du `Caddyfile` (`code/infra/caddy/Caddyfile`). Quatre hôtes, et deux détails qui
cassent tout si on les rate : **pas de barre oblique finale sur les `proxy_pass`** (le préfixe
`/api`, `/rt`, `/s` doit arriver intact au service), et **les en-têtes d'`Upgrade` sur `/rt/`**,
sans lesquels aucun WebSocket ne s'établit.

```nginx
# --- liste d'autorisation, incluse là où il faut ------------------------------
# /etc/nginx/snippets/babana-allow.conf
#   allow 41.202.x.x;      # votre adresse
#   allow 197.x.x.x;       # le client, le jour de la démonstration
#   deny all;

# --- apex : bundle web + API sous la même origine (D46) -----------------------
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name babana.dev www.babana.dev;

    ssl_certificate     /etc/letsencrypt/live/babana.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/babana.dev/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Métadonnée de liens d'application Android : hors liste, le vérificateur de Google
    # la lit depuis l'extérieur.
    location = /.well-known/assetlinks.json {
        alias /opt/babana/code/infra/caddy/wellknown/assetlinks.json;
        default_type application/json;
    }

    include /etc/nginx/snippets/babana-allow.conf;

    location /api/ { proxy_pass http://127.0.0.1:8069; include /etc/nginx/snippets/babana-proxy.conf; }
    location /s/   { proxy_pass http://127.0.0.1:3000; include /etc/nginx/snippets/babana-proxy.conf; }

    location /rt/ {
        proxy_pass http://127.0.0.1:3000;
        include /etc/nginx/snippets/babana-proxy.conf;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;   # une course dure plus longtemps qu'un délai par défaut
    }

    # Recette uniquement : la recherche de lieu simulée, que le navigateur doit joindre.
    # N'existe pas en production, où cette adresse est celle de Google.
    location /maps-search { proxy_pass http://127.0.0.1:4001/search; include /etc/nginx/snippets/babana-proxy.conf; }

    root /opt/babana/code/apps/client/dist-web;
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
}

# --- api. : origine des applications natives ----------------------------------
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name api.babana.dev;
    ssl_certificate     /etc/letsencrypt/live/babana.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/babana.dev/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;

    location /rt/ {
        proxy_pass http://127.0.0.1:3000;
        include /etc/nginx/snippets/babana-proxy.conf;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
    location / { proxy_pass http://127.0.0.1:8069; include /etc/nginx/snippets/babana-proxy.conf; }
}

# --- admin. : back-office, liste d'adresses -----------------------------------
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name admin.babana.dev;
    ssl_certificate     /etc/letsencrypt/live/babana.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/babana.dev/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;

    include /etc/nginx/snippets/babana-allow.conf;
    client_max_body_size 32m;   # téléversement de pièces depuis le back-office
    location / { proxy_pass http://127.0.0.1:8069; include /etc/nginx/snippets/babana-proxy.conf; }
}

# --- storage. : API S3 de MinIO, JAMAIS la console (D64, critère 7) -----------
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name storage.babana.dev;
    ssl_certificate     /etc/letsencrypt/live/babana.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/babana.dev/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;

    client_max_body_size 32m;
    location / {
        proxy_pass http://127.0.0.1:9000;   # 9000 seulement — 9001 est la console
        include /etc/nginx/snippets/babana-proxy.conf;
    }
}
```

Et le fragment commun, `/etc/nginx/snippets/babana-proxy.conf` :

```nginx
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_redirect off;
```

`X-Forwarded-Proto` n'est pas décoratif : `odoo.conf` porte `proxy_mode = True` et construit ses
URL à partir de cet en-tête. Sans lui, Odoo renvoie des liens en `http://`.

**Note sur la signature S3.** MinIO signe en incluant l'en-tête `Host`. `proxy_set_header Host
$host` transmet `storage.babana.dev`, ce qui est correct **à condition** que `S3_PUBLIC_ENDPOINT`
vaille exactement `https://storage.babana.dev` — c'est ce que le §4 pose. Si une URL signée
renvoie `SignatureDoesNotMatch`, c'est là qu'il faut regarder d'abord.

---

## 4. La surcharge Docker Compose pour le VPS

**Ce VPS héberge déjà sept piles, dont cinq Odoo.** Trois conséquences, et la première n'est pas
la plus grave.

**Le port 8069 est pris** par `ecobrique_odoo_web`, publié sur `0.0.0.0` — donc y compris sur la
boucle locale. Les autres ports par défaut (5432, 6379, 3000, 9000, 9001, 8025, 4000, 4001) sont
libres : les PostgreSQL voisins n'exposent leur 5432 qu'à l'intérieur de leurs réseaux. Mais sur
une machine qui porte déjà `8004, 8005, 8069, 8071, 8074, 8096, 8097`, prendre des ports par défaut
est une collision qui attend son tour. **Une plage dédiée, et on n'y pense plus.**

**Ne publier que ce dont nginx a besoin.** Il proxifie Odoo, le temps réel, l'API S3 et la
recherche de lieu simulée. PostgreSQL, Redis, la console MinIO, Mailpit et le simulateur d'identité
n'ont aucune raison d'être joignables depuis l'hôte : `docker compose exec` suffit pour y accéder
quand il le faut. Un port non publié est plus sûr qu'un port publié sur `127.0.0.1`.

**Et un nom de projet explicite** — c'est le point le plus dangereux des trois. Le `Makefile`
n'en pose aucun : Compose déduit alors `code`, du nom du répertoire. Un nom générique sur une
machine qui héberge sept clients, et `make reset` qui exécute `docker compose down -v`. **Sur ce
VPS, ne lancez jamais `make reset`** — utilisez la commande complète avec son `-p`, ou rien.

À créer en `code/infra/compose.vps.yaml`. Elle ne modifie aucun fichier existant :

```yaml
name: babana-dev          # jamais « code » — voir ci-dessus

services:
  caddy:
    profiles: ["jamais-en-recette"]     # non démarré : nginx tient déjà 80/443

  # Publiés, parce que nginx en a besoin — plage 187xx, hors de tout ce qui tourne déjà
  odoo:      { ports: !override ["127.0.0.1:18769:8069"] }
  realtime:  { ports: !override ["127.0.0.1:18730:3000"] }
  minio:     { ports: !override ["127.0.0.1:18790:9000"] }   # 9001 (console) JAMAIS publié, D64
  mock-maps: { ports: !override ["127.0.0.1:18741:4001"] }

  # Non publiés du tout — accessibles par `docker compose exec` si besoin
  postgres:             { ports: !override [] }
  redis:                { ports: !override [] }
  mailpit:              { ports: !override [] }
  mock-google-identity: { ports: !override [] }
```

Les `proxy_pass` du §3 deviennent alors `127.0.0.1:18769` (Odoo), `18730` (temps réel), `18790`
(stockage), `18741/search` (recherche de lieu).

Et la commande n'est plus `make …` mais, en entier :

```sh
docker compose -f infra/compose.yaml -f infra/compose.dev.yaml -f infra/compose.vps.yaml \
               --env-file infra/env/.env  <commande>
```

Et les valeurs propres à la recette, dans `code/infra/env/.env` :

```sh
BABANA_DOMAIN=babana.dev
NODE_ENV=production
S3_PUBLIC_ENDPOINT=https://storage.babana.dev
# secrets générés, jamais ceux de .env.example
```

`WEB_ALLOWED_IPS` et `ADMIN_ALLOWED_IPS` ne servent plus : c'est nginx qui porte la liste.

---

## 5. La séquence

```sh
git clone <dépôt> /opt/babana && cd /opt/babana/code
cp infra/env/.env.example infra/env/.env      # puis remplir : domaine + vrais secrets
docker compose -f infra/compose.yaml -f infra/compose.dev.yaml -f infra/compose.vps.yaml \
               --env-file infra/env/.env up -d --build --wait
# bundle web, construit sur l'hôte, servi par nginx
BABANA_MAPS_SEARCH_URL=https://babana.dev/maps-search npm ci && npm run build:web -w @babana/client
make seed
```

Puis `nginx -t && systemctl reload nginx`.

**Ce qu'il faut vérifier après, dans cet ordre** — chacun correspond à un défaut que ce projet a
réellement rencontré :

1. `curl -I https://babana.dev/` depuis une adresse **hors liste** → `403`.
2. Depuis votre adresse : la page se charge, et **la connexion Google simulée aboutit**.
3. `https://admin.babana.dev` : le compte `admin` ouvre un écran Babana sans erreur d'accès
   (le hook le pose depuis J43 — c'est le premier passage réel de ce chemin).
4. Dans le back-office, un dossier chauffeur → **« Voir la pièce » affiche le document** (D64 :
   c'est ce que la route `storage.` sert).
5. Une course de démonstration → la facture existe et son état d'envoi est lisible.
6. `curl https://storage.babana.dev/` sans URL signée → refus ; et **aucune console MinIO
   n'apparaît** (D64, critère 7).
7. Depuis l'extérieur : `nc -zv babana.dev 5432` et `6379` → **doivent échouer**. Si l'un répond,
   la surcharge du §4 n'a pas été prise.

---

## 6. Ce que cette recette ne prouvera pas

- **Rien de ce qui touche un vrai fournisseur.** Identité, routage, cartes, emails, notifications :
  tout est simulé. Une facture « envoyée » atterrit dans Mailpit.
- **Ni `deploy.sh`, ni `bootstrap.sh`, ni `rollback.sh`** — les trois scripts de production, dont
  aucun n'a jamais tourné sur une vraie machine. Ce chemin-ci ne les emprunte pas.
- **Ni les sauvegardes** (L8-08). La recette n'a pas de donnée à perdre.

C'est une recette : elle sert à montrer, à essayer, et à découvrir les surprises de la vraie vie
réseau — pas à valider la mise en production. Ce qu'elle apprendra vaudra quand même pour
`babana.cm` : les certificats, les proxys, les origines, les URL signées, ce sont les mêmes
mécanismes.
