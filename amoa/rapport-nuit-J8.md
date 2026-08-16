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

## L3-07 — cycle de proposition

**Fait, testé, câblage Odoo explicitement laissé de côté** — comme demandé, et comme L3-06 hier
soir : `ProposalLifecycle` (`services/realtime/src/proposal/lifecycle.ts`) n'a aucun appelant en
production ce soir, prête à être appelée par la tâche de câblage à venir.

**C'est cette tâche qui pose l'engagement, en remplacement de la réservation** — le lien annoncé
entre les deux tâches de la nuit. `accept()` appelle `resolveProposal`, un second script Lua
(`proposal/resolve.lua`) qui, dans la même exécution : vérifie que la réservation est toujours
active, la supprime, et pose l'engagement (sans expiration) si l'issue est une acceptation. Même
discipline que `reserve.lua` (L3-06) et `pool-eligibility.lua` (L3-06R) : décision et écriture dans
le même script, jamais un `if` en TypeScript entre les deux — c'est exactement la faute qui a cassé
l'invariant du pool cette nuit-ci, je ne voulais pas la reproduire à l'étage au-dessus.

**Idempotence (critères 4 et 5)** : `resolveProposal` renvoie faux si la réservation n'existe plus
— déjà résolue par une acceptation, un refus, ou une expiration antérieure. `accept()`/`reject()`
annulent d'abord le minuteur JS (synchrone, avant tout `await` — aucune fenêtre où le minuteur
pourrait se déclencher entre-temps dans le modèle à un seul thread de Node), puis appellent le
script : une acceptation tardive après expiration échoue proprement (testé), une double acceptation
concurrente ne produit qu'une transition (testé avec deux appels réellement simultanés,
`Promise.all`, même esprit que L3-13 à plus petite échelle).

**Un point non spécifié à la lettre, décidé et documenté** : `resolve.lua` compare aussi le rideId
attendu (porté par `proposal.accept`/`proposal.reject`, C-02) à celui de la proposition active,
dans une clé séparée (`proposalRideIdKey`, plain-text, comparée dans le script — pas de `cjson`
nécessaire). Sans elle, un message tardif référençant une proposition déjà remplacée par une
nouvelle, pour le même chauffeur, pourrait valider la mauvaise course. Détail dans
`amoa/questions/L3-07.md`.

**Deux minuteurs pour l'expiration, volontairement, avec une marge vérifiée au démarrage.** Le
minuteur JS (`proposal/timeout.ts`, `PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS`, 30 s par défaut) est le
chemin normal — il notifie proprement (`ride.rejected` au client, `proposal.expired` au chauffeur).
Le TTL Redis de la réservation (`RESERVATION_TTL_SECONDS`, L3-06) reste le filet de sécurité qui
survit à un redémarrage du service, où le minuteur JS, lui, ne survit pas. `config.ts` porte
maintenant un `.refine()` qui refuse de démarrer si `RESERVATION_TTL_SECONDS` n'est pas strictement
supérieur à `PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS` : sans cette marge, le filet Redis pourrait
expirer une proposition avant le minuteur JS, et personne n'émettrait alors les messages de fin de
proposition. Testé (`test/config.test.ts`).

**Câblage WebSocket** : `ws/dispatch.ts` route maintenant `proposal.accept`/`proposal.reject` vers
`ProposalLifecycle`, avec le même garde-fou de rôle que `availability.set` (identité depuis le
contexte de connexion, jamais du message, L3-01). `ws/connection.ts` instancie `ProposalLifecycle`
avec le même `ConnectionRegistry` que celui qui indexe les connexions actives — l'émission ciblée
(`proposal.new` au chauffeur, `ride.assigned`/`ride.rejected` au client) n'a pas eu besoin d'un
second registre.

**Tests** (`test/proposal.test.ts`, contre Redis réel) : les six critères d'acceptation, plus
l'échec propre sur un chauffeur indisponible. `test/auth.test.ts`, `test/health.test.ts`,
`test/ws.test.ts` mis à jour (nouvelle clé de configuration obligatoire dans leurs objets `Config`
construits à la main). Suite complète : 91 tests, 20 suites, tout vert. `npm run typecheck` propre.

**Non traité ce soir, documenté dans `amoa/questions/L3-07.md`** : la notification push (L7-04,
n'existe pas encore dans le dépôt) et le câblage Odoo (endpoint entrant, transitions
`proposed → assigned`/`proposed → rejected` — même piège de rejeu qu'annoncé pour L3-06 : bonne
nouvelle, `accept`/`reject`/`expire` sont déjà idempotents par construction, le futur câblage peut
s'appuyer dessus).

---

## Vérification, pour L3-06R et L3-07 ensemble

`npm test` et `npm run typecheck` dans `services/realtime` : 91 tests, 20 suites, tout vert,
`tsc --noEmit` propre. `npm run build` vérifié explicitement (pas seulement supposé) : les trois
scripts Lua du service (`reservation/reserve.lua`, `redis/pool-eligibility.lua`,
`proposal/resolve.lua`) se retrouvent bien à côté de leur `.js` compilé dans `dist/`, après avoir
étendu `package.json::scripts.build` — même piège que celui découvert le 16 août pour `reserve.lua`
(un script Lua absent de l'image échoue seulement en production, jamais en local). `npm run lint
--workspaces --if-present` : seuls `@babana/client` et `@babana/driver` portent un script `lint`
(inchangé depuis J7, `@babana/realtime` n'en a toujours pas — hors périmètre de cette nuit).

**Pas de `make reset` complet cette nuit** — les deux tâches ne touchent que `services/realtime`
(Redis), aucun module Odoo ni migration PostgreSQL. La même infrastructure Docker restée démarrée
depuis J7 a servi pour toute la nuit, avec les identifiants de test suffixés par un identifiant de
run unique (déjà en place avant cette nuit) pour ne dépendre d'aucune purge entre exécutions — si
une session reprend derrière celle-ci sur un lot touchant Odoo, `make reset` reste dû avant de
déclarer quoi que ce soit fini, conformément à la politique de non-régression.

**Vérifié à blanc, les deux fois demandées** : L3-06R (les deux tests censés détecter le défaut
d'origine, réinjecté temporairement) et implicitement L3-07 (la double acceptation concurrente,
`test/proposal.test.ts` critère 5, prouve l'atomicité de `resolve.lua` de la même façon que L3-13
prouve celle de `reserve.lua` — pas un aussi grand nombre d'itérations que L3-13, cette tâche
n'ayant pas demandé l'équivalent d'une L3-13 pour `resolve.lua` ; à garder en tête si ce script
devait un jour porter une charge de production plus lourde).
