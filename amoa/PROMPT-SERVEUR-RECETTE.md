# Prompt à lancer sur le VPS — recette babana.dev

**À exécuter depuis le VPS**, dans le dépôt cloné, avec Claude Code.

---

## Avant de lancer — trois choses de votre côté

1. **Les trois enregistrements DNS manquants** : `api.`, `admin.`, `storage.babana.dev` vers l'IP
   du VPS. Vérifier avec `dig +short api.babana.dev` **avant** de lancer certbot.
2. **Le certificat qui couvre les cinq noms** :
   `certbot --nginx -d babana.dev -d www.babana.dev -d api.babana.dev -d admin.babana.dev -d storage.babana.dev`
3. **Votre adresse IP publique** sous la main (`curl ifconfig.me`), à donner au prompt.

---

## Le prompt

```
Tu déploies une recette de babana.cm sur ce VPS, sur le domaine babana.dev, avec
les services simulés. Le répertoire courant est le dépôt cloné.

Lis d'abord, en entier : `CLAUDE.md`, puis `amoa/09-recette-babana-dev.md` qui
décrit précisément ce déploiement, puis `code/infra/caddy/Caddyfile` (le
routage à reproduire) et `code/infra/compose.dev.yaml`.

Mon adresse IP à autoriser : <IP>.

## Ce que ce déploiement n'est PAS

Ce n'est pas la mise en production de `code/docs/operations/production.md`.
**N'utilise pas `deploy.sh`** : il exige de vrais fournisseurs (SMTP, Google) que
je n'ai pas, et il refusera de partir. C'est voulu, ne le contourne pas.

Ici : nginx en frontal (déjà installé, avec d'autres sites dessus), Caddy éteint,
et les simulateurs de D19 en service.

## Les deux dangers, à traiter avant tout le reste

**1. `compose.dev.yaml` publie tout sur 0.0.0.0** — PostgreSQL, Redis, la console
MinIO, Mailpit, les simulateurs. Sur un VPS public c'est une base et un Redis
ouverts à Internet. Et le pare-feu ne protège pas : Docker écrit ses règles
iptables en amont de ufw, un port publié est joignable même si ufw le refuse.

La seule protection fiable est de lier chaque port à `127.0.0.1`. Crée
`code/infra/compose.vps.yaml` pour ça (modèle au §4 du document), **sans modifier
`compose.yaml` ni `compose.dev.yaml`** — ce sont des fichiers du dépôt, la
surcharge est locale à ce déploiement.

**2. `mock-google-identity` délivre un jeton valide à qui le demande.** C'est son
rôle en développement. Sur un domaine public, c'est une porte ouverte : tout
`babana.dev` doit donc rester derrière une liste d'adresses, pas seulement le
back-office.

## Une pièce à construire avant de pouvoir montrer quoi que ce soit

**Personne ne peut se connecter au Client web.** `packages/api-client/src/auth/googleSignIn.ts`
est le module natif React Native ; le flux OAuth web est nommé dans le code comme « un futur
`webGoogleSignIn.ts` (L6-18) » et n'existe pas. En simulé, seuls les scripts obtiennent un jeton,
en appelant `mock-google-identity` directement.

Vérifie-le avant de me croire — c'est un fait de code, pas une supposition, et si je me trompe la
suite change.

Il faut donc un **chemin de connexion de recette** dans le bundle : un bouton qui obtient un
`idToken` auprès du simulateur, puis emprunte le **même** `exchangeGoogleIdToken` que tous les
autres chemins. Trois conditions :

- **Il n'existe que si l'adresse du simulateur est configurée au build.** Pas de drapeau, pas de
  `NODE_ENV` : l'absence de valeur le supprime, comme D43 traite les autres adresses de
  fournisseur. En production la variable est vide, donc le bouton n'est pas dans le bundle.
- **Ne touche pas `exchangeGoogleIdToken`.** Le contournement porte sur la production de l'ID
  token, jamais sur l'échange — sinon la recette ne prouve plus rien de l'authentification.
- **Un test prouve qu'un bundle construit sans cette adresse ne contient pas ce chemin.** C'est
  une porte dérobée si personne ne le vérifie, et ce dépôt a déjà vu une variable de build partir
  vide sans que rien ne le signale (`amoa/01-architecture.md` §9 sexies).

Le simulateur d'identité devra donc être joignable par le navigateur : une route nginx de plus,
sous l'apex et derrière la même liste d'adresses.

## Le travail

**La configuration nginx** : le §3 du document en donne une traduction du
Caddyfile. Ne la recopie pas les yeux fermés — relis le Caddyfile et vérifie que
tu reproduis bien les quatre hôtes et leurs règles. Deux détails cassent tout si
on les rate, et je préfère que tu les vérifies plutôt que tu me croies :

- **pas de barre oblique finale sur les `proxy_pass`** : le service temps réel
  écoute `/rt/ws` et Odoo attend `/api/v1/...` — les préfixes doivent arriver
  intacts ;
- **les en-têtes d'Upgrade sur `/rt/`**, sinon aucun WebSocket ne s'établit, et
  un délai de lecture long : une course dure plus qu'un défaut nginx.

**Le fichier `.env`** : `BABANA_DOMAIN=babana.dev`, `NODE_ENV=production`,
`S3_PUBLIC_ENDPOINT=https://storage.babana.dev`, et des **secrets générés** —
jamais les valeurs de `.env.example`, qui sont publiques puisque le dépôt l'est.
Ce fichier ne doit jamais être commité.

