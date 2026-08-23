# Rapport de nuit — J18

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-26.md` lu en entier avant d'ouvrir quoi que ce
soit. Périmètre : les deux corrections d'abord (recherche de lieu vers `mock-maps`, endpoint
fantôme retiré), puis L6-09.

---

## Correction 1 — la recherche de lieu vers `mock-maps` (D19)

Même mécanisme que `GOOGLE_ROUTING_URL` côté Odoo (`services/odoo/addons/babana/services/
routing.py`) : une seule variable d'environnement fait pointer le module vers un fournisseur ou un
autre, aucune branche conditionnelle sur l'environnement dans le code.

**Deux formes différentes, pas seulement une URL différente**, comme l'écart de la nuit dernière
l'avait déjà identifié (`amoa/questions/C-01R.md` §2) : Google enveloppe chaque résultat dans
`geometry.location.{lat,lng}` avec une enveloppe `status` ; `mock-maps` sert des quartiers plats
`{name,latitude,longitude}` sans `status` du tout. `packages/maps/src/providers/google/places.ts`
porte maintenant un adaptateur de forme (`normalizeSearchResult`, duck-typing sur la présence du
champ `geometry` — jamais une lecture de l'environnement) et envoie systématiquement les deux noms
de paramètre de requête possibles (`query` pour Google, `q` pour `mock-maps`) : chaque serveur
ignore celui qu'il ne connaît pas, ce qui évite de faire dépendre le nom du paramètre du
fournisseur ciblé.

**La clé API devient optionnelle en pratique, sans cesser d'être obligatoire en configuration.**
`configureGoogleMapsProvider({ apiKey, searchUrl })` distingue maintenant « jamais configuré »
(`apiKey === undefined`, la vraie faute de câblage, toujours détectée) de « configuré à vide »
(`apiKey === ''`, le cas réel du développement avec `mock-maps`, qui n'a besoin d'aucune clé). La
version précédente confondait les deux (`!apiKey`), ce qui faisait échouer `searchPlace` avant même
d'atteindre le réseau dès que `BABANA_GOOGLE_MAPS_API_KEY` était vide — exactement le symptôme
décrit dans l'écart (« `PlacePicker` échoue silencieusement »). `searchPlace` n'envoie le paramètre
`key` que si une clé non vide est configurée.

`BABANA_MAPS_SEARCH_URL` (nouvelle variable, `apps/client/config.ts`) suit la convention déjà en
place dans ce fichier : défaut à la valeur de production si absente (l'adresse Google réelle, codée
dans `providers/google/places.ts::PLACES_TEXT_SEARCH_URL`), jamais à `mock-maps` — contrairement à
`GOOGLE_ROUTING_URL` côté Odoo, où le défaut de repli est `mock-maps` parce que ce code tourne
toujours dans le réseau Docker interne. Un build de production qui oublierait de définir cette
variable continuerait donc d'appeler la vraie API Google plutôt que de basculer silencieusement
vers un simulateur — l'erreur serait visible (`REQUEST_DENIED`, faute de clé), jamais un repli
muet. `infra/env/.env.example` la pointe vers `http://localhost:4001/search` : `mock-maps` expose
son port directement à l'hôte (`infra/compose.dev.yaml`, `ports: ["4001:4001"]`), le navigateur qui
exécute l'app web l'atteint donc sans passer par Caddy — pas besoin du montage jetable de la nuit
dernière.

**`infra/env/.env` (non suivi) régénéré.** Il datait d'avant plusieurs variables déjà présentes
dans `.env.example` (`GOOGLE_ROUTING_URL`, `BABANA_GOOGLE_MAPS_API_KEY`, les identifiants Google
Sign-In) — supprimé pour que `make up` le recrée à neuf depuis `.env.example`, seul moyen de lui
faire porter `BABANA_MAPS_SEARCH_URL` ce soir. Rien à perdre : ce fichier ne contient que des
valeurs de développement factices, jamais suivies par git.

