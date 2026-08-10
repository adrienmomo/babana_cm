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

**En production, les secrets viennent d'un gestionnaire de secrets ou des variables
d'environnement de la plateforme d'hébergement, jamais d'un fichier déposé sur le serveur.**
Le fichier `infra/env/.env` qui existe en développement sur le poste d'un développeur n'a pas
d'équivalent en production : la procédure de déploiement (L0-07, hors du lot de cette nuit)
injecte les variables directement dans l'environnement du conteneur au démarrage.

---

## Table des variables

| Variable | Rôle | Format | Développement | Origine en production |
|---|---|---|---|---|
| `BABANA_DOMAIN` | Domaine racine, détermine les trois hôtes servis par Caddy | nom de domaine | `localhost` | `staging.babana.cm` (recette) ou `babana.cm` (production) |
| `ACME_EMAIL` | Contact du certificat TLS (Let's Encrypt) | adresse email | `dev@example.invalid` | Adresse de l'équipe technique, surveillée |
| `ADMIN_ALLOWED_IPS` | Plage IP autorisée sur `admin.` | CIDR, séparés par des virgules | `0.0.0.0/0` (ouvert) | Adresses du bureau / VPN de l'équipe |
| `NODE_ENV` | Bascule dev/production des services Node ; garde-fou des mocks (D19) | `development` \| `production` \| `test` | `development` | `production` |
| `POSTGRES_USER` | Utilisateur PostgreSQL | texte | `odoo` | Choisi à la création de l'instance, sans droits superutilisateur superflus |
| `POSTGRES_PASSWORD` | Mot de passe PostgreSQL | texte, secret | `dev-only-not-a-real-secret` | Généré aléatoirement, stocké dans le gestionnaire de secrets |
| `GOOGLE_OAUTH_CLIENT_IDS` | Audiences (`aud`) de jeton acceptées, un ou plusieurs identifiants clients OAuth séparés par des virgules (Android, iOS, Web) | liste `xxx.apps.googleusercontent.com` | `dev-client-id.apps.googleusercontent.com` | Console Google Cloud, écran de consentement OAuth du projet babana.cm |
| `GOOGLE_JWKS_URL` | URL du jeu de clés servant à vérifier la signature des jetons Google (D19 : seul ce qui change entre dev et prod) | URL | `http://mock-google-identity:4000/.well-known/jwks.json` | `https://www.googleapis.com/oauth2/v3/certs` (valeur par défaut si absente) |
| `JWT_SECRET` | Signe les jetons applicatifs (accessToken de C-01) | texte, secret, haute entropie | `dev-only-not-a-real-secret` | Généré aléatoirement (256 bits), gestionnaire de secrets |
| `REALTIME_SHARED_SECRET` | Authentifie les appels du service temps réel vers Odoo | texte, secret, haute entropie | `dev-only-not-a-real-secret` | Généré aléatoirement, distinct de `JWT_SECRET` |
| `MINIO_ROOT_USER` | Identifiant racine MinIO / S3 | texte | `babana-dev` | Généré à la création de l'instance |
| `MINIO_ROOT_PASSWORD` | Mot de passe racine MinIO / S3 | texte, secret | `dev-only-not-a-real-secret` | Généré aléatoirement, gestionnaire de secrets |
| `SMTP_PROD_HOST`, `SMTP_PROD_PORT`, `SMTP_PROD_USER`, `SMTP_PROD_PASSWORD`, `SMTP_PROD_FROM` | Relais SMTP réel pour l'envoi de facture (CDC §III.3) | hôte, port, identifiants, adresse d'expédition | vides, non consommées (mailpit capture tout en développement) | Fournisseur SMTP retenu (à choisir, hors de ce soir) ; voir l'écart ci-dessous |
| `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` | Compte de service Firebase Cloud Messaging (API HTTP v1), notifications push | identifiants de compte de service | vides, non consommées (L1-09/L7-01 journalisent, D19) | Console Firebase du projet babana.cm, compte de service dédié aux notifications |
| `SMS_GATEWAY_API_KEY`, `SMS_GATEWAY_SENDER_ID` | Passerelle SMS pour l'OTP de rattachement de numéro | clé API, identifiant expéditeur | vides, non consommées (L1-09 journalise, D19) | Fournisseur SMS retenu (à choisir, hors de ce soir) |
| `GOOGLE_MAPS_API_KEY` | Clé API Google Maps consommée par les apps au build natif (D13) | clé API | vide, non consommée (mock-maps sert de doublure complète, D19) | Console Google Cloud, restreinte par empreinte de signature Android / bundle iOS |

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

**`SMTP_PROD_PASSWORD`** — Régénérer depuis la console du fournisseur SMTP retenu ; mettre à
jour la variable ; aucune coupure, l'ancien mot de passe reste généralement valide quelques
minutes le temps de la bascule.

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

**`ADMIN_ALLOWED_IPS` / `ACME_EMAIL` / `BABANA_DOMAIN`** — Pas des secrets. Mise à jour directe
de la variable, sans procédure de rotation particulière au-delà de vérifier que la nouvelle
valeur est correcte avant de redémarrer Caddy.

---

## Nouveau développeur, en pratique

```bash
cd code/
cp infra/env/.env.example infra/env/.env   # fait aussi automatiquement par `make up`
make up
```

Rien d'autre à renseigner : toutes les variables ci-dessus ont soit une valeur de développement
fonctionnelle, soit sont vides et non consommées en développement (SMTP, FCM, SMS, Google Maps —
simulées ou sans objet, D19).
