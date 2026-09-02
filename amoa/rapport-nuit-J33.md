# Rapport de nuit — J33

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition
de fini). Lu en entier : `CLAUDE.md`, `amoa/questions/REPONSES-2026-09-09.md`, la spécification
L9 (`amoa/specs/L9-backoffice.md`), le rapport J32, `services/realtime_client.py`,
`driver/cash-guard.ts` et son test, `pool-eligibility.lua`, `ws/dispatch.ts`, `babana_driver.py`,
`controllers/documents.py`, `controllers/auth.py::_build_user_payload`,
`security/babana_record_rules.xml`.

Périmètre confié :

1. **Le câblage suspension → temps réel** — et le troisième cas (rejet, réactivation).
2. **L9-01 à L9-03** — back-office superviseur : validation des dossiers, suivi des courses.

Un commit par tâche.

---

## 1. Câblage suspension / rejet / réactivation → service temps réel

### Le trou (seconde revue J32)

`action_suspend` force `is_online = False` **côté Odoo** et révoque les jetons — mais rien ne
prévenait le service temps réel. Le chauffeur suspendu restait dans le vivier géo-indexé (Redis,
indépendant d'`is_online`) et continuait de recevoir des propositions jusqu'à l'expiration de sa
dernière position.

### Le patron appliqué, pas réinventé

`notify_cash_limit_reached` (L5-02) existait pour le franchissement de plafond : appel **au
commit** (D32), **hors savepoint** (D33), qui **notifie sans transitionner** (D31), posant une
clé Redis lue par le script d'éligibilité **et** par la résolution d'acceptation. Deux points de
blocage, tous deux obligatoires. C'est ce patron qui a été étendu au cas voisin.

### Le troisième cas

Toute transition d'état qui rend un chauffeur indisponible a le même besoin :

| Transition | Appel | Effet temps réel |
|---|---|---|
| suspension (`approved → suspended`) | `notify_driver_unavailable` | pose la clé, retire du vivier, refuse l'acceptation en vol |
| rejet (`* → rejected`) | `notify_driver_unavailable` | idem |
| réactivation (`suspended → approved`) | `notify_driver_available` | **lève** la clé, **sans réintégrer** au vivier |
| approbation d'une candidature (`* → approved`) | `notify_driver_available` | lève la clé (sans effet si aucune n'était posée) |

La réactivation est le **cas symétrique, pas l'inverse exact** : elle lève le blocage mais ne
remet pas le chauffeur dans le vivier — il se redéclare en ligne lui-même (D7). C'est la seule
différence avec `cash-unblocked`, qui, lui, appelle `reintegrateIfEligible`.

### Où vit le câblage

Dans `babana.driver.write()`, à côté du forçage `is_online = False` déjà présent — même raison
(couvrir aussi une écriture directe de `state`, défense en profondeur), même endroit du code.
Un seul point plutôt qu'un appel dans chaque `action_*`.

### Ce qui a été ajouté

**Côté Odoo** (`services/realtime_client.py`) :
- `notify_driver_unavailable(env, *, driver_public_id)` → `POST /internal/drivers/unavailable` ;
- `notify_driver_available(env, *, driver_public_id)` → `POST /internal/drivers/available` ;
- ajoutées à `GATED_CALLS` du lint D32/D33 (`test_realtime_commit_hook.py`).

**Côté temps réel** :
- `driver/admin-hold.ts` — `holdDriver` / `releaseHold` / `isOnAdminHold`, patron de
  `driver/cash-guard.ts` ;
- `driver/keys.ts` — `adminHoldKey` → `babana:driver:admin-hold:<id>`, sans TTL ;
- `redis/pool-eligibility.lua` + `.ts` — cinquième `EXISTS` (lecture seule, D26 intacte) ;
- `ws/dispatch.ts` — `isOnAdminHold` avant de résoudre un `proposal.accept`, traité comme un
  refus explicite (le client reçoit `ride.rejected`, jamais un silence) ;
- `http/internal.ts` — deux routes. `/available` n'appelle **pas** `reintegrateIfEligible`,
  contrairement à `/cash-unblocked` — commenté sur place.

### Tests

- `services/realtime/test/admin-hold.test.ts` (nouveau, jumeau de `cash-guard.test.ts`, Redis
  réel) : retrait du vivier, levée sans réintégration, non-réinsertion malgré une position
  émise, `proposal.accept` d'un chauffeur non habilité traité comme un refus.
- `services/realtime/test/internal.test.ts` : les deux routes (`held` / `released`), et
  l'asymétrie avec `cash-unblocked` explicitement asserée (pas de réintégration).
- `test_realtime_commit_hook.py` : point d'accroche au commit pour les deux appels (patch
  `_post`) + **canal réel** contre le vrai service temps réel et le vrai Redis
  (`notify_driver_unavailable` pose / ne pose pas la clé selon commit / rollback).
- `test_driver_approval.py` : `action_suspend` / `action_reject` / `action_reactivate` et une
  écriture directe de `state` déclenchent le bon appel avec le bon `public_id` ; la
  réactivation appelle `notify_driver_available` et **jamais** `notify_driver_unavailable`.

`services/realtime` : 213 tests verts, `tsc --noEmit` propre.
Suite Odoo ciblée (`TestDriverApproval`, `TestRealtimeCommitHook*`) : 0 échec, canal réel
compris (conteneur `realtime` reconstruit).

### Écart déposé

`amoa/questions/J33-suspend-realtime-wiring.md` (sur master) — propose **D56** (la
non-habilitation d'un dossier est un état temps réel distinct, posé au commit) et soumet à
ratification l'asymétrie voulue entre `/available` et `/cash-unblocked`. Limite connue et
assumée : pas de réconciliation périodique si l'appel HTTP est perdu (best-effort, comme
l'encaisse) — filets décrits dans l'écart, pire cas ~60 s de visibilité résiduelle.

### Invariants

1 (aucune écriture par tick) : intact — ces appels ne portent aucune donnée durable. 2
(transitions seules portes d'écriture) : intact — D31, on notifie, on ne transitionne rien. 3
(aucune règle métier dans les apps) : intact — Odoo décide, le service temps réel applique. 4
(réservation atomique) : intact — le cinquième `EXISTS` est en lecture seule, un seul écrivain
sur le pool. 5 (aucune config en dur) : intact — pas de nouvelle valeur.