**Fichiers.** `packages/maps/src/providers/google/config.ts`,
`packages/maps/src/providers/google/places.ts`, `packages/maps/test/places.test.ts` (cinq tests
ajoutés : clé vide acceptée, forme plate traduite, paramètre `q` envoyé, panne HTTP sans enveloppe
`status` levée explicitement, repli sur l'adresse Google réelle sans `searchUrl` configuré),
`apps/client/config.ts`, `apps/client/src/bootstrap.ts`, `infra/env/.env.example`,
`infra/env/README.md`.

**Vérifié.** `packages/maps` : 11/11 tests verts. `apps/client` : `tsc --noEmit` propre, 13 suites /
69 tests verts. `apps/driver` inchangé (n'utilise pas `searchPlace`, laissé tel quel). La preuve en
navigateur — un point de départ et d'arrivée réellement désignés par la recherche, contre le vrai
`mock-maps` — est réservée à la passe finale de fin de nuit, avec le parcours complet.

---

## Correction 2 — `GET /drivers/nearby` retiré du contrat

Arbitrage déjà posé la nuit dernière (`amoa/questions/REPONSES-2026-08-26.md` §2, `amoa/questions/
C-01R.md` §1) : la découverte de chauffeurs proches passe entièrement par `nearby.subscribe` /
`nearby.drivers` (C-02, flux WebSocket) — un abonnement tient la liste à jour pendant que le client
compare, ce qu'un `GET` ne fera jamais. L'endpoint n'a jamais été implémenté (vérifié par `grep`
avant d'écrire quoi que ce soit, comme le veut `CLAUDE.md`).

**Retiré, pas gardé en exception.** `nearbyDrivers` disparaît de `HTTP_ENDPOINTS`
(`packages/contracts/src/http/index.ts`) ainsi que `NearbyDriversQuerySchema`,
`NearbyDriversResponseSchema`, `NearbyDriversErrors` et leurs exemples
(`packages/contracts/src/http/driver.ts`). `NearbyDriverSchema` (l'objet chauffeur, singulier)
reste : c'est la forme partagée que `nearby.drivers` (WebSocket,
`packages/contracts/src/realtime/server-to-client.ts::NearbyDriversPayloadSchema`) réutilisait déjà
et continue de réutiliser seule — D17 (une seule définition) tenu, juste avec un seul consommateur
désormais plutôt que deux.

La suite de conformité (`test/http-contract/endpoint-coverage.test.ts`) perd son exception
`nearbyDrivers` de `NOT_YET_IMPLEMENTED` : elle n'a plus besoin de vérifier un 404 attendu, ce
endpoint n'existant simplement plus dans `HTTP_ENDPOINTS` — la vérification de complétude (chaque
clé du contrat doit apparaître dans `EXERCISES` ou `NOT_YET_IMPLEMENTED`, jamais dans aucun ni dans
les deux) n'a même plus à en connaître l'existence.

**Effet de bord révélé par `tsc`, pas par une recherche manuelle** : `nearbyDrivers` était le seul
endpoint `GET` du contrat à porter un `requestSchema` non nul (les paramètres de requête).
Une fois retiré, `packages/api-client/src/http/client.ts::attemptOnce` — générique sur
`Name extends EndpointName` — voyait son type `endpoint` se réduire à l'union exacte des
descripteurs restants, dans laquelle plus aucun membre ne combine `method: 'GET'` et
`requestSchema` non nul : TypeScript signalait la branche qui gère ce cas comme statiquement
impossible (`This comparison appears to be unintentional`). Corrigé par une annotation de type
explicite (`http.HttpEndpointDescriptor`, l'interface générale, pas le type littéral inféré) —
la branche reste posée, correctement typée, pour le prochain `GET` paramétré, même si aucun
endpoint ne l'exerce plus aujourd'hui. Les quatre tests de `packages/api-client/test/http/
client.test.ts` qui prenaient `nearbyDrivers` comme exemple générique de `GET` sont réécrits contre
`driverCash` (le seul autre `GET` authentifié du contrat), sans rien perdre de ce qu'ils
prouvaient (réessai, idempotence absente sur lecture, `ZodError` de réponse non rejouée).

**Doute noté, pas traité ce soir** : `LOCATION_REQUIRED` (catalogue général des erreurs,
`packages/contracts/src/http/errors.ts`) n'est plus déclaré par aucun endpoint — c'était la seule
erreur propre à `nearbyDrivers` en plus de `RATE_LIMITED` (toujours utilisé par
`phoneVerifyStart`). Rien ne le supprime automatiquement du catalogue, et rien ne l'exige : un
code d'erreur général inutilisé aujourd'hui n'est pas une faute, seulement un relief à surveiller
s'il traîne encore au moment d'un futur endpoint qui aurait besoin d'un motif voisin.

**Fichiers.** `packages/contracts/src/http/{index,driver,common,ride}.ts`,
`packages/contracts/src/realtime/server-to-client.ts`, `packages/contracts/test/{http,realtime}.
test.ts`, `packages/api-client/src/http/client.ts`, `packages/api-client/test/http/client.test.ts`,
`test/http-contract/endpoint-coverage.test.ts`, `docs/contracts/{http-api,realtime-events}.md`.

**Vérifié.** `packages/contracts` : build + génération des schémas JSON (plus de fichier
`nearbyDrivers` dans `dist/json-schema/`) + 63/63 tests verts. `packages/api-client` : `tsc
--noEmit` propre, 10 suites / 50 tests verts. `test/` (suite de conformité, `tsc -p tsconfig.json`)
compile sans erreur — son exécution contre la vraie pile est due à la passe finale, avec le
parcours complet.

---

## L6-09 — suivi de course et résumé de fin

Lu en entier avant d'écrire quoi que ce soit : `amoa/specs/L6-mobile.md` (L6-09, mais aussi L6-10
qui en dépend), `amoa/specs/L4-course.md` (L4-09, notation), `amoa/specs/L8-securite.md` (L8-03,
L8-04 -- pour confirmer par `grep` qu'ils n'existent toujours pas, pas supposé).

**`TrackingScreen.tsx` affiche, il ne dérive rien.** Position et ETA viennent tels quels de
`driver.position` (L3-09) ; le tracé affiché pendant la course est un fil de positions reçues
(`trace`, état local, jamais persisté), pas un itinéraire recalculé -- aucun service de routage
n'est accessible depuis l'app, et ce n'en serait de toute façon pas le rôle (invariant 3).

**Un point non documenté par la spécification, trouvé en lisant `services/realtime/src/tracking/
broadcast.ts` avant d'écrire l'écran** (CLAUDE.md : une dépendance se vérifie dans le dépôt) :
`etaSeconds` est calculé côté serveur comme la distance jusqu'au point de **prise en charge**,
sans condition sur l'état de la course -- le champ continuerait d'arriver, avec la même
signification, même une fois la course commencée. Une fois `ride.started` reçu, l'affichage de
l'ETA disparaît donc explicitement (`phase === 'approach'` uniquement) : le garder aurait affiché
un ETA vers un point que le chauffeur a déjà quitté. C'est cohérent avec la spécification, qui ne
liste l'ETA que pour la phase d'approche -- mais la spécification ne dit pas *pourquoi*, et le
pourquoi vient du code serveur, pas du texte.

**Deux phases, un seul écran, jamais deux écrans qui se remplacent.** `approach` (chauffeur en
route vers le client) et `course` (client à bord) sont un seul état local (`phase`), pas une
seconde route de navigation -- rien dans la spécification ne les distingue par une transition de
pile, seulement par ce qui s'affiche. La transition se fait sur `ride.started` ; `ride.completed`
navigue (`navigation.replace`, jamais `navigate`) vers `RideSummary` avec exactement les quatre
champs du message reçu.

**L'état de connexion est explicite** (critère 3) : un bandeau distinct apparaît dès que
`onRealtimeConnectionStateChange` signale autre chose que `connected`, avec « dernière position il
y a N s » calculé depuis `emittedAt` de la dernière `driver.position` reçue -- jamais un marqueur
figé. Une légende de fraîcheur discrète (« Position mise à jour il y a N s ») reste visible même
connecté, pour que « à jour » soit toujours une mesure, jamais une promesse implicite. `ride.track`
n'a pas de politique de rejeu automatique côté client (contrairement à `nearby.subscribe`,
persisté par `@babana/api-client`) : réémis explicitement à chaque reconnexion, comme QuoteScreen
et HomeScreen le font déjà pour leur propre abonnement.

