# Rapport — nuit J46 (4 septembre 2026)

Périmètre : D71, seul sujet — le délai manquant de `callOdoo`, et la preuve que la file de rejeu
(L3-12) prend le relais quand Odoo se tait plutôt que refuse.

Lu en entier avant d'écrire du code : `CLAUDE.md`, `amoa/questions/REPONSES-2026-09-22.md`,
`amoa/01-architecture.md` §9 terdecies (D71, déjà consigné par la revue de J45).

---

## 1. Ce que la revue nommait, et ce que le code a montré une fois ouvert

`services/realtime/src/odoo/client.ts` porte trois fonctions : `pingOdoo` (délai explicite, 2 s),
`callOdoo` (réessai en mémoire, trois tentatives à délai croissant — utilisée par
`fetchEngagedDrivers`, `fetchActiveRide`, `fetchDriverProfiles`, le partage de trajet et la
notification push) et `callOdooOnce` (une seule tentative, sans réessai propre — réservée à
`odoo/outbox.ts`, la file persistante de L3-12).

La revue nomme `callOdoo` explicitement, puis écrit « les deux seuls [appels sortants sans délai]
sont ceux qui transportent le travail réel ». Le texte ne nomme le second nulle part — c'est en
lisant `outbox.ts::attemptOutboxEntry` que j'ai trouvé lequel : **`callOdooOnce` n'a, lui non plus,
aucun délai**, et c'est exactement lui qui porte l'écriture `driver-accepted`/`driver-rejected`
(`odoo/rides.ts::reportDriverAccepted`/`reportDriverRejected` → `reportOutboxWrite` →
`attemptOutboxEntry` → `callOdooOnce`) — le chemin même que le prompt de cette nuit demande de
vérifier bout en bout. `callOdoo`, lui, ne porte plus cette écriture depuis L3-12 (3 septembre,
commentaire de tête de `odoo/rides.ts`) : il sert la lecture de réconciliation
(`fetchEngagedDrivers`), la resynchronisation de session (`fetchActiveRide`), le cache de profils
chauffeur et le partage de trajet.

**Conséquence à ne pas manquer** : un correctif qui n'aurait touché que `callOdoo` — la lecture
littérale du prompt, sans ouvrir `outbox.ts` — aurait laissé le chemin d'acceptation aussi silencieux
qu'avant. `callOdooOnce` aurait continué à attendre indéfiniment une réponse d'un Odoo muet, jamais
levé d'erreur réseau, donc jamais reprogrammé l'entrée — la file que D71 est censé faire fonctionner
serait restée un filet qui ne se referme jamais. C'est la « trouvaille » que le prompt anticipait
comme possible ; elle s'est confirmée en lisant le code, pas en le faisant tourner (voir §3 pour la
preuve que la vraie trouvaille est ailleurs : une fois les deux corrigés, la file prend le relais
exactement comme prévu — rien d'anormal découvert à l'exécution).

Signe supplémentaire que ce n'était pas une extrapolation : le commentaire de tête de
`callOdooOnce`, écrit avant ce soir, disait déjà « seule une erreur réseau (Odoo injoignable,
**timeout**) lève encore » — un timeout que le code ne produisait jamais. Le commentaire décrivait
un comportement qu'il n'avait pas encore.

---

## 2. Correctif

`services/realtime/src/config.ts` : nouveau champ `ODOO_CALL_TIMEOUT_MS`, paramétrable (invariant 5),
défaut **5000 ms** — pas une valeur choisie pour ce correctif seul : c'est celle déjà retenue par
tout appel sortant comparable du dépôt (`REALTIME_TIMEOUT_SECONDS` côté Odoo, pour le sens inverse
de ce même appel ; `ROUTING_TIMEOUT_SECONDS` ; `JWKS_FETCH_TIMEOUT_SECONDS`). Borne le temps qu'une
tentative individuelle — donc, sur le chemin d'acceptation, une écriture avant sa remise en file —
peut prendre avant d'être considérée perdue.

`services/realtime/src/odoo/client.ts` : un utilitaire privé `fetchWithTimeout` (même patron que
`pingOdoo` — `AbortController` + `setTimeout`, nettoyé dans un `finally`), appliqué à chaque
tentative de `callOdoo` et à l'unique tentative de `callOdooOnce`. `pingOdoo` lui-même n'a pas été
touché — son délai fonctionnait déjà, le reproduire pour lui aurait été un changement hors sujet.

