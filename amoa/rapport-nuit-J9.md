# Rapport de nuit — J9 (nuit du 17 août 2026)

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). Périmètre : correction courte (`addToPool` hors de `src/`), puis L3-17 en
entier — le câblage Odoo ↔ temps réel, seule tâche de la nuit.

**État de départ vérifié** : `master` propre au lancement (`c543420`, débrief J8 déjà commité).
`amoa/questions/REPONSES-2026-08-17.md` lu en entier avant d'ouvrir quoi que ce soit. Point 4 :
trois nuits de code (`reserveDriver`, `ProposalLifecycle`, `clearEngaged`) sans aucun appelant de
production — vérifié dans le dépôt, pas supposé sur la foi du débrief : `grep -rn` confirme que ni
`controllers/ride.py` ni aucun module `services/realtime/src` n'appelle ces fonctions avant cette
nuit.

---

## Correction — `addToPool` hors de `src/`

**Arbitrage déjà tranché par le débrief J8** (§1 de `REPONSES-2026-08-17.md`) : le `GEOADD`
inconditionnel sort de `src/redis/geo-index.ts` et devient une aide de test.

Retiré de `geo-index.ts`. Nouvelle aide `test/helpers/pool.ts` (`putInPool`) : marque en ligne
(`setOnline`) puis appelle le script d'éligibilité (`addEligibleToPool`) — le vrai chemin de
production, jamais un raccourci.

Cinq fichiers de test utilisaient `addToPool`, pas trois : les trois nommés par le débrief
(`nearby.test.ts`, `geo-index.test.ts`, `availability.test.ts`) **et** deux non mentionnés
(`test/reservation.test.ts`, `test/concurrency/reservation.test.ts`, tous deux issus de L3-06/
L3-06R). Vérifié par `grep -rn addToPool services/realtime` plutôt que supposé sur la liste du
débrief — même réflexe que celui que ce protocole demande pour les dépendances. Les deux derniers
appelaient déjà `setOnline` juste avant `addToPool` : remplacés directement par
`addEligibleToPool`, sans passer par `putInPool` (redondant, `setOnline` était déjà là).

`test/pool-single-writer.test.ts` (critère 6/6 bis) mis à jour : `geo-index.ts` et
`test/helpers/pool.ts` ajoutés à la liste des fichiers autorisés à *nommer* `GEOADD` dans un
commentaire descriptif (aucun appel réel dans l'un ni l'autre).

`npm test` (paquet `@babana/realtime`, contre Redis réel) : 91 tests, 20 suites, tout vert,
y compris le test du critère 6 lui-même — qui, pour la première fois, ne trouve plus aucune
exception documentée dans `src/` pour un `GEOADD` réel.

---

## L3-17 — Câblage Odoo ↔ temps réel
