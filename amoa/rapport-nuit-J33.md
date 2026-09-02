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

---

## 2. L9-01 — Vues chauffeurs (back-office)

L'écran par lequel un chauffeur entre au pilote : un gestionnaire y valide un dossier **après
avoir regardé les pièces**, et un refus y prend son motif.

### Liste

`display_name` (nouveau `_compute_display_name` : fiche employé, sinon compte de connexion,
sinon « Candidature #id » — plus jamais « babana.driver,3 »), état, en ligne, moto, note,
courses effectuées, **solde**, dernière activité (`last_ride_at`, calculé). Codes couleur :
`decoration-danger` si suspendu / plafond atteint / document expiré, `decoration-muted` si
rejeté.

### Formulaire

Boutons **Approuver / Rejeter / Suspendre** (assistant `babana.driver.decision`, qui collecte
le motif ou le choix de fiche employé — un bouton `type="object"` ne peut pas) et **Réactiver**
(direct). Onglets en lecture seule : Documents (bouton **Voir la pièce**), Moto et affectations,
Courses récentes, Mouvements de caisse (nouveaux One2many `ride_ids`, `assignment_ids`).
Bandeaux Suspendu / Rejeté / Plafond atteint.

### Aperçu des pièces (critère 3, le doute de L6-15)

`babana.driver.document.action_preview` : `search` au nom de l'appelant (D54, même patron que
`controllers/documents.py::_signed_url` — `exists()` ignorerait les règles), puis
`storage.generate_signed_url` (L1-05, TTL `babana.document_url_ttl_seconds`), renvoie une
`ir.actions.act_url target=new`. Un gestionnaire voit la pièce ; un utilisateur portail obtient
« introuvable », jamais l'URL, jamais la confirmation que la ligne existe.

### Filtres (critère 2)

Par statut (4), en ligne, **plafond atteint** (`cash_limit_reached`, compute + `search` —
`cash_balance` non stocké, balayage Python assumé à l'échelle du pilote), **documents expirant**
(domaine sur `document_ids.expires_on`, fenêtre 30 j comme la vue motos), **sans moto affectée**
(`_search_motorcycle_id` ajouté au champ calculé, traduit vers `babana.motorcycle.driver_id`).
Regroupements : état, en ligne.

### Motif de refus qui voyage

Aucun code nouveau : `action_reject` / `action_suspend` posent déjà `rejection_reason`, et
`controllers/auth.py::_build_user_payload` le ship déjà dans `driverRejectionReason`.
L'assistant rend seulement la saisie possible depuis l'écran.

### Correctif de permission tiré par la tâche

`group_babana_manager` gagne `hr.group_hr_user` (`implied_ids`). Sans lui, « Approuver / créer
une fiche » lève `AccessError` sur `hr.employee` / `resource.calendar` (action_approve crée la
fiche salariée, D5) et le formulaire ne peut pas afficher `employee_id`. Latent jusqu'ici :
`action_approve` n'était testé que sous l'utilisateur admin.

### Modèle

`babana.driver` : `+ ride_ids`, `+ assignment_ids`, `+ last_ride_at`, `+ cash_limit_reached`
(compute + search), `+ document_expired`, `_compute_display_name`, `_search_motorcycle_id`.
Nouveau `babana.driver.decision` (TransientModel) + ACL manager + entrée `none/none/none/none`
dans `access_matrix.json` (sinon la suite L8-02 échoue — filet voulu).

### Tests

`tests/test_driver_backoffice.py` (12 tests) : champs de liste lisibles sans le formulaire ;
chaque filtre ; aperçu → URL signée pour un gestionnaire, refus pour un non-gestionnaire ;
assistant reject / suspend / approve (nouvelle fiche) + motif obligatoire ; drapeaux de
décoration. Suite Odoo complète : **714 tests, 0 échec** (`-u babana`). `make lint` /
`make typecheck` verts.

### Écart déposé

`amoa/questions/L9-01.md` (sur master) : le regroupement « par zone d'activité » de la
spécification n'a pas de modèle — un chauffeur n'est rattaché à aucune `babana.zone` (D6 =
moto, pas zone). Groupement par état + en ligne livré ; la zone d'activité est une donnée que
le pilote produira (L9-07/L9-08), signalée plutôt que fabriquée.

### Invariants

2 : intact — l'assistant délègue aux `action_*`, aucune écriture directe de `state`. 3 : intact
— aucune règle métier ajoutée. 5 : intact — la fenêtre « documents expirant » (30 j) est une
commodité d'affichage, pas une règle de blocage ; le TTL de l'URL signée reste le paramètre
`babana.document_url_ttl_seconds`.
