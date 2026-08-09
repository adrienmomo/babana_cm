# Rapport de la session de nuit — J1

Démarrage : 2026-08-09.

## État par tâche

| ID | Statut | Branche | Commentaire |
|---|---|---|---|
| C-03 | finie | `C-03-ride-state-machine` | Table de transitions complète en `code/docs/contracts/ride-state-machine.md` + source JSON + script de vérification. Deux écarts consignés (voir Questions ouvertes) |
| C-01 | non commencée | — | — |
| C-02 | non commencée | — | — |
| L0-01 | non commencée | — | — |
| L0-02 | non commencée | — | — |
| L0-08 | non commencée | — | — |
| L0-03 | non commencée | — | — |
| L0-04 | non commencée | — | — |
| L0-06 | non commencée | — | — |

## Ce qui tourne

_(à compléter)_

## Ce qui ne tourne pas

_(à compléter)_

## Questions ouvertes

- `amoa/questions/C-03.md` — deux écarts sur la machine à états : (1) le critère d'acceptation 1
  de C-03 exige que `cancelled` apparaisse en source, ce qui contredit son caractère terminal ;
  (2) le critère d'acceptation 3 de C-01 exige exactement quatre écritures Odoo, mais
  l'annulation doit aussi écrire pour rester traçable. Hypothèse appliquée dans les deux cas
  (documentée dans le fichier). **Bloquant pour L4-01/L4-02**, pas pour cette nuit.

## Hypothèses prises

- **C-03** : `draft` n'est jamais persisté en base — le premier enregistrement `babana.ride`
  naît directement en `state = requested`. Choix non spécifié explicitement, mais cohérent avec
  le critère « `draft` jamais cible ».
- **C-03** : `cancelled` est traité comme un état terminal (aucune transition sortante), au même
  titre que `settled`. Voir `amoa/questions/C-03.md`, écart 1.
- **C-03** : les écritures Odoo déclenchées par une annulation sont des « écritures de clôture »,
  distinctes des quatre moments de la règle de partition. Voir `amoa/questions/C-03.md`, écart 2.
- **C-03** : ajout d'une transition `rejected → cancelled`, non listée dans le minimum de la
  spécification, pour couvrir le cas où le client abandonne après un refus sans resélectionner.
- **C-03** : `in_progress → cancelled` déclarée transition interdite (absente du minimum
  spécifié) — une fois le trajet démarré physiquement, la course va jusqu'à `completed` ; un
  incident se traite via `babana.incident`, hors machine à états. À confirmer.
- **C-03** : le script `verify-ride-state-machine.js` n'est pas encore branché sur `make test`
  (le Makefile n'existe pas avant L0-01). À intégrer dès que L0-01 crée le Makefile.

## Ce que je ferais ensuite

_(à compléter en fin de session)_