Aucune autre ligne de `services/realtime` modifiée : ni `outbox.ts`, ni `rides.ts`, ni les points
d'appel de `callOdoo` (`retries`/`baseDelayMs` déjà réglés par appelant, inchangés) — le défaut
vivait entièrement dans le client HTTP, pas dans ce qui l'entoure.

---

## 3. Vérification — la chaîne complète contre un Odoo qui SE TAIT

Deux fichiers de test, aucun autre modifié à part l'ajout du champ `ODOO_CALL_TIMEOUT_MS` aux objets
`Config` littéraux existants (`auth.test.ts`, `health.test.ts`, `ws.test.ts` — construits à la main,
pas via `parseConfig`, donc invisibles au défaut du schéma).

**`test/client.test.ts` (nouveau)** : `callOdoo`/`callOdooOnce` contre un vrai serveur HTTP local
qui accepte la connexion et ne répond **jamais** — pas un serveur qui refuse vite, déjà couvert par
ailleurs et insuffisant pour ce défaut. Preuves :
- une tentative seule échoue près du délai configuré (100 ms), pas après une attente indéfinie ;
- le réessai complet par défaut (4 tentatives à 100 ms + délais croissants 200/400/800 ms) reste
  borné et mesuré à ~1,8 s, jamais infini — c'est la prévisibilité que le prompt demandait de
  vérifier ;
- un Odoo qui répond avant le délai n'est pas affecté (résultat normal renvoyé).

**`test/outbox.test.ts`, nouveau bloc « D71 »** : reproduit exactement le scénario demandé — une
course acceptée pendant qu'Odoo se tait. `reportOutboxWrite` (l'appel réel de
`odoo/rides.ts::reportDriverAccepted`) contre un faux Odoo qui journalise la requête reçue puis ne
répond jamais (`res` gardée, jamais `res.end()`), avec `ODOO_CALL_TIMEOUT_MS=300` :

1. `reportOutboxWrite` revient immédiatement (< 50 ms) — n'a jamais su qu'Odoo allait se taire.
2. **Échec** : la tentative immédiate atteint Odoo (journalisée) puis expire après ~300 ms ;
   l'entrée est reprogrammée (`attempts: 1`, `nextAttemptAt` dans le futur, `lastError` sans
   code HTTP — bien une erreur réseau, pas une réponse).
3. **Entrée en file** : elle reste en Redis, exactement le sens de la file — sans le délai, ce
   point n'aurait jamais été atteint, l'appel initial serait resté suspendu pour toujours.
4. Odoo redevient joignable (bascule du mode silencieux à une réponse 200) ; le prochain
   `drainDueEntries` — le passage périodique, **personne ne rappelle `reportOutboxWrite`** — reprend
   l'entrée.
5. **Rejeu qui aboutit** : l'entrée disparaît de Redis, Odoo a reçu exactement deux requêtes pour
   ce chemin (la silencieuse, puis celle qui a réussi).

**Rien d'anormal trouvé à l'exécution** : la file prend le relais exactement comme la spécification
de L3-12 le prévoit, une fois `callOdooOnce` capable de transformer un silence en échec. La
« trouvaille » de cette nuit n'est donc pas un second défaut caché dans le mécanisme de reprise —
c'est d'avoir vérifié, en lisant le code avant d'écrire quoi que ce soit, que le mécanisme de reprise
dépendait d'un endroit que le prompt ne nommait pas littéralement (§1).

**Compatibilité avec ce qu'un chauffeur voit à l'écran.** Vérifiée en lisant
`proposal/lifecycle.ts::accept()`, pas en ajoutant un test redondant à celui qui le prouve déjà
(`test/proposal.test.ts`, ligne 142, vert avant et après ce soir) : l'accusé `proposal.accepted` est
envoyé au chauffeur **avant** tout `await` sur Odoo, et `reportDriverAccepted` qui suit n'est jamais
attendu (`void`, fire-and-forget). Aucun délai posé ce soir — ni le délai par tentative, ni le
plafond du réessai complet — n'entre sur ce chemin : un chauffeur qui accepte voit sa confirmation
au temps de la résolution atomique Redis, jamais au temps d'Odoo. C'est `ride.assigned` côté
**client** qui attend un appel Odoo bloquant (`getDriverProfiles`, cache chauffeur) — et pour ce
chemin-là, l'effet du soir est un pur bénéfice signalé en passant : avant ce soir, un Odoo muet
aurait bloqué `ride.assigned` indéfiniment (aucun timeout, aucun cache) ; il est maintenant borné à
~1,4 s au pire (`retries: 1`, `baseDelayMs: 100`, désormais chacune plafonnée par
`ODOO_CALL_TIMEOUT_MS`). Pas un défaut nommé par le prompt, pas creusé plus loin cette nuit — la
même politique que J45 vis-à-vis du dépassement de `waitForDriverVisible` : un fait observé, pas un
correctif improvisé sans qu'on l'ait demandé.