**Partage de trajet (L8-03) et bouton d'urgence (L8-04) : absents, pas inertes** (critère 2,
précision du 25/26 août). Vérifié par `grep` qu'aucun des deux modèles ni composants n'existe --
rien à câbler. Testé négativement (`TrackingScreen.test.tsx`) : aucun texte ni testID lié à
« urgence » ou « partager » n'apparaît à l'écran, pas seulement « le bouton n'est pas cliquable ».

**Aucun moyen d'appeler le chauffeur -- écart consigné, pas contourné.** La spécification en
prose promet « les coordonnées du chauffeur pour l'appeler », mais aucun message serveur
(`ride.assigned` compris) ne porte de numéro de téléphone -- vérifié dans
`packages/contracts/src/realtime/server-to-client.ts` avant d'écrire l'écran. Comme pour L8-03/
L8-04 : rien construit plutôt qu'un bouton qui échouerait. Détail dans
`amoa/questions/L6-09.md`.

**L'immatriculation cesse d'être affichée à la transition Tracking -> RideSummary, décidé
explicitement** (doute du 26 août, `amoa/questions/REPONSES-2026-08-26.md` §5). Le cliché du
chauffeur (`AssignedDriverInfo`, `navigation/types.ts`) ne voyage que dans les paramètres de route
de `Tracking` ; `RideSummary` a ses propres paramètres (`rideId`, `distanceMeters`,
`durationSeconds`, `amount`, `breakdown`) qui ne le portent pas du tout. `navigation.replace` fait
disparaître `Tracking` de la pile au moment de la transition -- rien à effacer explicitement
ensuite, il n'y a simplement plus rien qui le porte nulle part dans l'app. Testé négativement
(`RideSummaryScreen.test.tsx`).

