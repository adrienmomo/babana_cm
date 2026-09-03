# Rapport de nuit — J40

Tenu au fil de l'eau, une entrée par tâche finie. Lu en entier : `CLAUDE.md`,
`amoa/questions/REPONSES-2026-09-16.md`, `amoa/01-architecture.md` §9 octies,
`amoa/specs/L1-identite.md` (L1-05), `services/odoo/addons/babana/services/storage.py`,
`services/odoo/addons/babana/controllers/documents.py`, `infra/compose.yaml`,
`infra/compose.dev.yaml`, `infra/caddy/Caddyfile`, `infra/env/{.env.example,README.md}`,
`docs/operations/configuration.md`, `tools/config-coherence/{scan,variables}.ts`.

Périmètre confié : D64 (point d'entrée public du stockage), D61 étendue (le repli de
`share.py`, et le reste du même défaut), L3-14 (test de résilience).

---

## 1. D64 — le point d'entrée public du stockage

### Le correctif

Un `S3_PUBLIC_ENDPOINT` distinct de `S3_ENDPOINT`, protocole des trois moments (D59) comme
`GOOGLE_JWKS_URL` : vide dans `.env.example`, posé par `infra/compose.dev.yaml`
(`http://localhost:9000`, le port MinIO déjà publié à l'hôte), aucun repli côté Odoo
(`os.environ["S3_PUBLIC_ENDPOINT"]`, jamais `.get(..., ...)`). `services/storage.py::
_public_client()` (nouveau) construit un second client boto3 dessus ; `generate_signed_url()`
l'utilise désormais — `upload()` continue d'écrire par `_client()`/`S3_ENDPOINT`, inchangé.
SigV4 signe l'en-tête `Host` : c'est cet endpoint, pas celui d'écriture, qui doit apparaître
dans l'URL renvoyée à un navigateur.

Côté Caddy, une route publique dédiée (`storage.{$BABANA_DOMAIN}`) qui ne proxifie que le port
S3 de MinIO (9000) — le port 9001 (console) n'apparaît nulle part dans le Caddyfile, donc
inatteignable par construction depuis l'extérieur (critère 7). Ouverte, sans liste d'adresses
(contrairement à `admin.`) : un chauffeur doit joindre ses propres pièces depuis n'importe quel
réseau mobile, la sécurité reste portée par la signature et son TTL (5 minutes par défaut),
jamais par l'origine de l'appelant.

`infra/production/deploy.sh` refuse de partir si `S3_PUBLIC_ENDPOINT` est vide ou pointe vers
`minio`/`localhost` — même discipline que les autres adresses de fournisseur externe.

### Vérifié depuis l'extérieur de tout conteneur (critère 6, la frontière qui manquait)

`test/storage/public-entrypoint.test.ts` (nouveau, dans la suite principale de `test/`, jamais
isolé — il ne touche aucun service partagé) : signe-in réel, téléversement réel, `GET .../url`,
puis un `fetch()` de ce processus **hôte** (celui qui lance `npm test`, jamais un conteneur) sur
l'URL renvoyée. Assertion explicite que l'hôte signé n'est jamais `minio`. Deuxième test : la
route publique interrogée en HTTPS (certificat auto-signé accepté explicitement, `node:https`
natif — aucune dépendance nouvelle), vérifie que la réponse est celle de l'API S3 (une erreur
XML), jamais la console MinIO (une page HTML) — critère 7, « vérifié par un appel qui échoue »,
au même titre que le critère 1.

**Vérifié à blanc, comme L3-13 l'exige pour ce genre de preuve** : le Caddyfile pointé
temporairement vers `minio:9001` fait échouer le test 7 (`Content-Type: text/html` reçu, la
console répond) ; remis à `minio:9000`, il repasse au vert. Le test détecte réellement ce qu'il
prétend détecter.

