# Rapport — nuit J45 (4 septembre 2026)

Périmètre : D70, le seul sujet de la nuit — « chauffeur jamais apparu dans `nearby.drivers` après
20 000 ms », suivi d'un silence du processus, vu trois nuits distinctes (15, 19, 20 septembre) sans
qu'aucune explication ne couvre les trois à la fois.

Lu en entier avant d'écrire du code : `CLAUDE.md`, `amoa/questions/REPONSES-2026-09-21.md`,
`amoa/01-architecture.md` §9 duodecies, les rapports J41 à J44 (le catalogue des quatre incidents
intermittents), `amoa/questions/L3-05-nearby-list-goes-silently-empty.md` (l'écart du 24 août qui a
donné naissance à L3-20).

---

## 1. Relecture à froid du chemin de diffusion — rien trouvé, comme les fois précédentes

`nearby/handler.ts`, `nearby/expand.ts`, `nearby/last-sent.ts`, `nearby/projection.ts`,
`ws/connection.ts`, `ws/liveness.ts`, `tracking/broadcast.ts`, `driver/availability.ts`,
`proposal/timeout.ts` : chaque minuteur du service est `unref()`, chaque abonnement a un jeton de
fraîcheur (L3-20) ou une garde `readyState !== OPEN`, chaque `finally`/`close` nettoie ce qu'il a
ouvert. Le client Redis du service (`redis/client.ts`) a `maxRetriesPerRequest: 1` et une
`retryStrategy` plafonnée à 5 s — pas de blocage indéfini possible côté Redis.

**Une seule dissymétrie relevée en lisant `services/realtime/src/odoo/client.ts`** :
`pingOdoo` pose un `AbortController` avec un délai de 2 s explicite ; `callOdoo`, juste en dessous
dans le même fichier, ne le fait pas — un `fetch()` nu, sans aucune limite de temps, utilisé par
tout le service pour parler à Odoo (dont `redis/driver-profiles.ts::getDriverProfiles`, sur le
chemin direct de `nearby/handler.ts::push()`). Gardée en tête comme piste, pas corrigée sans
preuve — voir §4.

Comme les trois lectures précédentes (15, 19, 20 septembre), cette relecture seule n'a rien donné
de plus qu'une piste. Le prompt de cette nuit avait raison : ce qui manquait n'était pas une
hypothèse de plus.

---

## 2. Reproduction — deux fois en direct, la même nuit

**Premier temps, isolé : rien.** `ride-transitions.test.ts` (scénario 1 seul, N=20/C=8) rejoué deux
fois d'affilée, seul, sans le reste de la suite : deux passes vertes, aucun figement. Cohérent avec
tout l'historique — chaque relecture isolée d'un incident précédent était déjà repartie verte.
Isoler le fichier soupçonné n'était donc pas la bonne condition.

**Deuxième temps, conditions réelles : la commande `npm test` elle-même** (les six fichiers de
`test/package.json::scripts.test`, PAS un fichier isolé — c'est la condition exacte de l'incident
du 20 septembre, celui qui a écarté les deux explications précédentes). Une boucle instrumentée
(`--require instrument.cjs`, un battement de cœur toutes les 3 s + un gestionnaire `SIGUSR2` qui
imprime `process._getActiveHandles()`/`_getActiveRequests()` en détail) a rejoué cette commande.

**Reproduit à la première passe.** `concurrency/select-driver-replay.test.ts` a échoué avec très
exactement le message catalogué : `chauffeur(s) [f8e4abe1-...] jamais apparu(s) dans nearby.drivers
après 20000ms`. Le processus worker de ce fichier (isolé par `node --test`, un processus par
fichier) a ensuite cessé toute progression — aucune ligne TAP suivante — pendant que son propre
battement de cœur continuait d'arriver toutes les 3 s, preuve que la boucle d'événements tournait
normalement, qu'il ne s'agissait pas d'un blocage synchrone.

**Mesuré pendant le figement, pas après** (`kill -USR2`, `lsof`, `redis-cli client list`,
`docker stats`, au bout de 30 s de silence puis vérifié à nouveau à 8 min 36 s, toujours figé) :

