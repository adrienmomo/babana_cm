# Environnements et secrets

Trois environnements partagent la même pile Docker Compose (D18) : développement (`localhost`),
recette (`staging.babana.cm`), production (`babana.cm`). Ce qui change entre eux n'est jamais le
code ni la configuration Docker, seulement les valeurs de `infra/env/.env` — un fichier qui
n'est **jamais** suivi par git (`.gitignore`), copié une fois depuis `.env.example` puis rempli
à la main (développement) ou injecté par la plateforme d'hébergement (recette, production).

**Règle sans exception (invariant 5) :** aucun secret réel dans le dépôt. `.env.example` porte
des valeurs de développement fonctionnelles pour les variables non secrètes, et des valeurs
manifestement factices (`dev-only-not-a-real-secret`) pour les secrets — jamais une vraie clé,
même désactivée ou de test.

**Exception : les adresses de fournisseur externe n'ont pas de valeur dans `.env.example`**
(D43 retournée, `amoa/questions/REPONSES-2026-09-06.md` §2). `GOOGLE_JWKS_URL`,
`GOOGLE_ROUTING_URL`, `SMTP_HOST`, `SMTP_PORT` y sont **vides** ; `BABANA_MAPS_SEARCH_URL` aussi.
`S3_PUBLIC_ENDPOINT` (D64, 16 septembre) rejoint la liste pour le même motif : c'est une
destination, jamais un réglage — voir la ligne dédiée dans la table plus bas.
La valeur de développement (vers les simulateurs `L0-08`, vers `mailpit`) est posée
explicitement — par `infra/compose.dev.yaml` pour ce qu'Odoo consomme, par les cibles `make
client` / `make client-web` pour ce qui est lu au build. Motif : une mise en production qui
recopie `.env.example` ne doit jamais hériter d'une adresse de simulateur. `mailpit` en
particulier accepte une facture, la garde, et ne signale rien — une panne d'envoi invisible.
`infra/production/deploy.sh` refuse de déployer si l'une de ces variables est vide ou pointe
vers un simulateur.

**Variante inverse depuis le 26 septembre (D75, `amoa/01-architecture.md` §9 septdecies) :
`GOOGLE_JWKS_URL_MOCK`.** Toutes les variables ci-dessus doivent finir par recevoir une vraie
adresse en production — vides, elles bloquent le déploiement. `GOOGLE_JWKS_URL_MOCK` est
l'exception inverse : elle doit rester **absente** en production, et `deploy.sh` bloque si elle
est renseignée, quelle que soit la valeur. Elle porte l'adresse du jeu de clés JWKS de
`mock-google-identity` (L0-08), acceptée en plus de la vraie adresse Google que porte
`GOOGLE_JWKS_URL` — `google_identity.py` route vers l'une ou l'autre d'après l'émetteur (`iss`)
déclaré par le jeton. C'est ce qui permet à une démonstration de montrer une vraie connexion
Google à l'écran et des chauffeurs simulés qui bougent en même temps, sans plus jamais éditer un
fichier suivi pour y arriver.

**Même exception étendue le 14 septembre à `BABANA_API_URL`/`BABANA_REALTIME_WS_URL` (D61,
`amoa/questions/REPONSES-2026-09-14.md` §3)** : ces deux-là portaient jusque-là un repli codé en
dur vers le domaine de production réel (`api.babana.cm`) directement dans `apps/*/config.ts`, au
motif qu'un repli *juste* ne pouvait pas faire de mal. C'est l'inverse : un binaire construit
sans ces variables (un oubli sur `make client`, un futur build de recette) parlait quand même à
la vraie production, sans qu'aucun contrôle ne le signale — une adresse plausible se croit, une
adresse absente se voit. `make client` / `make driver` posent désormais la valeur locale
(`https://api.localhost`, `wss://api.localhost/rt/ws`) ; un build de production doit la poser
lui-même. `apps/*/config.ts` lève au lieu de deviner.

**En production, les secrets viennent d'un gestionnaire de secrets ou des variables
d'environnement de la plateforme d'hébergement, jamais d'un fichier déposé au hasard.** Ceci dit,
corrigé le 13 septembre (L0-10) — L0-07 a tranché différemment de ce que cette section annonçait
avant : `infra/production/deploy.sh` lit bien `infra/env/.env` sur le serveur, comme en
développement (D18, VPS unique, un seul mécanisme de configuration dans les trois
environnements) ; ce fichier n'est simplement jamais suivi par git, et sa valeur de production
vient du gestionnaire de secrets au moment de le renseigner sur l'hôte, pas d'une injection
directe dans l'environnement du conteneur au démarrage. Documenté en détail dans
`docs/operations/configuration.md` et `docs/operations/production.md` (étape 5).

---

## Table des variables

| Variable | Rôle | Format | Développement | Origine en production |
|---|---|---|---|---|
| `BABANA_DOMAIN` | Domaine racine, détermine les trois hôtes servis par Caddy | nom de domaine | `localhost` | `staging.babana.cm` (recette) ou `babana.cm` (production) |
| `ACME_EMAIL` | Contact du certificat TLS (Let's Encrypt) | adresse email | `dev@example.invalid` | Adresse de l'équipe technique, surveillée |
| `ADMIN_ALLOWED_IPS` | Plage IP autorisée sur `admin.` (back-office) | CIDR, séparés par des virgules | `0.0.0.0/0` (ouvert) | Adresses du bureau / VPN de l'équipe |
| `WEB_ALLOWED_IPS` | Plage IP autorisée sur le domaine principal — bundle web du Client + `/api/*`, `/rt/*`, `/s/*` proxifiés sous la même origine (D46, L6-18). Ferme la démonstration tant que les habilitations (L8-01/L8-02) n'existent pas ; distincte d'`ADMIN_ALLOWED_IPS` pour ouvrir la démo sans ouvrir le back-office | CIDR, séparés par des virgules | `0.0.0.0/0` (ouvert) | Adresses du client pilote + de l'équipe ; s'ouvre à `0.0.0.0/0` quand L8-01/L8-02 sont en place |
| `NODE_ENV` | Bascule dev/production des services Node ; garde-fou des mocks (D19) | `development` \| `production` \| `test` | `development` | `production` |
| `POSTGRES_USER` | Utilisateur PostgreSQL | texte | `odoo` | Choisi à la création de l'instance, sans droits superutilisateur superflus |
| `POSTGRES_PASSWORD` | Mot de passe PostgreSQL | texte, secret | `dev-only-not-a-real-secret` | Généré aléatoirement, stocké dans le gestionnaire de secrets |
| `ADMIN_PASSWORD` | Mot de passe du compte administrateur Odoo (`admin`), posé à l'installation du module babana (constat du 11 septembre — `amoa/questions/REPONSES-2026-09-11.md` §1). Lue aussi par des outils hôte (`test/concurrency/helpers/odoo-session.ts`), donc pas d'exception D43 : la valeur de développement vit dans `.env.example`, pas seulement dans `infra/compose.dev.yaml` | texte, secret | `dev-only-not-a-real-secret` | Généré aléatoirement, gestionnaire de secrets — explicite, aucun repli (`_post_init_admin_password` lève, `deploy.sh` bloque une valeur vide ou recopiée du développement) |
| `GOOGLE_OAUTH_CLIENT_IDS` | Audiences (`aud`) de jeton acceptées, un ou plusieurs identifiants clients OAuth séparés par des virgules (Android, iOS, Web) | liste `xxx.apps.googleusercontent.com` | `dev-client-id.apps.googleusercontent.com` | Console Google Cloud, écran de consentement OAuth du projet babana.cm |
| `GOOGLE_JWKS_URL` | URL du jeu de clés servant à vérifier la signature d'un jeton dont l'émetteur (`iss`) est le vrai Google (D75) | URL | **vide** dans `.env.example` ; `infra/compose.dev.yaml` pose `http://mock-google-identity:4000/.well-known/jwks.json` par défaut, remplaçable par la vraie adresse dans `.env` pour tester une vraie connexion Google en développement | `https://www.googleapis.com/oauth2/v3/certs` — explicite, aucun repli (`_jwks_url_for_issuer` lève, `deploy.sh` bloque) |
| `GOOGLE_JWKS_URL_MOCK` | URL du jeu de clés JWKS de `mock-google-identity` (L0-08, D75) — routée quand l'émetteur du jeton est le simulateur, coexiste avec `GOOGLE_JWKS_URL` | URL | **absente** dans `.env.example` ; `infra/compose.dev.yaml` la pose systématiquement (adresse fixe du simulateur, rien à choisir) | **absente** — exception inverse : sa seule présence bloque `deploy.sh` (D75), aucune valeur n'est jamais correcte en production |
| `JWT_SECRET` | Signe les jetons applicatifs (accessToken de C-01) | texte, secret, haute entropie | `dev-only-not-a-real-secret` | Généré aléatoirement (256 bits), gestionnaire de secrets |
| `REALTIME_SHARED_SECRET` | Authentifie les appels du service temps réel vers Odoo | texte, secret, haute entropie | `dev-only-not-a-real-secret` | Généré aléatoirement, distinct de `JWT_SECRET` |
| `MINIO_ROOT_USER` | Identifiant racine MinIO / S3 | texte | `babana-dev` | Généré à la création de l'instance |
| `MINIO_ROOT_PASSWORD` | Mot de passe racine MinIO / S3 | texte, secret | `dev-only-not-a-real-secret` | Généré aléatoirement, gestionnaire de secrets |
| `S3_PUBLIC_ENDPOINT` | Point d'entrée PUBLIC du stockage (D64) -- utilisé pour SIGNER une URL destinée à un navigateur, distinct de `S3_ENDPOINT` (nom de service Docker interne, jamais dans cette table -- voir plus bas) | URL | **vide** dans `.env.example` ; `infra/compose.dev.yaml` pose `http://localhost:9000` (port MinIO déjà publié à l'hôte) | `https://storage.babana.cm` (Caddy, API S3 uniquement, jamais la console) -- explicite, aucun repli (`generate_signed_url()` lève, `deploy.sh` bloque une valeur vide ou interne) |
| `SMTP_HOST`, `SMTP_PORT` | Adresse du relais SMTP pour l'envoi de facture (CDC §III.3) | nom d'hôte, port | **vides** dans `.env.example` ; `infra/compose.dev.yaml` pose `mailpit` / `1025` (L0-08) | Relais SMTP retenu (fournisseur à choisir) — explicite, jamais `mailpit` (`deploy.sh` bloque) ; voir l'écart ci-dessous |
| `SMTP_USER`, `SMTP_PASSWORD` | Identifiants du relais SMTP | texte, secret | vides (mailpit n'authentifie pas) | Fournisseur SMTP retenu, gestionnaire de secrets |
| `SMTP_FROM` | Adresse d'expédition des emails de facture | adresse email | `no-reply@babana.cm` | Adresse définitive du domaine `babana.cm` |
| `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` | Compte de service Firebase Cloud Messaging (API HTTP v1), notifications push | identifiants de compte de service | vides, non consommées (L1-09/L7-01 journalisent, D19) | Console Firebase du projet babana.cm, compte de service dédié aux notifications |
| `SMS_GATEWAY_API_KEY`, `SMS_GATEWAY_SENDER_ID` | Passerelle SMS pour l'OTP de rattachement de numéro | clé API, identifiant expéditeur | vides, non consommées (L1-09 journalise, D19) | Fournisseur SMS retenu (à choisir, hors de ce soir) |
| `GOOGLE_MAPS_API_KEY` | Clé API Google Maps consommée par les apps au build natif (D13) | clé API | vide, non consommée (mock-maps sert de doublure complète, D19) | Console Google Cloud, restreinte par empreinte de signature Android / bundle iOS |
| `BABANA_MAPS_SEARCH_URL` | Adresse de la recherche de lieu REST (`searchPlace`, L6-01) consommée par `apps/client` **au build** (lue de `process.env` de l'hôte, pas d'un conteneur) | URL | **vide** dans `.env.example` ; `make client` / `make client-web` posent `http://localhost:4001/search` (mock-maps, port hôte exposé) | Adresse Google réelle — explicite au build (aucun repli : `getSearchUrl()` lève) |
| `BABANA_API_URL` | Adresse de l'API pour les apps natives Client/Chauffeur (`apps/*/config.ts`), consommée **au build** | URL | **vide** dans `.env.example` ; `make client` / `make driver` posent `https://api.localhost` | Domaine réel (`https://api.babana.cm`) — explicite au build (aucun repli depuis D61 : `config.ts` lève) |
| `BABANA_REALTIME_WS_URL` | Adresse WebSocket du service temps réel pour les mêmes apps natives, même mécanisme | URL (`wss://`) | **vide** dans `.env.example` ; `make client` / `make driver` posent `wss://api.localhost/rt/ws` | Domaine réel (`wss://api.babana.cm/rt/ws`) — explicite au build (aucun repli depuis D61) |

