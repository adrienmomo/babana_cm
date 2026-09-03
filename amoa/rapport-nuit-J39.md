# Rapport de nuit — J39

Tenu au fil de l'eau, une entrée par tâche finie. Lu en entier : `CLAUDE.md` (corollaire du
point 9 précisé, D62 ajouté), `amoa/questions/REPONSES-2026-09-15.md`,
`services/odoo/scripts/seed.py`, `services/odoo/addons/babana/services/storage.py`,
`services/odoo/addons/babana/models/babana_driver_document.py`,
`services/odoo/addons/babana/controllers/documents.py`,
`services/odoo/addons/babana/views/babana_driver_views.xml`,
`infra/production/backup.sh`, `infra/production/restore.sh`, `infra/production/bootstrap.sh`,
`docs/operations/production.md`.

Périmètre confié : D63 (images de démonstration), D62/critère 6 de L8-08 (`restore.sh` exécuté
comme script), critère 7 de L8-08 (`bootstrap.sh` installe `age`/`rclone`).

---

## 1. D63 — le semis téléverse enfin de vrais documents, et ça a débusqué un défaut plus grave derrière

### Le défaut de départ

`services/odoo/scripts/seed.py::ensure_fleet()` créait deux `babana.driver.document` par
chauffeur avec `storage_key = "seed/<sub>/<type>.jpg"` — jamais suivi d'un objet réellement
déposé dans MinIO. Pas une occurrence isolée (celle trouvée hier soir, chauffeur 440) : **la
totalité** du jeu de données. L'écran où un gestionnaire regarde un permis avant d'approuver un
dossier (L6-15/L9-01) n'avait jamais été vu avec une image.

### Le correctif

`build_demo_document_pdf()` (nouveau, dans `seed.py`) construit un PDF minimal à la main — pas
de bibliothèque : un fichier PDF est un format texte, la génération d'une page avec deux blocs de
texte (Helvetica/Helvetica-Bold, polices standard, aucune à embarquer) ne justifie pas Pillow
comme dépendance nouvelle (CLAUDE.md, « pas de dépendance nouvelle sans nécessité »). Contenu :
« DOCUMENT DE DÉMONSTRATION » en toutes lettres, le nom du chauffeur, le type de pièce
(`Permis de conduire` / `Pièce d'identité`, repris de `DOCUMENT_TYPES` — jamais redupliqué), une
ligne de bas de page. Encodage WinAnsi : couvre les accents des noms de chauffeurs (Cédric
Ewané, Emmanuel Ndoumbè…).

**Choix d'implémentation à signaler** : un PDF, pas un JPEG/PNG. `action_preview()`
(`babana_driver_document.py`) ouvre la pièce dans un nouvel onglet via une URL signée
(`ir.actions.act_url`, `target: new`) — le navigateur rend un PDF nativement, sans code
supplémentaire à écrire. Produire une image matricielle à la main (sans Pillow) aurait demandé
une police bitmap et un encodeur PNG écrits pour l'occasion — largement hors de proportion avec
ce que la tâche demande. Je le signale explicitement parce que la consigne disait « image » :
si un usage futur exige un format raster (miniature intégrée dans une liste, par exemple), il
faudra revenir dessus — rien aujourd'hui ne le demande.

`ensure_fleet()` téléverse chaque PDF via `storage.upload()` — le même chemin que
`POST /api/v1/driver/documents` (le contrôleur applicatif), jamais un appel direct au client S3
qui contournerait la couche que le reste du système utilise. `mime_type` posé à
`application/pdf` (plus `image/jpeg`, qui ne correspondait plus à rien). Idempotent comme le
reste du fichier : rejoué, `ensure_fleet()` ne re-crée ni ne re-téléverse rien (`exists` gardé
avant l'upload).

### Vérifié dans le vrai back-office (point 9)

`make reset && make up && make seed` sur base fraîche. `mc ls --recursive
local/babana-documents` : dix objets `.pdf`, un permis et une pièce d'identité par chauffeur,
958–967 octets chacun. Formulaire chauffeur (Emmanuel Ndoumbè) ouvert dans un vrai navigateur
(Chrome, authentifié `admin`), onglet « Documents » : les deux lignes, `Vérifié`, `Permis de
conduire` avec sa date d'expiration, bouton « Voir la pièce » sur chacune. Rendu du permis
confirmé — voir le défaut ci-dessous pour le chemin réellement emprunté.

### Un défaut plus grave, trouvé en ouvrant l'écran, pas en le peuplant

En cliquant sur « Voir la pièce » dans un navigateur **hors du réseau Docker**, l'onglet ne
charge rien : l'URL signée renvoyée pointe vers `http://minio:9000` — le nom du service MinIO
dans le réseau interne `docker compose`, injoignable depuis n'importe quel navigateur en dehors
de ce réseau. Vérifié que ce n'est ni un défaut de contenu ni de droits
(`curl --resolve minio:9000:127.0.0.1 …` aboutit, `200`, PDF correct) : uniquement l'hôte inscrit
dans l'URL signée. **Cela ne se limite pas à cette machine de développement** — `infra/compose.yaml`
(le fichier de base, utilisé aussi par `deploy.sh` en production) ne publie aucun port MinIO et
`Caddyfile` ne le proxifie nulle part : en production comme ce soir, le même bouton renverrait
une URL inatteignable depuis l'extérieur du VPS. Écart déposé :
`amoa/questions/L1-05-signed-url-unreachable.md`.

Le critère « un permis affiché à l'écran, vu de mes yeux » a quand même été satisfait ce soir —
par un contournement ponctuel, jamais commité : un client boto3 signé à la main contre
`http://localhost:9000` (le port déjà publié par `compose.dev.yaml` en développement), ouvert
dans Chrome. Rendu confirmé : « DOCUMENT DE DÉMONSTRATION », « Emmanuel Ndoumbè », « Permis de
conduire », le pied de page — net, lisible, sans ambiguïté avec une vraie pièce. Mais ce n'est
**pas** le chemin que le bouton réel emprunte aujourd'hui pour un utilisateur qui n'est pas à
l'intérieur du réseau Docker — l'écart le dit sans détour.

### Tests

Aucun test automatisé nouveau : `seed.py` est un script d'exploitation (`code/docs`, même famille
que `backup.sh`), pas un module testé par `make test` — cohérent avec le traitement déjà réservé
à ce fichier. Vérifié à la place : exécution réelle sur base fraîche (ci-dessus), `mc ls` contre
le vrai bucket, ouverture réelle de l'écran. `make test` complet lancé en fin de nuit (§4) —
aucune régression introduite par ce changement.