**Le résumé de fin est ce que le serveur a écrit, transmis tel quel.** `RideSummaryScreen`
n'accepte que les quatre champs de `ride.completed` en paramètres de route -- aucun recalcul,
aucune valeur accumulée pendant le suivi. Le détail décomposé réutilise `FARE_LINES` de
QuoteScreen (extrait en `components/fareBreakdown.ts`, D17 étendu à la présentation : la même
liste de libellés, une seule définition, pas une copie qui aurait divergé).

**La notation (L4-09, critère 5) est câblée contre le vrai contrat, en sachant qu'elle échouera ce
soir.** `POST /rides/{id}/rate` existe dans `HTTP_ENDPOINTS` mais `babana.rating` (L4-09) n'existe
pas côté Odoo -- confirmé dans `test/http-contract/endpoint-coverage.test.ts::NOT_YET_IMPLEMENTED`
avant d'écrire l'écran. Contrairement à L8-03/L8-04, ce n'est pas traité en « absent » : noter
n'est pas un geste de sécurité qu'une fausse promesse rendrait dangereux, seulement une action qui
peut légitimement échouer -- exactement comme n'importe quel autre appel réseau de cet écran, avec
le même traitement (`translateApiError`, message clair, rien de bloquant). « Sans être bloquante »
(critère 5) est tenu au sens fort : le bouton « Terminer » reste disponible et actif que la note
ait été envoyée, ait échoué, ou n'ait jamais été touchée.

**`formatMoney`/`formatDistance`/`formatEta` extraits** (`src/format.ts`) : `formatMoney` était
dupliqué à l'identique dans QuoteScreen et WaitingScreen avant ce soir : ajouter Tracking et
RideSummary en aurait fait quatre copies. Regroupés une fois, QuoteScreen et WaitingScreen
retouchés pour importer plutôt que redéfinir -- pas une extraction spéculative, une divergence
réelle qui commençait à s'installer.

### Fichiers

`apps/client/src/screens/TrackingScreen.tsx`, `apps/client/src/screens/RideSummaryScreen.tsx`,
`apps/client/src/format.ts`, `apps/client/src/components/fareBreakdown.ts`,
`apps/client/src/navigation/types.ts` (`AssignedDriverInfo`, paramètres de `Tracking`/
`RideSummary`), `apps/client/src/navigation/index.tsx` (les deux écrans remplacent leurs
`PlaceholderScreen`), `apps/client/src/screens/WaitingScreen.tsx` (transmet le cliché du chauffeur
affecté à `Tracking`), `apps/client/src/screens/QuoteScreen.tsx` (réutilise `format.ts`/
`fareBreakdown.ts`), plus les tests associés et `amoa/questions/L6-09.md`.

### Vérifié

`apps/client` : `tsc --noEmit` propre, `eslint .` propre, 15 suites / 84 tests verts (9 nouveaux
pour `TrackingScreen`, 6 pour `RideSummaryScreen`, dont les tests négatifs pour L8-03/L8-04 et
pour l'immatriculation après `RideSummary`). La vérification en navigateur, parcours complet, est
due à la passe finale ci-dessous.

### Doute pour un client réel

**Aucun moyen d'appeler le chauffeur** (détaillé ci-dessus, `amoa/questions/L6-09.md`) est le
doute principal : un client debout dans la rue, chauffeur introuvable ou en retard, n'a aujourd'hui
aucun recours dans l'app -- seulement une position sur une carte qu'il doit interpréter lui-même.
C'est exactement le genre de situation que L8-04 (urgence) ne couvre pas non plus (elle suppose un
danger, pas une simple gêne). À trancher avant le pilote, pas après.