**Ce qui n'apparaît volontairement pas dans cette table :** l'adresse de Redis
(`redis://redis:6379`) et l'URL interne d'Odoo (`http://odoo:8069`, consommée par le service
temps réel). Ces adresses sont fixées en dur dans `infra/compose.yaml`, pas dans `.env` — parce
qu'elles décrivent la topologie du réseau Docker interne, identique dans les trois
environnements par construction (D18, une seule pile compose). Les rendre configurables
ajouterait une variable qui ne varie jamais, sans bénéfice. Ce n'est pas une exception à
l'invariant 5 : l'invariant vise les adresses qui *changent* entre environnements ou les secrets
d'accès à un service tiers, pas les noms de service internes à un réseau Docker que
l'orchestration seule détermine.

---

## Rotation

Un secret dont personne ne sait comment le remplacer ne sera jamais remplacé, y compris après
une fuite. Procédure pour chacun :

**`POSTGRES_PASSWORD`** — Générer une nouvelle valeur (`openssl rand -base64 32`). Mettre à jour
le mot de passe dans PostgreSQL (`ALTER USER ... WITH PASSWORD ...`), puis la variable dans le
gestionnaire de secrets, puis relancer le service `odoo` (et `realtime` s'il devait un jour s'y
connecter directement — aujourd'hui non, invariant 1). Aucune coupure de service si fait dans cet
ordre : PostgreSQL accepte l'ancien et le nouveau mot de passe jusqu'au redémarrage d'Odoo.

**`ADMIN_PASSWORD`** — Se connecter au back-office (`admin.<domaine>`) avec l'ancien mot de
passe, changer le mot de passe du compte `admin` depuis son profil (Odoo le hache
immédiatement), puis mettre à jour la variable dans le gestionnaire de secrets pour qu'un futur
`docker compose up` ne recrée pas de divergence. Ne redéclenche pas d'installation : le
`post_init_hook` qui pose cette variable ne rejoue pas sur une base existante (D43) — c'est ici,
depuis l'interface, que la rotation se fait, pas en réinstallant le module.

**`JWT_SECRET`** — Générer une nouvelle valeur (`openssl rand -base64 32`). **Invalide tous les
jetons applicatifs en circulation** : chaque utilisateur connecté est déconnecté et doit se
reconnecter via Google Sign-In. À planifier hors heures de pointe, jamais en réaction à chaud à
une fuite sans en avoir conscience — c'est le compromis attendu de ce type de rotation.

**`REALTIME_SHARED_SECRET`** — Générer une nouvelle valeur, la déployer sur Odoo et sur le
service temps réel **dans le même déploiement** (les deux doivent changer ensemble : un secret
différent de chaque côté coupe la communication entre les deux services jusqu'à
resynchronisation).

**`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`** — Créer un nouvel utilisateur MinIO avec les mêmes
droits via `mc admin user add`, migrer les accès applicatifs vers ce nouvel utilisateur, puis
révoquer l'ancien (`mc admin user remove`). Ne jamais changer l'utilisateur racine directement
sur une instance en production sans ce détour : la racine perdue sans utilisateur de secours
rend le compartiment inaccessible.

**`SMTP_PASSWORD`** — Régénérer depuis la console du fournisseur SMTP retenu ; mettre à jour la
variable ; aucune coupure, l'ancien mot de passe reste généralement valide quelques minutes le
temps de la bascule. Sans objet en développement (mailpit n'authentifie pas).

**`FCM_PRIVATE_KEY`** — Créer une nouvelle clé de compte de service dans la console Firebase,
mettre à jour les trois variables `FCM_*` ensemble (`project_id`, `client_email`, `private_key`
forment un tout cohérent), puis révoquer l'ancienne clé dans la console.

**`SMS_GATEWAY_API_KEY`** — Régénérer depuis la console du fournisseur retenu ; mettre à jour la
variable ; révoquer l'ancienne clé une fois la nouvelle confirmée fonctionnelle (envoyer un OTP
de test).

**`GOOGLE_MAPS_API_KEY`** — Créer une nouvelle clé dans la console Google Cloud, restreinte aux
mêmes empreintes d'application, mettre à jour la variable et redéployer les apps (cette clé est
figée au build, contrairement aux autres secrets lus à l'exécution — la rotation exige donc une
nouvelle version publiée des applications, pas seulement un redémarrage de service).