Suite `services/realtime` complète (`npm test`, les six groupes de fichiers, `--test-concurrency=1`) :
**232 tests, 0 échec** — les 5 de `client.test.ts` et le nouveau bloc D71 de `outbox.test.ts` inclus,
et **aucune régression** sur les 226 restants (concurrence L3-13 comprise).

---

## 4. Passe finale

`make reset` (volumes Postgres et Redis effacés), `make up` (sain, `--build --wait`). Installation en
deux temps, même raison que J43-J45 : `-i babana` seul d'abord (~23 s, 50 modules), puis
`--test-enable` sur le module déjà installé par `make test`.

`make seed` : 6 zones, 5 chauffeurs en ligne, 8 courses réglées — cohérent avec les nuits
précédentes. Avertissement inchangé, déjà documenté par le script lui-même (« 8 envoi(s) automatique(s)
de facture encore en vol après 120 s ») : sans rapport avec D71, non traité.

`make test` : suite Odoo (installation en deux temps ci-dessus) verte, non chronométrée séparément
cette fois (fondue dans le journal `npm test`, comme la commande le fait réellement). `npm test`
racine, dans l'ordre des espaces de travail : `@babana/api-client` + `@babana/contracts` (79/79),
`@babana/maps`/`@babana/navigation` (aucun test), **`@babana/realtime` (232/232, 0 échec)** — la
suite qui porte D71, `client.test.ts` et le nouveau bloc `outbox.test.ts` compris —,
`@babana/client`/`@babana/driver` (aucun test), puis **`@babana/concurrency-tests` : 53/54, 1
échec** (`select-driver rejoué par un vrai conflit de sérialisation PostgreSQL...`, message exact
catalogué : « chauffeur(s) [...] jamais apparu(s) dans nearby.drivers après 20000ms »). `make test`
sort donc en erreur globalement (code 1) — pas la « suite complète verte » que le point 3 de la
définition de fini exige.

**Ce n'est pas un défaut introduit ce soir, et voici pourquoi je ne l'ai pas laissé sans
vérifier.** C'est très exactement le sujet que J45 a nommé sans le traiter (« le dépassement
occasionnel de `waitForDriverVisible` reste sans explication ») et que le prompt de cette nuit
demandait explicitement de seulement noter s'il se reproduisait — pas de corriger, faute de
théorie sur ce qu'il mesure. Avant de m'y tenir, j'ai vérifié que D71 ne pouvait pas l'expliquer :
le seul chemin par lequel `ODOO_CALL_TIMEOUT_MS` touche la diffusion `nearby.drivers` est
`redis/driver-profiles.ts::getDriverProfiles` (profil chauffeur, via `callOdoo`) — et son échec est
**avalé par un `catch` qui dégrade, jamais qui exclut** (D30, commentaire de tête de
`nearby/projection.ts` : « un chauffeur disponible mais sans profil en cache reste dans le
résultat, champs à `null` » — c'était déjà le comportement voulu après le blocage de production du
18 août causé par la règle inverse). Un chauffeur ne peut donc pas disparaître de
`nearby.drivers` parce qu'un appel Odoo a expiré ; au pire il y apparaît avec des champs à `null`,
ce que ce test ne vérifie même pas. La cause de l'absence complète reste donc en amont
(géo-index/diffusion), pas dans le client Odoo touché ce soir.