**Le bundle web** se construit sur l'hôte et nginx le sert. Il a besoin de
`BABANA_MAPS_SEARCH_URL` au build : en recette, l'adresse publique du simulateur
de recherche, pas `localhost` — un navigateur distant ne résout pas ta boucle
locale. C'est exactement le défaut du 13 septembre (§9 sexies de l'architecture),
transposé : une variable de build qui pointe là où le navigateur ne va pas.

**Les ports.** Ce VPS héberge déjà sept piles, dont cinq Odoo. **8069 est pris**
par `ecobrique_odoo_web`, publié sur `0.0.0.0`. Le §4 du document donne une plage
dédiée (187xx) et ne publie que ce dont nginx a besoin — PostgreSQL, Redis, la
console MinIO, Mailpit et le simulateur d'identité n'ont aucune raison d'être
joignables depuis l'hôte. Vérifie quand même (`ss -ltnp`) avant de démarrer.

**Le nom de projet Compose.** Le `Makefile` n'en pose aucun : Compose déduirait
`code`, du nom du répertoire. Un nom générique sur une machine qui héberge sept
clients, avec `make reset` qui exécute `docker compose down -v`. Le fichier de
surcharge pose `name: babana-dev`. **N'utilise aucune cible `make` sur cette
machine** — elles n'incluent pas la surcharge, donc ni le bon nom de projet ni
les bons ports. La commande complète, avec ses trois `-f`, ou rien.

## Ce que je veux vérifié, dans cet ordre

Chacun correspond à un défaut que ce projet a réellement rencontré. Ne coche rien
que tu n'aies pas exécuté.

1. Depuis une adresse hors liste : `https://babana.dev/` renvoie **403**.
2. Depuis mon adresse : la page se charge et la connexion simulée aboutit.
3. `https://admin.babana.dev` : le compte `admin` ouvre un écran Babana **sans
   erreur d'accès**. C'est le premier passage réel de ce chemin (le correctif
   date du 23 septembre, jamais éprouvé ailleurs que sur une machine de
   développement).
4. Un dossier chauffeur au back-office : **« Voir la pièce » affiche le
   document**. C'est la route `storage.` et la signature S3 ; si tu obtiens
   `SignatureDoesNotMatch`, regarde d'abord l'en-tête `Host` transmis et la
   valeur de `S3_PUBLIC_ENDPOINT`.
5. Une course de démonstration : facture présente, état d'envoi lisible.
6. `https://storage.babana.dev/` sans URL signée : refusé. Et **aucune console
   MinIO joignable** — le port 9001 ne doit apparaître dans aucune route.
7. Depuis l'extérieur du VPS : `nc -zv babana.dev 5432` et `6379` **échouent**.
   Si l'un répond, la surcharge n'a pas été prise, et c'est bloquant.

## Protocole

**Ne modifie aucun fichier de `amoa/`** — c'est de la maîtrise d'ouvrage, en
lecture seule pour toi. Si une instruction de ce prompt ou du document de recette
se révèle fausse une fois sur la machine, **dis-le plutôt que de l'arranger en
silence** : dépose la remarque dans `amoa/questions/RECETTE-babana-dev.md`, c'est
la seule exception.

Vérifie dans le dépôt plutôt que dans ce prompt. J'écris depuis une machine qui
n'est pas celle-ci, et j'ai déjà eu tort deux fois en nommant un fichier de
mémoire.

## Rapport

`amoa/rapport-recette-babana-dev.md` : ce que tu as posé, ce que tu as vérifié
avec le résultat réel de chaque point ci-dessus, et surtout **ce qui t'a
surpris**. Une recette sur une vraie machine sert d'abord à ça.

Et la question habituelle : **qu'est-ce qui te laisse un doute pour quelqu'un de
réel ?**
```

---

## Après le déploiement

Ce qu'une recette réussie apprend et qui vaudra pour `babana.cm` : les certificats, le
comportement des proxys, les origines croisées, les URL signées derrière un frontal. Ce sont les
mêmes mécanismes, et ce sont eux qui surprennent.

Ce qu'elle n'apprendra pas : tout ce qui touche un vrai fournisseur, et les trois scripts de
production (`deploy.sh`, `bootstrap.sh`, `rollback.sh`) qu'elle n'emprunte pas.
