# infra/production — mise en production de l'hôte (L0-07)

Scripts qui codifient la procédure en dix étapes de `amoa/04-monorepo-et-services.md` §9. Le
runbook détaillé, avec ce qui reste manuel et la frontière « fait / attend une machine », est
dans **`docs/operations/production.md`**.

| Fichier | Étape §9 | À exécuter |
|---|---|---|
| `bootstrap.sh` | 2, 3 | UNE fois, en root, sur le VPS neuf (durcissement SSH, pare-feu, MAJ auto) |
| `deploy.sh` | 5, 6 | sur l'hôte durci, à chaque déploiement (compose.yaml seul, build web, module Odoo, smoke-test, enregistre le commit) |
| `rollback.sh` | 10 | sur l'hôte, retour au commit précédent (ne restaure pas la base) |
| `backup.sh` | 7 | en cron sur l'hôte : dump PG + miroir MinIO + `.env` chiffré → stockage **externe** |
| `restore.sh` | 7 | sur un hôte **vierge**, prouve que les sauvegardes sont exploitables (L8-08) |
| `monitoring/` | 8 | depuis une **autre** machine (sondes HTTP + SSH, alertes) |

## Ce qui n'est PAS ici, et pourquoi

- **Étape 1 (provisionner le VPS)** : compte hébergeur, NVMe, distribution LTS. Contabo par
  défaut ou Hetzner (§9) — Hetzner si rien ne plaide pour Contabo.
- **Étape 4 (DNS)** : enregistrements A `babana.cm`, `api.`, `admin.` (+ recette). **Propagation
  vérifiée avant `deploy.sh`** — Caddy échoue sur un nom non résolu.
- **Étape 9 (latence de référence depuis Douala)** : se mesure depuis une vraie connexion
  camerounaise. Gabarit à remplir : `docs/operations/latency-baseline.md`.
- **Secrets de production** : dans `infra/env/.env` sur l'hôte, jamais commités (invariant 5).
  Origine de chaque valeur : `infra/env/README.md`.

`.state/` (créé par `deploy.sh`) est local à l'hôte, non versionné.
