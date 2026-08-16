# Rapport de nuit — J8 (nuit du 16 août 2026)

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). Périmètre : L3-06R (pool à écrivain unique, D26), puis L3-07 (cycle de
proposition), dans cet ordre — conformément à la consigne de cette nuit. Câblage Odoo ↔ temps réel
explicitement hors périmètre, comme demandé.

**État de départ vérifié** : `master` propre au lancement (`3a0ce74`, débrief J7 déjà commité).
`amoa/questions/REPONSES-2026-08-16-J7.md` lu en entier avant d'ouvrir quoi que ce soit, comme
demandé — le point 2 (le pool avait deux écrivains de fait) est le point de départ de cette nuit.

---

## L3-06R — le pool n'a qu'un écrivain (D26)

**Les deux tests d'abord, vus rouges, comme demandé.** `test/reservation.test.ts` : un test émettant
des positions réelles (`ingestPosition`) pendant qu'une réservation est active (critère 3 bis), un
autre pendant qu'un chauffeur est engagé (critère 3 ter, engagement simulé directement puisque
L3-07 n'existe pas encore ce soir-là dans l'ordre d'écriture). Contre le code d'origine
(`ingestPosition` appelant `addToPool` sans condition), les deux échouent bien : le chauffeur
réapparaît dans le pool dès la première position. Revérifié une seconde fois après coup, en
réinjectant temporairement l'ancien chemin : les deux tests détectent le défaut de façon
reproductible, comme le veut la politique de non-régression.

**La correction.** Nouveau script Lua unique, `services/realtime/src/redis/pool-eligibility.lua` :
en une exécution, vérifie en ligne + non réservé + non engagé, et n'écrit (`GEOADD`) que si les
trois tiennent. `tracking/ingest.ts` ne fait plus de `if (isMarkedOnline) { addToPool }` — il
appelle `addEligibleToPool` sans condition, et laisse le script décider. Même changement dans
`reservation/reserve.ts::releaseDriver` : la décision d'éligibilité n'est plus recomposée en
TypeScript (elle lisait `isMarkedOnline` puis appelait `addToPool`), elle est déléguée entièrement
au script.

**Nouveau module `driver/engagement.ts`** : marqueur d'engagement, sans expiration, distinct de la
réservation — posé par L3-07 à l'acceptation en remplacement de la réservation qu'il efface au même
geste (voir plus bas). Ce soir, il n'est encore posé/effacé que par les tests et par L3-07 ;
`clearEngaged` reste sans appelant en production, la fin de course n'étant traitée par aucune tâche
de cette nuit — même situation que `reserveDriver` sans appelant en production après L3-06.

**Deux modules « clés » sans dépendance ajoutés** (`driver/keys.ts`, `reservation/keys.ts`), pas
dans la liste de fichiers de la spécification, nécessaires pour éviter un cycle d'imports : le
script d'éligibilité a besoin des trois clés (en ligne, réservation, engagement), et les modules qui
les possédaient déjà (`availability.ts`, `reserve.ts`) importent chacun `redis/geo-index.ts`, que le
script d'éligibilité importe aussi. Extraire les constructeurs de clé dans des feuilles sans import
casse le cycle sans dupliquer les préfixes.

**Frontière de lint posée, vérifiée par recherche** : `test/pool-single-writer.test.ts` balaie tout
le service (src et test) et échoue si la chaîne `geoadd` apparaît ailleurs que dans les deux
fichiers qui la citent légitimement. Un jugement documenté dans `amoa/questions/L3-06R.md` : le
GEOADD brut de `redis/geo-index.ts::addToPool` reste exporté, réservé aux fixtures de trois fichiers
de test sans rapport avec cette tâche (`nearby.test.ts`, `geo-index.test.ts`,
`availability.test.ts`) — ni l'un ni l'autre n'appelle jamais la commande par son nom, seulement cet
identifiant TypeScript, donc la portée large du grep ne produit aucun faux positif et la garantie
réelle (aucune écriture de *production* ne contourne le script) est pleinement vérifiée.

**Tests** : 82 tests, 18 suites, tout vert (`npm test` dans `services/realtime`), `tsc --noEmit`
propre (`npm run typecheck`). Vérifié à blanc une seconde fois comme ci-dessus. Pas de `make reset`
complet cette nuit : les deux tâches de la nuit ne touchent que `services/realtime` (Redis), aucun
module Odoo ni migration — la même infrastructure Docker restée démarrée depuis J7 a servi, avec les
identifiants de test suffixés par un identifiant de run unique (déjà en place) pour ne dépendre
d'aucune purge entre exécutions.

---