`services/odoo/addons/babana/tests/test_documents.py` a dû changer en miroir : ses deux tests de
mécanisme de signature (`test_signed_url_grants_access_to_the_object`,
`test_signed_url_expires`) appelaient `generate_signed_url()` **depuis l'intérieur du conteneur
Odoo**, où `S3_PUBLIC_ENDPOINT` (`http://localhost:9000` en développement) ne route vers rien —
c'est le loopback de ce conteneur, pas celui de MinIO. Exactement la frontière que D64 corrige :
les revérifier tels quels aurait reproduit le défaut du 16 septembre à l'envers. Ces deux tests
posent désormais `S3_PUBLIC_ENDPOINT = S3_ENDPOINT` pour la durée de la classe (`setUp`,
documenté) : ils prouvent le mécanisme de signature/expiration, indépendant de l'hôte visé — la
joignabilité du **vrai** point d'entrée public est prouvée ailleurs, depuis l'extérieur.

### Vérifié à l'écran, par le vrai bouton (point 9)

`make reset && make up && make seed`, back-office ouvert dans un vrai Chrome
(`http://localhost:8069/odoo`, authentifié `admin`), fiche d'Emmanuel Ndoumbè (chauffeur semé
par D63), onglet Documents, clic sur « Voir la pièce » du permis. Un nouvel onglet s'ouvre sur
`http://localhost:9000/babana-documents/seed/babana-demo-driver-1/license.pdf?X-Amz-...` — le
PDF de démonstration s'affiche, lisible, avec le nom du chauffeur. C'est le geste que J39 avait
dû contourner ; ce soir c'est le bouton lui-même.

### Tests

`test/storage/public-entrypoint.test.ts` (2 tests, nouveau), suite Odoo `test_documents.py`
inchangée en nombre (18 tests, 0 échec après le correctif ci-dessus), `infra/smoke-test.sh` :
nouvelle ligne (console jamais servie par la route publique). `make test` complet en fin de nuit
(voir la dernière entrée de ce rapport pour les chiffres consolidés).

---

## 2. D61 étendue — le repli de `share.py`, et le reste du même défaut

### Le correctif signalé hier

`controllers/share.py::_share_base_url()` : `os.environ['BABANA_DOMAIN']`, plus de
`.get(..., 'babana.cm')`.

### Ce que le balayage a trouvé derrière — deux maillons de plus

**En cherchant *pourquoi* ce repli s'exécutait** (pas seulement en le supprimant) :
`infra/compose.yaml` ne délivrait `BABANA_DOMAIN` **qu'au service `caddy`**, jamais au conteneur
`odoo` qui exécute `share.py`. Ce n'était donc pas un filet de sécurité pour un cas rare — c'était
le SEUL chemin qui ait jamais existé : chaque lien de partage de trajet, dans tous les
environnements, portait `babana.cm` en dur, jamais la valeur réelle. Un déploiement de recette
(`staging.babana.cm`) aurait toujours envoyé des liens vers la production. Corrigé en délivrant
`BABANA_DOMAIN` à `odoo` comme à `caddy` (`infra/compose.yaml`).

**Troisième cas, hors de l'application** : `infra/production/monitoring/probe.sh` posait
`DOMAIN="${DOMAIN:-babana.cm}"` — une sonde de supervision externe qui, lancée sans son
paramètre pour surveiller la recette, surveillerait silencieusement la production à la place.
Son propre voisin, `probe-host.sh`, avait déjà la bonne discipline pour `SSH_TARGET` (`:?`
obligatoire, aucun repli) : l'incohérence entre les deux scripts a été le signal qui a fait
chercher plus loin. Corrigé de la même façon (`: "${DOMAIN:?...}"`).

Balayé le reste du dépôt (`grep` sur les replis `||`/`.get(..., 'http...')`/`${VAR:-...}` vers
une adresse plausible, hors `test/`/`tests/` déjà exclus par convention) : rien d'autre. Trois
cas, cette nuit : `share.py`, sa propre livraison manquante, `probe.sh`.

### Tests

`test/config/config-coherence.test.ts` : `BABANA_DOMAIN` reste cohérent (déclarée, livrée deux
fois désormais — `caddy` et `odoo` —, consommée) ; aucun problème remonté. Pas de test dédié pour
`probe.sh` (script d'exploitation hors périmètre testé, même famille que `backup.sh`/
`bootstrap.sh` — `sh -n` propre). `make test` complet en fin de nuit (voir la dernière entrée de
ce rapport).
