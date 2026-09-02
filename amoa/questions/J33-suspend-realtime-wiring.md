# J33 — Câblage suspension → temps réel : une clé de non-habilitation, à ratifier

## Le trou (rappel de la seconde revue J32)

`action_suspend` passe `state` à `suspended`, ce qui force `is_online = False` **côté Odoo** et
révoque les jetons. Mais le service temps réel garde son propre vivier géo-indexé (Redis), qui ne
dépend pas d'`is_online` : un chauffeur suspendu y restait sélectionnable et recevait des
propositions jusqu'à l'expiration de sa dernière position.

Le franchissement de plafond d'encaisse (L5-02) avait déjà le mécanisme : `notify_cash_limit_reached`
au commit (D32), hors savepoint (D33), qui notifie sans transitionner (D31), et pose une clé Redis
que le script d'éligibilité **et** la résolution d'acceptation consultent. Le prompt J33 demandait
de l'appliquer, pas de le réinventer.

## Ce qui a été fait

Trois cas partagent le même besoin — toute transition d'état qui rend un chauffeur indisponible :

| Transition | Signal | Effet temps réel |
|---|---|---|
| `approved → suspended` (suspension) | `notify_driver_unavailable` | pose la clé, retire du vivier, refuse l'acceptation en vol |
| `* → rejected` (rejet) | `notify_driver_unavailable` | idem |
| `suspended → approved` (réactivation) | `notify_driver_available` | **lève** la clé, **sans réintégrer** au vivier |
| `* → approved` (approbation d'une candidature) | `notify_driver_available` | lève la clé (sans effet si aucune n'était posée) |

Le câblage vit dans `babana.driver.write()`, à côté du forçage `is_online = False` déjà présent —
même raison (couvrir aussi une écriture directe de `state`), même point du code.

**Nouvelle clé Redis** : `babana:driver:admin-hold:<public_id>`, sœur de
`babana:driver:cash-blocked:<public_id>`. Sans TTL. Posée par `driver/admin-hold.ts` (patron de
`driver/cash-guard.ts`). Lue à deux endroits, exactement comme la clé d'encaisse :

1. `redis/pool-eligibility.lua` — cinquième `EXISTS` (en lecture seule sur l'état, la règle D26
   « un seul écrivain sur le pool » est intacte) ;
2. `ws/dispatch.ts` avant de résoudre un `proposal.accept` — une proposition émise juste avant la
   suspension revient au client comme un refus, jamais bloquée sans réponse.

**Deux nouvelles routes internes** : `POST /internal/drivers/unavailable` (→ `holdDriver`) et
`POST /internal/drivers/available` (→ `releaseHold`).

## Le point qui mérite une ratification

**La réactivation ne réintègre pas au vivier**, contrairement à `cash-unblocked` (qui, lui,
appelle `reintegrateIfEligible`). C'est voulu par le prompt : « elle ne doit **pas** le remettre
dans le vivier toute seule, c'est au chauffeur de se redéclarer en ligne » (D7). Un chauffeur
réactivé rouvre l'app, se reconnecte, envoie `availability.set` — et c'est cette redéclaration,
pas la levée du blocage, qui le rend de nouveau visible.

Conséquence : `/internal/drivers/available` est **plus pauvre** que `/internal/drivers/cash-unblocked`.
Deux routes voisines au comportement délibérément différent. Si cette asymétrie doit plutôt être
gommée (les deux réintègrent, ou aucune), c'est une décision à prendre maintenant.

## Proposition : D56

> **D56 — La non-habilitation d'un dossier chauffeur (suspension, rejet) est un état temps réel
> distinct, posé au commit de la transition Odoo.** Il retire du vivier et bloque l'acceptation
> en vol, sur le patron de D8/L5-02. Sa levée (réactivation) ne réintègre pas au vivier : le
> chauffeur se redéclare en ligne (D7).

## Limite connue, assumée

Comme pour l'encaisse, aucune réconciliation périodique ne repose la clé si l'appel HTTP
`notify_driver_unavailable` est perdu (best-effort, comme tous les appels sortants de ce module).
Filets en place : `removeFromPool` immédiat, nettoyage paresseux de `findNearby` à l'expiration de
la position (~60 s), jetons révoqués (pas de reconnexion possible avant réactivation), et
`_check_online_eligibility` qui bloque le repassage en ligne côté Odoo tant que `state != approved`.
Le pire cas est donc un chauffeur suspendu visible ~60 s au lieu de « jusqu'à expiration de la
position et toujours sélectionnable ». Si ce n'est pas suffisant, une réconciliation de
non-habilitation (Odoo → temps réel, liste des `public_id` non `approved`) est à ajouter — même
forme que `driver/reconcile.ts` pour l'engagement.