**Rejoué une fois de plus** (`npm test` dans `test/`, les six groupes ensemble, la vraie commande,
même discipline que J45) : **4 échecs cette fois**, tous avec la même signature exacte (« jamais
apparu dans `nearby.drivers` »), répartis sur trois fichiers indépendants
(`concurrency/select-driver-replay.test.ts`, `e2e/full-ride.test.ts`, `http-contract/
endpoint-coverage.test.ts`) — un symptôme unique, pas trois défauts distincts, cohérent avec la
lecture de J45 (« un seul fichier qui fuit peut donner l'impression que plusieurs sont en cause »,
transposé ici à un seul mécanisme sous-jacent qui touche plusieurs fichiers plutôt qu'un seul
processus qui bloque tout un groupe). Aucun figement cette fois dans les deux passes : chaque
suite a continué après l'échec (la correction du `try`/`finally` de J45 tient).

**Élément nouveau, jamais relevé les nuits précédentes** : `docker stats` et `uptime` montrent que
cette machine fait aussi tourner une pile Docker sans rapport avec ce dépôt (`n8n`, up depuis
19 h 28, CPU au repos au moment de la mesure mais présente tout le long des deux passes), en plus
de deux exécutions complètes et consécutives de la suite lourde (`make test` puis un second `npm
test` immédiatement derrière, ~9 puis ~5 minutes de charge soutenue). Je n'ai touché à aucune des
deux — ni arrêté `n8n`, ni respacé les passes — n'ayant reçu aucune instruction en ce sens et ce
service n'étant pas à moi. Je le note comme donnée d'observation, pas comme cause prouvée : une
charge externe soutenue est cohérente avec « dépassement sous charge », mais je n'ai pas mesuré la
diffusion elle-même pendant l'échec (le prompt de cette nuit ne demandait que de noter, pas
d'instrumenter comme J45 l'avait fait pour D70).

`make lint` (quatre espaces de travail avec script `lint`) : propre. `make typecheck` (huit
espaces de travail, `@babana/realtime` et `@babana/concurrency-tests` compris) : propre.

---

## Verdict

**D71 clos, au sens strict de son propre périmètre** : `callOdoo` **et** `callOdooOnce` portent
maintenant le même délai paramétrable, et la chaîne complète (échec réseau → entrée en file →
rejeu) est prouvée contre un Odoo qui se tait, jamais exercée avant ce soir — L3-14 ne prouve que
le redémarrage du service, pas le silence d'Odoo. La suite qui porte D71
(`services/realtime`) est entièrement verte, deux fois vérifiée (dans `make test` et à l'exécution
isolée). `amoa/rapport-nuit-J41.md` §3 mis à jour en place (D71 fermé dans la liste des quatre
tests instables, la latence du fil de fond notée comme partiellement exercée pour la première
fois).

**Mais le point 3 de la définition de fini n'est pas satisfait à la lettre** : `make test` sort en
erreur ce soir, deux fois, sur un symptôme préexistant (nommé par J45, jamais par D71) et non
traité, conformément à l'instruction explicite de cette nuit. Je le signale plutôt que de le
taire : la suite complète n'est verte qu'à l'exclusion de ce symptôme connu, pas au sens littéral
du point 3.

---

## Ce qui reste ouvert, et que je ne traite pas ce soir

**Le dépassement occasionnel de `waitForDriverVisible`** (nommé par J45, confirmé sans
explication) s'est reproduit deux fois ce soir, plus largement que la fois précédente (4 échecs
sur trois fichiers indépendants dans la seconde passe, contre 1 dans la première) — voir §4 pour le
détail et pour ce qui a été vérifié afin d'écarter D71 comme cause (le chemin par lequel D71
pourrait l'atteindre dégrade, jamais n'exclut, D30). Aucun figement cette fois dans les deux
passes : la correction du `try`/`finally` de J45 tient. Élément nouveau à signaler, pas à
interpréter comme cause prouvée : cette machine fait aussi tourner une pile Docker sans rapport
avec ce dépôt (`n8n`) pendant les deux passes, en plus de deux exécutions lourdes consécutives.
Toujours sans théorie sur ce que le dépassement mesure exactement ; toujours pas traité, comme
demandé.

**La latence du fil de fond sous charge réelle** (nommé dans la passe de clôture de J41) reste
non mesurée : ce soir prouve que le mécanisme de reprise fonctionne, pas combien de temps il met à
rattraper un vrai retard avec de vrais volumes.

---

## Ce qui reste ouvert de votre côté

Inchangé. Le relais SMTP reste la plus longue des six démarches de `08-passation-pilote.md`, et la
seule dont le délai cesse de dépendre de vous une fois lancée.
