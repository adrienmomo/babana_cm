# Rapport de la session de nuit — J1

Démarrage : 2026-08-09.

## État par tâche

| ID | Statut | Branche | Commentaire |
|---|---|---|---|
| C-03 | finie | `C-03-ride-state-machine` | Table de transitions complète en `code/docs/contracts/ride-state-machine.md` + source JSON + script de vérification. Deux écarts consignés (voir Questions ouvertes) |
| C-01 | finie | `C-01-http-contracts` | `@babana/contracts` (Zod), 19 endpoints, 27 codes d'erreur, `docs/contracts/http-api.md`. Bootstrap minimal du monorepo npm en avance sur L0-03 |
| C-02 | finie | `C-02-realtime-contracts` | 22 messages WebSocket (`z.discriminatedUnion`), politique de reconnexion dans `docs/contracts/realtime-events.md`. Réutilise `NearbyDriverSchema`/`RideStateSchema` de C-01. Bug de test trouvé grâce à un trou de couverture `tsc` (voir hypothèses) |
| L0-01 | non commencée | — | — |
| L0-02 | non commencée | — | — |
| L0-08 | non commencée | — | — |
| L0-03 | non commencée | — | — |
| L0-04 | non commencée | — | — |
| L0-06 | non commencée | — | — |

## Ce qui tourne

Depuis `code/` :

```bash
npm install    # 9 paquets, aucune vulnérabilité signalée
npm test       # 48 tests (node:test via tsx) + vérification structurelle de la machine à états — tout vert
npm run build --workspaces --if-present   # compile @babana/contracts, génère dist/json-schema/ (19 endpoints x 2 + errors.json)
npm run typecheck --workspaces --if-present   # tsc --noEmit propre
```

`make` n'existe pas encore (arrive avec L0-01) : les commandes ci-dessus sont l'équivalent
provisoire de `make test` / `make lint` tant que le Makefile n'est pas créé.

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
  (le Makefile n'existe pas avant L0-01) — **mis à jour** : branché sur `npm test` à la racine
  de `code/` pendant C-01, reste à raccorder à `make test` quand L0-01 crée le Makefile.
- **C-01** : bootstrap minimal du monorepo npm (`code/package.json`, workspaces
  `["packages/*"]`) créé en avance sur L0-03, seulement ce qui est nécessaire pour que
  `@babana/contracts` compile. L0-03 étendra les workspaces.
- **C-01** : ajout de `driver.ts`, `phone.ts`, `common.ts` — non listés dans l'arborescence de
  C-01, qui ne couvre que 6 des 8 familles d'endpoints. Détail dans le message de commit.
- **C-01** : authentification lue littéralement — seul `/auth/google` est public ;
  `/auth/refresh` et `/auth/logout` exigent aussi `Authorization: Bearer`.
- **C-01** : `NO_DRIVER_AVAILABLE` conservé au catalogue (exigé par la spécification) mais
  n'est émis par aucun endpoint de ce lot, puisque D10 fait choisir le client sur une liste qui
  peut être vide plutôt que de renvoyer une erreur.
- **C-02** : `client-to-server.ts` / `server-to-client.ts` regroupent chacun les deux familles
  d'émetteurs (chauffeur + client) de la spécification, qui n'en prévoit que deux fichiers pour
  quatre familles décrites en prose.
- **C-02** : `ride.cancelled` a un seul émetteur (le serveur) mais deux destinataires possibles
  (chauffeur et/ou client) — un seul message, pas deux, le critère d'acceptation 1 portant sur
  l'émetteur, pas sur le nombre de destinataires.
- **C-02** : ajout de `session.resync` / `session.synced`, absents des listes de messages
  nommées par la spécification mais nécessaires pour que la politique de reconnexion (exigée en
  prose par le critère d'acceptation 2) soit du code exécutable, pas seulement un paragraphe.
- **C-02** : incidemment, `tsconfig.json` de `@babana/contracts` ne couvrait que `src/` —
  `npm run typecheck` ne voyait jamais `test/`. Un doublon d'import dans un test aurait pu
  passer inaperçu indéfiniment. Ajout de `tsconfig.typecheck.json` qui couvre aussi `test/` et
  `scripts/` ; a fait remonter 4 erreurs supplémentaires (dont le doublon), toutes corrigées.

## Ce que je ferais ensuite

_(à compléter en fin de session)_
