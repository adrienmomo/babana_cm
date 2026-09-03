# Écart — l'URL signée des documents pointe vers un nom Docker interne, injoignable de tout navigateur (3 septembre 2026)

Trouvé en vérifiant D63 à l'écran, pas contourné en silence.

## Constaté

`services/storage.py::generate_signed_url()` construit son client S3 avec `S3_ENDPOINT`
(`http://minio:9000`, `infra/compose.yaml`). C'est le nom du service dans le réseau Docker
interne — documenté comme tel dans `code/docs/operations/configuration.md`
(`INTERNAL_TOPOLOGY_NAMES`, « jamais dans `.env.example` »). Cette même URL est renvoyée telle
quelle au navigateur qui clique sur « Voir la pièce » (`babana_driver_document.py::action_preview`,
`ir.actions.act_url`) et à l'appelant de `GET /api/v1/driver/documents/<id>/url`.

Ce soir : `make seed` téléverse enfin de vrais documents (D63), le bouton « Voir la pièce » du
formulaire chauffeur a donc, pour la première fois, un objet réel derrière lui. En cliquant
dessus dans un navigateur (Chrome, hors du réseau Docker), le nouvel onglet ne charge rien —
`minio` ne se résout nulle part en dehors du réseau `docker compose` (vérifié : `ping minio`
échoue sur cette machine, aucune entrée dans `/etc/hosts`).

Ce n'est pas un défaut de contenu ni de droits — vérifié avec `curl --resolve minio:9000:127.0.0.1`
(force la résolution DNS sans changer l'en-tête `Host` envoyé) : la requête signée aboutit,
`200`, le PDF téléchargé est correct. Le problème est uniquement l'hôte inscrit dans l'URL
signée, injoignable pour quiconque n'est pas à l'intérieur du réseau Docker.

**Ça ne se limite pas au poste de développement.** `infra/compose.yaml` (le fichier de base,
utilisé aussi bien par `make up` que par `deploy.sh` en production) ne publie aucun port pour
`minio`, et `infra/caddy/Caddyfile` ne proxifie rien vers lui. En production comme ce soir, l'URL
signée renvoyée pointerait vers `http://minio:9000` -- inatteignable depuis l'extérieur du VPS.
**L'écran où un gestionnaire vérifie un permis avant d'approuver un chauffeur (L6-15/L9-01) ne
fonctionnerait pas le premier jour**, et rien dans les suites automatisées ne le voit :
`test_documents.py` appelle `generate_signed_url()` depuis l'intérieur du conteneur Odoo, où
`minio` se résout -- exactement le point 9 de la définition de fini (« aucun test ne voit un
écran »), découvert cette fois sur une dépendance externe plutôt que sur un rendu React.

## Ce que ça ne permet pas de vérifier ce soir

Le critère « un permis affiché à l'écran, vu de mes yeux » a été satisfait par un contournement
ponctuel (client boto3 pointé à la main sur `http://localhost:9000`, publié par
`compose.dev.yaml` en développement seulement, pour signer une URL de vérification jetable) --
pas par le bouton « Voir la pièce » tel qu'il fonctionne aujourd'hui pour un utilisateur réel.

## Proposition

Séparer l'hôte utilisé pour écrire (serveur, réseau interne) de l'hôte utilisé pour signer une
URL destinée à un navigateur (public). Deux options :

**A. Un `S3_PUBLIC_ENDPOINT` distinct, utilisé uniquement par `generate_signed_url()`** --
`_client()` (upload) garde `S3_ENDPOINT` interne. En développement,
`S3_PUBLIC_ENDPOINT=http://localhost:9000` (le port déjà publié par `compose.dev.yaml`, aucun
changement réseau). En production, ça suppose une route Caddy vers `minio:9000` -- MinIO
n'expose alors que l'API S3 (jamais la console `:9001`), et la sécurité reste portée par la
signature + le TTL de l'URL, exactement le modèle déjà écrit dans `services/storage.py`
(« aucun objet n'est public [...] toute lecture passe par une URL signée à durée limitée ») --
pas par une liste d'adresses comme `admin.` ou `WEB_ALLOWED_IPS`, puisque chauffeurs et clients
doivent l'atteindre depuis n'importe quel réseau mobile.

**B. Migrer le stockage documents vers un vrai fournisseur S3 externe**, comme les sauvegardes
(D62) le font déjà pour un autre motif. Change moins la surface de sécurité (rien à exposer
depuis le VPS), mais touche D16-D19 plus largement et double l'infrastructure de stockage à
maintenir (MinIO resterait pour autre chose, ou disparaîtrait -- à trancher).

Je recommande A : c'est la plomberie manquante d'une conception déjà correcte, pas un changement
de conception. Mais ouvrir une route publique vers MinIO sur le VPS est une décision de surface
réseau (même famille que D16-D19) -- je ne l'implémente pas ce soir sans arbitrage, seulement le
constat et le sens du correctif.