Second doute, plus petit : `ride.track` n'a pas d'`unsubscribe` symétrique de `nearby.unsubscribe`
-- en quittant `Tracking` (vers `RideSummary`), le service temps réel continue de pousser des
`driver.position` jusqu'à ce que la session de suivi expire d'elle-même côté serveur (course
terminée). Sans conséquence fonctionnelle (plus personne n'écoute, `onRealtimeMessage` est
désabonné au démontage), mais un gaspillage de bande passante sur un réseau mobile compté --
n'existait pas avant ce soir puisque personne n'atteignait `Tracking`. Pas un défaut à corriger
seul (ajouter `ride.untrack` est une extension de contrat, D17), à signaler pour L3-10/L3-11.

---

## Passe finale

`make reset` puis `make up` sur une base neuve, comme dû. `make test` complet vert du premier coup
(Odoo : 400 tests, 0 échec, 0 erreur ; le reste du monorepo : 393 tests répartis sur les huit
suites npm -- api-client 50, contracts 63, maps 19, ui 4, navigation 133, client 84, driver 15,
test/ 25 -- tous verts). `make lint` et `make typecheck` propres sur tout l'arbre. `make verify`
vert. `make secrets-scan` échoue sur un faux positif préexistant, sans rapport avec ce soir --
détaillé plus bas.

### Vérification navigateur, jusqu'où elle a pu aller

Demandée explicitement, jusqu'au résumé de fin, sans contournement manuel. Faite contre la pile
réelle, montage jetable identique à celui de C-01R la veille (`http://verify.localhost`, Caddy
proxyant `/rt/*` et `/api/*` vers les vrais services et tout le reste vers le bundle web statique ;
jamais commité, retiré avant ce commit -- la vérification l'a confirmé : `git status` propre sur
`infra/caddy/Caddyfile` après coup). Session client réelle injectée (même geste qu'un redémarrage
d'app avec une session déjà persistée, pas un raccourci serveur). Six chauffeurs réels, mêmes
mécanismes qu'un vrai chauffeur (`availability.set`, `position.update`, `proposal.accept`/
`.reject` par WebSocket) -- un script jetable (`test/verify-driver-sim.ts`, jamais commité) tenait
lieu des cinq mains qui auraient dû répondre.

**Ce qui a été vu, en clair, jusqu'à `ride.assigned` inclus** : connexion restaurée, recherche
« Akwa » puis « Bonapriso » via `PlacePicker` -- **la correction 1 de ce soir en train de
fonctionner, dans un vrai navigateur, ce qui était précisément le but de la corriger** -- carte
recentrée, cinq chauffeurs réels (`nearby.subscribe`), estimation réelle (550 FCFA, détail
décomposé cohérent, 3,4 km, ≈ 8 min), sélection du chauffeur le plus proche, refus réel
(`proposal.reject`) → `DriverRejectedScreen`, retour automatique à la sélection avec ce chauffeur
exclu et **cinq autres chauffeurs affichés** (exactement l'énoncé de la consigne), seconde
sélection, acceptation réelle (`proposal.accept`) → `TrackingScreen` : immatriculation
(`LT-IP5C-VE`) et gamme (« Standard ») visibles (critère 1), ETA en direct (« ≈ 1 min »),
« Position mise à jour il y a N s » qui avance seconde par seconde en te regardant, aucune trace
du mot « urgence » ni « partager » nulle part sur l'écran (critère 2, vérifié par lecture du texte
rendu, pas seulement par requête sur un `testID`).