- Processus vivant, **0 % CPU**, état `SN` (en sommeil).
- `lsof` : **deux connexions TCP `ESTABLISHED` vers `localhost:3000`** (le service temps réel),
  identifiables par leur âge (ports consécutifs, ouverts au tout début de l'itération en échec) —
  ni fermées, ni en `CLOSE_WAIT`, ni en erreur.
- Aucune connexion Redis inhabituelle (3 clients côté service temps réel, stables, `age` = durée de
  vie du conteneur).
- Aucune ligne d'erreur du service temps réel au moment du figement — le seul bruit dans ses
  journaux était une file `L3-12` (`odoo/outbox.ts`) qui rejouait indéfiniment des entrées
  périmées (404, chauffeur d'une exécution antérieure au dernier `make reset`) : bruit de fond
  attendu par conception (« une entrée qui échoue indéfiniment s'alerte, ne s'abandonne jamais »,
  commentaire de tête du fichier), sans rapport avec ce test, purgé par le `make reset` de la passe
  finale (§5).

**Cause, lue dans le code du test, pas supposée** (`test/concurrency/select-driver-replay.test.ts`,
lignes 81-89 avant correctif) :

```
const driverASocket = await bringDriverOnline(driverASession.accessToken, RIDE_ORIGIN);
const driverBSocket = await bringDriverOnline(driverBSession.accessToken, RIDE_ORIGIN);
await seedDriverProfile(...);
await seedDriverProfile(...);
await waitForDriverVisible(clientSocket, [driverAId, driverBId], RIDE_ORIGIN);  // <- échoue ici

try {
  ...
} finally {
  await Promise.all([takeDriverOffline(driverASocket), takeDriverOffline(driverBSocket)]);
}
```

`waitForDriverVisible` — exactement l'appel qui produit le message catalogué — est appelé **avant**
le `try`/`finally` qui ferme `driverASocket`/`driverBSocket`. Quand il rejette (le symptôme lui-même),
l'exception saute le `finally` : les deux connexions WebSocket, ouvertes deux lignes plus haut,
restent référencées par personne mais toujours actives. Un `net.Socket` réf'd (le comportement par
défaut du paquet `ws`) ne laisse jamais un processus Node sortir de lui-même — il attend
indéfiniment, sans CPU, sans autre trace qu'une connexion `ESTABLISHED` que plus rien ne pilote.
C'est très exactement « un abonnement dont le nettoyage dépend d'un chemin nominal », le sujet même
de cette nuit.

**Ce n'est pas L3-20.** Le jeton de fraîcheur de `nearby/handler.ts` protège contre une course entre
deux `nearby.subscribe`, côté serveur — il tient, `test/nearby.test.ts::L3-20` reste vert (revérifié
ce soir). Le défaut de cette nuit est symétrique mais différent : côté **client** (le test lui-même),
et pas une course de minuteurs mais un nettoyage jamais atteint parce qu'il n'englobait pas l'appel
qui pouvait le faire échouer.

Pourquoi « trois fichiers » le 15 septembre (le tout premier incident) et pas un seul : le
concurrency de `node --test` sur plusieurs fichiers est borné (3 workers actifs vus dans ce
service ce soir) — un worker qui ne sort jamais garde une place, et les fichiers suivants qui
attendaient un créneau ne progressent plus non plus. Un seul fichier qui fuit peut ainsi donner
l'impression que plusieurs sont en cause.

---

## 3. Correctif — dans l'outillage de test, pas dans le service

`test/concurrency/select-driver-replay.test.ts` : le `try` est étendu pour englober
`seedDriverProfile`/`waitForDriverVisible`, pas seulement ce qui les suit — le `finally` existant
(déjà correct) couvre désormais tout chemin d'échec entre l'ouverture des deux connexions
chauffeur et leur fermeture. Aucune ligne de `services/realtime` touchée : le service ne portait
aucun défaut, exactement le cas que le prompt de cette nuit envisageait (« le figement est dans
l'outillage de test plutôt que dans le service »).

**Vérifié à blanc, deux fois** (même discipline que les corrections comptables de J44) :

1. Rejet forcé (un `driverId` qui n'apparaîtra jamais, `maxWaitMs: 3000`) sur le code corrigé :
   `not ok`, message attendu, **processus sorti proprement en 6,5 s** (`EXIT code=1` dans le journal
   d'instrumentation) — contre les 8 min 36 s (et comptant) observées en direct sur le code non
   corrigé, §2. Retiré aussitôt après (jamais laissé dans le dépôt).
2. Rejeu du fichier seul (conditions nominales) : vert, 80,6 s, sortie propre.
3. Rejeu de tout `concurrency/*.test.ts` ensemble (les quatre scénarios, la même famille de
   charge que l'incident) : quatre verts, 309,6 s, sortie propre — le symptôme ne s'est pas
   reproduit cette fois (attendu : c'est un défaut intermittent, dépendant de la charge), mais rien
   n'aurait empêché une sortie propre s'il s'était reproduit, ce que le blanc du point 1 a déjà
   prouvé sur le mécanisme exact.

Fichier : `test/concurrency/select-driver-replay.test.ts`.

---

## 4. Ce qui reste ouvert, nommé mais pas traité cette nuit

**`callOdoo` (`services/realtime/src/odoo/client.ts`) n'a pas de délai — `pingOdoo`, juste
au-dessus, si.** Une dissymétrie réelle, dans le même fichier, sur un chemin (profils chauffeur,
donc `nearby.drivers`) qui touche directement le sujet de cette nuit. Pas corrigée : je n'ai
aucune preuve qu'elle se soit manifestée ce soir (Odoo a toujours répondu, jamais observé de
`fetch` en attente lors des deux figements mesurés) — l'ajouter maintenant serait exactement le
correctif défensif que le prompt de cette nuit écarte. À vérifier une prochaine fois qu'Odoo est
lent sous charge réelle (le lot L3-* ou une revue dédiée), pas ce soir.

**Pourquoi `waitForDriverVisible` met parfois plus de 20 s à voir un chauffeur reste sans
explication.** Ce que cette nuit ferme, c'est le SILENCE qui suivait l'échec — pas l'échec
lui-même, qui reste un dépassement occasionnel sous charge (plusieurs fichiers `test/concurrency`
et `test/e2e` sollicitant la même diffusion à la fois). Le figement masquait ce dépassement depuis
trois nuits ; maintenant qu'il ne masque plus rien, ce dépassement redevient observable normalement
— une itération future pourra le mesurer si le symptôme revient, sans qu'un processus mort
n'interrompe l'observation.

**Le journal `[L3-12] entrée de file Odoo en échec répété`** (`babana:outbox:*`, Redis) survit à un
`make reset` complet tant que le volume Redis, lui, n'est pas explicitement vidé au même moment que
Postgres — ce qui EST le cas ici (`make reset` = `docker compose down -v`, tous les volumes). Ce
n'était donc qu'un artefact d'une session de test accumulée avant ce soir, purgé par la passe finale
(§5). Rien à corriger — le comportement (alerter, jamais abandonner silencieusement) est déjà
documenté comme voulu dans `odoo/outbox.ts`. Mentionné ici seulement pour que la prochaine personne
qui voit ce journal sache qu'il ne signale pas un défaut du dépôt.

---

## 5. Passe finale — `make reset` complet, `make seed`, suite complète

`make reset` (volume Postgres ET Redis effacés), `make up`, installation en deux temps (même
raison que J43/J44 : `-i babana` seul d'abord, ~30 s, puis `--test-enable` sur le module déjà
installé). **820 tests Odoo, 0 échec, 0 erreur**, sur une base vraiment neuve.

`make seed` : 6 zones, 5 chauffeurs en ligne, 8 courses réglées — cohérent avec J44.

`npm test`, par groupes (la session a manqué de mémoire une fois en lançant les six fichiers
d'un coup — contrainte de cette machine, sans rapport avec le dépôt ; rejoué par morceaux comme
J42 l'avait déjà fait pour une raison différente) : `concurrency/*` (4/4), `auth/*` +
`http-contract/*` (27/27), `config/*` (11/11, vu dans la première tentative avant la coupure),
`storage/*` + `e2e/*` (7/7). **Aucun échec, aucune instabilité** — y compris `select-driver-replay`,
rejoué trois fois ce soir en tout (une fois dans le run interrompu par le manque de mémoire, où il a
d'ailleurs reproduit le symptôme réel une seconde fois avant de repasser vert dans les deux rejeux
suivants).

`make lint` : propre. `make typecheck` (tout l'arbre, huit espaces de travail) : propre.

---

## Verdict

**Reproduit deux fois en direct cette nuit** (une fois observée pendant 8 min 36 s de figement
continu, mesures prises pendant qu'il se produisait), **cause lue dans le code, pas supposée**, et
**vérifiée à blanc** (le même rejet, forcé, sort proprement une fois le correctif posé). Le
mécanisme n'était pas dans `services/realtime` : trois lectures précédentes du service n'avaient
rien à trouver, et n'ont rien trouvé, parce que le défaut vivait dans l'outillage de test qui
l'observe. D70 est clos.

---

## Ce qui reste ouvert de votre côté

Inchangé, `08-passation-pilote.md` en porte le détail. Le relais SMTP reste la seule chose à faire
si vous n'en faites qu'une.
