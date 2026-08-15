# Champs-pont

Registre des champs transitoires posés en attendant le modèle qui les portera vraiment (`CLAUDE.md`,
« Champs-pont : tracés, datés, condamnés »). Un champ-pont porte la mention `[PONT — remplacé par
<ID-TACHE>]` dans son `help`, et une ligne ici. **La tâche cible commence par supprimer les
champs-pont qui la nomment** — c'est un critère d'acceptation, pas une intention.

Une ligne disparaît de ce tableau dès que sa tâche cible l'a résolue ; l'historique de sa résolution
vit dans le message de commit qui l'a retirée, pas ici.

| Champ | Modèle | Remplacé par | Créé le | Pourquoi il ne peut pas exister tout de suite |
|---|---|---|---|---|
| `rating_avg`, `rating_count` | `babana.driver` | L4-09 | 10 août 2026 (L1-03) | Comptés depuis `babana.rating`, qui n'existe pas encore. Champs calculés, pas des relations : n'empêchent pas l'installation, mais renvoient 0 tant que L4-09 n'existe pas. |
| `cash_balance` | `babana.driver` | L5-01 | 10 août 2026 (L1-03) | Résultat du journal des mouvements de compte courant (D8), qui n'existe pas encore. Champ calculé sans inverse fonctionnel (l'inverse existe uniquement pour lever une erreur explicite sur écriture directe, critère d'acceptation 4 de L1-03) ; renvoie 0 tant que L5-01 n'existe pas. |
| `quote_reference` | `babana.ride` | L2-04 | 10 août 2026 (L4-01) | Remplace un `Many2one` vers `babana.quote`, absent au moment de L4-01 (`amoa/questions/L4-01.md`). Un `Many2one` vers un modèle absent empêcherait l'installation du module. |
| `promotion_code` | `babana.ride` | L2-06 | 10 août 2026 (L4-01) | Même raison, vers `babana.promotion` (L2-06, hors du lot du 10 août comme du 11 août). |

## Vérifié le 14 août 2026

**`license_expires_on` et `license_alert_sent_on`** (`babana.driver`, posés par L1-10 le
11 août) ont été résolus par L1-05 (cette nuit), comme prévu à leur création : le modèle
`babana.driver.document` existe désormais, et porte l'expiration du permis (`expires_on`, type
`license`) et l'idempotence de l'alerte (`alert_sent_on`, sur le document plutôt que sur le
chauffeur -- un nouveau permis téléversé après rejet doit pouvoir redéclencher une alerte sur sa
propre échéance). `babana.driver._current_license_expires_on()` et
`_cron_alert_and_block_drivers()` lisent désormais le document le plus récent au lieu du champ
plat. Retirés de ce registre.

## Vérifié le 11 août 2026

**`babana_role` et `babana_driver_state`** (`res.users`, posés par L1-01 le 10 août) ont été
retrouvés toujours présents lors de la vérification demandée par
`amoa/questions/REPONSES-2026-08-11.md` — alors que le critère d'acceptation 7 de L1-03 exigeait
leur disparition. Supprimés cette nuit (L1-03R, `amoa/questions/L1-03R.md`) : le rôle et le statut
chauffeur se lisent désormais par l'existence d'un `babana.driver` rattaché
(`res.users._babana_role`, `_babana_driver`), jamais stockés sur le compte. Ce sont les deux
premiers champs-pont à sortir de ce registre — ils n'y figurent donc plus.

**`ride_count`** (`babana.driver`) et **`babana_rides_count`** (`res.partner`), posés le 10 août en
attendant `babana.ride` (L4-01), ont été trouvés dans le même état : leur tâche cible (L4-01) était
terminée depuis le 10 août sans que le branchement ait été fait. Branchés cette nuit sur un
`search_count` réel ; retirés de ce registre.

## Résolu cette nuit, sans jamais figurer dans le tableau

**`babana.driver.motorcycle_id`** n'existait pas encore au 10 août : la spécification de L1-03 le
listait, mais un `Many2one` vers `babana.motorcycle` (L1-07), alors absent, aurait empêché
l'installation du module. Contrairement aux lignes du tableau ci-dessus, aucun champ de repli
n'avait été posé à sa place (`amoa/questions/L1-03.md`) : il n'y avait donc rien à inscrire ici
avant L1-07. **L1-07 (cette nuit) ajoute directement le vrai champ** : `babana.motorcycle.driver_id`
est la relation écrite (source unique), `babana.driver.motorcycle_id` en est le miroir calculé —
jamais un champ plat transitoire, donc jamais entré dans ce tableau.

## En observation, non résolu cette nuit

**`babana.ride.pickup_zone_id` / `dropoff_zone_id`** sont dans la même situation, pour
`babana.zone` (L2-02) : omis de L4-01 le 10 août, aucun champ de repli posé. L2-02 (cette nuit)
crée `babana.zone`, mais rattacher `babana.ride` à ce modèle n'est demandé par aucune spécification
de cette nuit ; non traité ici pour ne pas modifier L4-01 (déjà sur `master`) sans instruction — à
signaler plutôt qu'à trancher en silence (voir `amoa/rapport-nuit-J3.md`).