**`GOOGLE_OAUTH_CLIENT_IDS`** — Ne se « tourne » pas au sens d'un secret compromis (ce ne sont
pas des secrets, l'identifiant client OAuth est public par nature) ; se régénère uniquement si un
client est recréé dans la console Google Cloud, auquel cas mettre à jour la liste et redéployer
les apps concernées.

**`ADMIN_ALLOWED_IPS` / `WEB_ALLOWED_IPS` / `ACME_EMAIL` / `BABANA_DOMAIN`** — Pas des secrets.
Mise à jour directe de la variable, sans procédure de rotation particulière au-delà de vérifier
que la nouvelle valeur est correcte avant de redémarrer Caddy. `WEB_ALLOWED_IPS` a vocation à
passer à `0.0.0.0/0` une fois les habilitations (L8-01, L8-02) en place — c'est un verrou
temporaire, pas une politique durable.

---

## Nouveau développeur, en pratique

```bash
cd code/
cp infra/env/.env.example infra/env/.env   # fait aussi automatiquement par `make up`
make up
```

Rien d'autre à renseigner. Les variables de `.env.example` ont soit une valeur de développement
fonctionnelle, soit sont vides et non consommées (FCM, SMS, Google Maps — simulées ou sans
objet, D19), soit sont vides **mais posées ailleurs pour le développement** : `GOOGLE_JWKS_URL`,
`GOOGLE_JWKS_URL_MOCK`, `GOOGLE_ROUTING_URL`, `SMTP_HOST`, `SMTP_PORT` par
`infra/compose.dev.yaml` ;
`BABANA_MAPS_SEARCH_URL`, `BABANA_API_URL`, `BABANA_REALTIME_WS_URL` par les cibles `make
client` / `make client-web` / `make driver`. C'est la contrepartie de la règle « pas d'adresse de
fournisseur dans `.env.example` » (D43 retournée, voir plus haut) : `make up` fonctionne sans
rien ajouter, mais un déploiement de production doit renseigner ces variables lui-même, vers les
vrais fournisseurs.