**Un défaut de CORS trouvé, et corrigé, avant même d'aller plus loin.** `searchPlace` échouait
silencieusement dans le navigateur avec `TypeError: Failed to fetch`, alors que le même appel
réussissait à la ligne de commande (`curl`) : `mock-maps` ne pose aucun en-tête
`Access-Control-Allow-Origin`, invisible depuis Node (aucune notion de CORS côté serveur-à-serveur,
c'est comme ça que `GOOGLE_ROUTING_URL` l'appelle depuis Odoo) et depuis les tests unitaires
(`fetch` de Jest ne l'applique pas non plus) -- seul un vrai navigateur le fait respecter. Corrigé
dans `services/mocks/maps/src/index.js` (`Access-Control-Allow-Origin: '*'`, un simulateur qui
refuse de démarrer en production n'a aucune raison de restreindre son origine). **C'est exactement
la classe de défaut que la vérification navigateur de ce soir existe pour attraper** -- ni `make
test`, ni aucun test unitaire de `packages/maps` ne l'aurait jamais vu, parce qu'aucun des deux ne
tourne dans un vrai moteur de rendu.

**Ce qui n'a pas pu être vérifié en direct : la course et le résumé.** `ride.started` et
`ride.completed` ne sont émis nulle part dans `services/realtime/src` -- constaté dans le code
(`ws/dispatch.ts` le documente lui-même), pas supposé, et déjà noté hier
(`amoa/rapport-nuit-J17.md`, §L3-09). Ni le message WebSocket `ride.start`/`ride.complete`
(silencieusement ignorés), ni le vrai chemin HTTP (`POST /rides/{id}/start`/`.../complete`, qui
transitionne bien `babana.ride` côté Odoo) ne déclenchent la moindre notification vers le service
temps réel : aucun point d'accroche interne, contrairement à l'affectation (D31). `TrackingScreen`
reste donc bloqué en phase d'approche pour toujours ce soir, et `RideSummaryScreen` est
inatteignable par le parcours réel. Détaillé, avec ce qui reste à trancher :
`amoa/questions/L6-09-ride-lifecycle-emitter.md`.

**Décidé de ne pas contourner, conformément à la consigne de ce soir** (« sans un seul
contournement manuel ») : construire l'émetteur manquant aurait été sortir du périmètre confié
(aucune tâche ne le nomme, pas même dans les dépendances à lire) pour improviser, en fin de nuit,
un point d'accroche au commit sur du code que ce dépôt traite avec le plus de précaution
(D31/D32/D33) -- exactement le genre de raccourci que la consigne demandait d'éviter. La preuve de
`RideSummaryScreen` et de la phase de course reste donc celle des tests automatisés
(`TrackingScreen.test.tsx`, `RideSummaryScreen.test.tsx`), pas celle du navigateur, ce soir.

**Fichiers.** `services/mocks/maps/src/index.js` (CORS, correctif réel, commité).
`amoa/questions/L6-09-ride-lifecycle-emitter.md` (écart). `infra/caddy/Caddyfile`,
`test/verify-driver-sim.ts`, `apps/client/dist-web/` : montage jetable, rien de tout cela n'est
resté après vérification.

**Vérifié.** `make test` complet rejoué après le correctif CORS (le seul changement de code de
cette passe) : de nouveau vert du premier coup, mêmes chiffres qu'avant.

### `make secrets-scan` — un faux positif préexistant, signalé pas corrigé

`tools/secret-scan/scan.sh`, règle 4 (valeur à forte entropie sur un nom de variable contenant
`_KEY`), signale `apps/client/webpack-stubs/react-native-keychain.web.js:6` :
`STORAGE_KEY = 'babana-dev-keychain-stub'` -- une clé de `localStorage`, pas un secret. Fichier du
21 août (L6-00R), jamais touché ce soir ; les exclusions de la règle couvrent `.ts`/`.md`, pas
`.js`. Signalé, pas corrigé -- hors du périmètre de cette nuit, et modifier un outil partagé (scan
de secrets) mérite sa propre attention plutôt qu'une correction de bord de route.

## Ce qui reste ouvert

- **L6-09-ride-lifecycle-emitter** (nouveau, ce soir) -- le plus urgent : sans lui, aucune course
  ne peut se terminer aux yeux du client, quoi que fasse réellement le chauffeur.
  `amoa/questions/L6-09-ride-lifecycle-emitter.md`.
- **L6-09** — aucun moyen d'appeler le chauffeur (`amoa/questions/L6-09.md`), à trancher avant le
  pilote.
- **`make secrets-scan`** — faux positif sur `react-native-keychain.web.js` (ci-dessus), à
  corriger (probablement : étendre l'exclusion de la règle 4 aux `.js`, ou renommer la constante).
- **L3-18** — l'unification de l'état Redis (arbitrée le 26 août), avant L3-10 et L3-11.
- **L8-03 / L8-04** — partage de trajet et bouton d'urgence, absents de `TrackingScreen`.
- **L3-12** — file persistante avec rejeu côté service.
- **L4-06** — la facture.
- **La validation du plan comptable** — trois questions à poser.
- **La vérification développeur Android.**
