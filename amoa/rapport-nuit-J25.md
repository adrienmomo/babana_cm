# Rapport de nuit — J25

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini). `amoa/questions/REPONSES-2026-09-02.md` lu en entier avant d'ouvrir quoi que ce soit.
Périmètre confié : **D42** (numéro de téléphone révélé à l'affectation, effacé à la fin de course),
**`measured` honnête** (vrai si et seulement si au moins une position a été reçue), puis **L6-05**
(capture GPS chauffeur, réglable et instrumentée).

Branches par tâche. `make reset` et la passe complète en fin de session.

---

## D42 — le numéro de téléphone révélé à l'affectation

### Ce que le registre des décisions non portées avait raison de signaler

Arbitrée le 27 août, écrite dans la spécification du contrat (`amoa/specs/C-contrats.md`, déjà à
jour), jamais implémentée pendant quatre nuits — et signalée deux fois (`L6-09.md`, `L6-13.md`)
sans que le lien se fasse. Le §1 de `REPONSES-2026-09-02.md` documente la faute de processus ; ce
soir porte la correction.

### Ce qui a été fait

**Contrat (C-02)** : `ride.assigned` (client) gagne `phoneNumber` — le numéro du chauffeur.
`proposal.accepted` (chauffeur) gagne `clientPhoneNumber` — le numéro du client. Les deux sont
`nullable()` mais **requis** (jamais un champ absent qui dégraderait silencieusement) : nullable
pour la même raison que `licensePlate`/`photoUrl` (D30, un profil pas encore synchronisé, ou un
client sans numéro renseigné puisque L1-09 — vérification téléphone — reste hors de ce lot).

**La contrainte D49, préservée sans la rouvrir.** `proposal.accepted` doit rester un accusé de
réception immédiat, émis « avant tout `await` sur Odoo ou le cache de profils » (c'était tout le
sens de D49 le 31 août — remplacer le délai deviné de 1500 ms qui plombait `ProposalScreen`).
Ajouter `clientPhoneNumber` aurait pu réintroduire exactement ce délai si la donnée avait dû être
relue depuis Odoo au moment de l'acceptation. Ça n'a pas été nécessaire : Odoo connaît déjà le
numéro du client au moment de `reserve_and_propose` (avant même la proposition), il le transmet
donc dans le **même appel** que `origin`/`destination`/`amount`/`distanceMeters` — aucun aller-
retour Odoo supplémentaire n'est ajouté. Côté service temps réel, `ProposalLifecycle.accept()` a
seulement été réordonné : `consumeRecord()` (une lecture/suppression Redis locale, pas un appel
réseau) passe désormais **avant** l'émission de l'accusé plutôt qu'après, pour que
`clientPhoneNumber` soit disponible au moment de l'envoyer. La contrainte D49 portait sur Odoo et
le cache de profils, pas sur une lecture Redis locale déjà tolérée ailleurs dans le même chemin —
rien n'y contredit.

**Le numéro du chauffeur** suit le chemin déjà établi par `licensePlate` (D41) : ajouté à
`DriverProfile` (cache Redis) et à la projection du canal interne
(`controllers/internal_profiles.py::_project`, source `hr.employee.mobile_phone`) — même
discipline, même liste blanche, même filet D30.

**L'effacement, pas seulement la révélation.** C'est le point que j'avais moi-même relevé pour
l'immatriculation (25 août) et qui s'applique ici à l'identique :

- Côté client, `phoneNumber` ne voyage que dans `AssignedDriverInfo` (route `Tracking`). Rien de
  spécial à coder : `navigation.replace('RideSummary', ...)` remplace la pile et fait disparaître
  ces paramètres — `RideSummary` ne les a jamais reçus. Vérifié par construction (le type
  `RideSummary` de `ClientParamList` ne porte pas `driver`), pas par une purge explicite.
- Côté chauffeur, `clientPhoneNumber` voyage jusqu'à `ActiveRide` (`DriverParamList`) et disparaît
  au `navigation.reset` vers `Settlement`, qui ne le porte pas non plus.

**Boutons d'appel, absents jamais inertes.** `CallButton` (un composant par app, même discipline
que `ShareTripButton`/`EmergencyButton`) : `Linking.openURL('tel:...')`, ne rend rien quand le
numéro est `null`. Ferme les deux écarts symétriques `amoa/questions/L6-09.md` et
`amoa/questions/L6-13.md`.

### Tests

- `packages/contracts/test/realtime.test.ts` : `proposal.accepted`/`ride.assigned` avec et sans
  numéro (nullable), et le champ absent rejeté (requis).
- `services/realtime/test/proposal.test.ts` : l'accusé immédiat porte `clientPhoneNumber` lu
  depuis `ProposalDetails` ; `ride.assigned` porte `phoneNumber` depuis le profil, dégrade en
  `null` si le profil n'est pas encore synchronisé.
- `services/realtime/test/internal.test.ts` : `/internal/reservations` exige `clientPhoneNumber`
  dans le corps (Odoo le transmet toujours).
- Odoo : `test_internal_profiles_controller.py` — six champs désormais dans la liste blanche
  (`phoneNumber` ajouté), fuite de la forme brute (`mobile_phone`) toujours testée absente.
- Apps : `WaitingScreen.test.tsx`, `TrackingScreen.test.tsx`, `ProposalScreen.test.tsx`,
  `ActiveRideScreen.test.tsx` — le numéro voyage jusqu'à l'écran attendu ; `CallButton.test.tsx`
  (les deux, client et chauffeur) — absent quand `null`, compose le bon numéro sinon.
- e2e : `npm test` complet (voir passe finale) — `@babana/concurrency-tests` inclut le critère 6 de
  C-01 (chaque endpoint contre le vrai Odoo).

### Doute pour quelqu'un de réel

**Aucun numéro n'est encore réellement collecté ni vérifié.** L1-09 (vérification OTP) est hors de
ce lot — `res.partner.phone`/`hr.employee.mobile_phone` sont ce que le back-office ou une
inscription future y met, sans garantie de format ni de validité. Le champ dégrade honnêtement en
`null` s'il est vide, mais rien ne protège aujourd'hui contre un numéro mal formé ou périmé
renseigné à la main. À vérifier au pilote, avec de vrais chauffeurs inscrits.

---

## `measured` honnête — une accumulation qui n'a rien reçu n'est pas une mesure de zéro

### Le doute tranché

Formulation exacte du doute (J24, `amoa/questions/REPONSES-2026-09-02.md` §3) : *« Tant que L6-05
n'émet rien, toute course réelle se termine avec `distanceMeters: 0`, `measured: true`. […] Ce
n'est pas faux — zéro mètre ont réellement été mesurés — mais c'est le genre d'honnêteté littérale
qui trompe. »* Vérifié dans le dépôt (pas supposé) : `handleRideMeasurement`
(`services/realtime/src/http/internal.ts`) renvoyait `measured: measurement !== null` —
`getAccumulation` renvoie un objet non nul dès que `startAccumulation` a posé le HASH Redis à
`ride.start`, **avant** la moindre position acceptée. `measured` valait donc vrai dès le démarrage
de la course, avec `distanceMeters: 0` affiché comme un fait.

**Correctif** : `measured = measurement !== null && measurement.pointCount > 0`. `pointCount`
existait déjà dans `RideMeasurement` (utilisé par `accumulator.test.ts` depuis L3-10) — rien de
nouveau à calculer, seulement à le lire au bon endroit. Sans mesure : `distanceMeters` /
`durationSeconds` / `polyline` retombent à `null`, jamais `0` ni `''` — même discipline que le
correctif de contrat 1 de J24 (« une absence assumée plutôt qu'un chiffre faux »).

Rien à changer côté Odoo (`realtime_client.py::fetch_ride_measurement` traite déjà
`measured: false` comme « aucune accumulation », `None` en retour) ni côté contrat (`measured`
était déjà un booléen distinct, `distanceMeters`/`durationSeconds` déjà nullables depuis J24) : le
défaut vivait uniquement dans `handleRideMeasurement`.

### Tests

- `services/realtime/test/internal.test.ts` : le test qui affirmait `measured: true,
  distanceMeters: 0` juste après `ride.start` (avant toute position) est retourné —
  `measured: false`, `distanceMeters: null`, `polyline: null` désormais attendus à ce point précis
  de la séquence.

### Doute pour quelqu'un de réel

Ce correctif seul ne change rien tant que L6-05 n'émet aucune position réelle : une course jouée
de bout en bout se termine encore avec `measured: false` (au lieu de `true` avec un zéro trompeur)
— c'est le résultat honnête attendu, mais le résumé de fin dit toujours « Trajet non relevé ». La
tâche suivante de ce soir change cet état de fait.

---

## L6-05 — capture GPS chauffeur : réglable et instrumentée, pas optimisée à l'aveugle

### Le cadrage tenu

« Cette nuit ne produit pas une capture optimisée — elle produit une capture réglable et
instrumentée » : tenu au pied de la lettre. Aucune valeur codée en dur (invariant 5) — dix-sept
paramètres dans `apps/driver/config.ts`, tous lus depuis l'environnement de build avec un défaut
plausible, jamais calibré (même réserve que L2-05/L3-10). `position.update` avait un consommateur
réel depuis L3-02 mais aucun émetteur réel (`realtime-message-map.json` le disait explicitement :
« Émetteur manquant — tâche L6-05, non commencée ») — il en a un maintenant
(`apps/driver/src/location/tracker.ts`), câblage vérifié par le script de cartographie.

### Ce qui a été construit

`apps/driver/src/location/` : `adaptive.ts` (fonctions pures), `permissions.ts`, `background.ts`,
`tracker.ts` — plus `oneShot.ts`, l'ancien `location.ts` déplacé ici pour partager la même
permission de premier plan que la capture continue (une seule implémentation, jamais deux qui
pourraient diverger).

**Fréquence adaptative, sur quatre états** (`DriverActivityState`) : `offline` (aucune capture),
`online_idle` (très faible), `online_moving` (modérée), `in_ride` (élevée) — bascule immédiate à
chaque changement d'état, jamais au bout de l'ancienne cadence. **L'immobilité se détecte sur la
vitesse instantanée ET le déplacement cumulé sur une fenêtre glissante** (`MovementDetector`),
jamais un compteur seul (spécification) : un bruit GPS à l'arrêt ne franchit jamais le seuil de
déplacement cumulé, un déplacement lent et réel finit par le franchir.

**Agrégation avant envoi, au niveau du contrat lui-même.** `position.update` (C-02) portait un
point unique ; il porte désormais, en plus, `precedingSamples` — les points captés depuis le
dernier envoi, chacun avec son propre horodatage. Forme **additive** (défaut `[]`), donc
rétrocompatible avec tout appelant antérieur à ce soir. Le tampon se vide au premier des deux
déclencheurs : taille (`LOCATION_BATCH_SIZE`) ou délai maximal (`LOCATION_BATCH_MAX_WAIT_MS`) — ce
second seuil évite qu'un point capté juste avant un ralentissement de cadence reste en attente
indéfiniment. Le service temps réel traite un lot dans l'ordre chronologique, chaque point soumis
à la même validation de plausibilité (L3-02) qu'un point isolé (`tracking/ingest.ts`, refactoré en
boucle plutôt qu'en traitement d'un point unique — coeur inchangé, comportement identique quand
`precedingSamples` est vide).

**Ce détour a changé le sujet, et vaut d'être expliqué** : la version initiale envisagée
(reproduire l'agrégation uniquement côté application, sans toucher au contrat) s'est heurtée à un
fait vérifié dans le dépôt, pas supposé — `packages/api-client/src/realtime/connection.ts::send()`
traite `position.update` comme « la dernière position gagne », et l'envoie **immédiatement** dès
que la connexion est ouverte, à chaque appel. Empiler plusieurs appels `send()` depuis le tampon
n'aurait donc économisé aucun message sur le fil, seulement déplacé le problème — l'aggrégation
n'existerait que dans le tampon local, jamais dans ce qui part réellement. Le champ
`precedingSamples`, additif, résout ça sans casser ce que `connection.ts` faisait déjà (le
cache "dernière position" continue de fonctionner tel quel, sur l'enveloppe entière, lot compris).

**Permissions, arrière-plan, refus non bloquant.** Premier plan et arrière-plan
(`ACCESS_BACKGROUND_LOCATION`) demandées séparément — Android l'exige depuis la version 10 : une
demande groupée est refusée par le système sur les versions récentes. Un refus, quel qu'il soit,
ne lève jamais et ne bloque jamais l'app (critère 5) — seule la capture reste inactive, réessayée
à la cadence normale (jamais en boucle serrée) au cas où la permission serait accordée plus tard
depuis les réglages du téléphone. Notification persistante honnête (`background.ts`) posée dès
qu'un état non `offline` est atteint, effacée à l'instant du retour hors ligne.

**Le repli, décidé d'avance, atteignable par un réglage.** `LOCATION_DEGRADED_MODE` (booléen) :
vrai, `online_idle`/`online_moving` convergent vers une cadence unique très espacée
(`LOCATION_DEGRADED_ONLINE_INTERVAL_MS`) — `in_ride` n'est jamais affecté. On perd la fraîcheur du
géo-index hors course, on garde la flotte. Un changement de valeur, jamais un développement.

**Arrêt immédiat au passage hors ligne**, et à la perte de session (déconnexion, jeton de
renouvellement révoqué — ajouté en écrivant `tracker.ts`, `AuthClient.onSessionLost` n'était
abonné par aucun code de capture avant ce soir) : le tampon en attente est **jeté, pas envoyé** —
un chauffeur qui vient de finir sa journée ne doit plus émettre une seule position, y compris
celles captées dans les secondes précédentes.

**Instrumentation, ce que L6-17 mesurera** (`tracker.ts::getMetrics()`) : `positionsCaptured`,
`positionsSent`, `bytesSent` (taille JSON réelle des lots envoyés), `gpsActiveMs` (temps cumulé
d'un appel GPS en vol). Rien de plus ce soir — L6-17 est la tâche qui branchera un point de lecture
et un protocole de mesure sur un vrai terminal ; ces compteurs sont ce qu'elle lira, pas une
optimisation faite à l'aveugle à leur place.

### Un vrai bug de minuterie, trouvé en écrivant les tests

`scheduleNextCapture(delayMs)` utilisait `delayMs || interval` pour décider du délai réel —
en JavaScript, `0 || interval` vaut `interval`, pas `0`. Le seul appelant qui passait `0` en
voulant dire « immédiatement » (`recomputeState()`, à chaque changement d'état) programmait donc
en réalité le prochain relevé à la cadence de l'ANCIEN état, pas une capture immédiate. Trouvé en
écrivant `tracker.test.ts` (le test « en course… immédiatement » aurait échoué avec le code
d'origine), pas en relisant le code a posteriori — exactement ce que la suite de tests est censée
attraper avant qu'un humain n'ait à le faire. Corrigé : le paramètre est désormais un délai
littéral, jamais mélangé avec la cadence de l'état (`explicitDelayMs`, undefined = cadence
normale, toute valeur fournie — y compris 0 — utilisée telle quelle).

### L'écart, signalé plutôt que contourné

**Aucun vrai service de premier plan Android n'est démarré** (`amoa/questions/L6-05.md`). La
notification persistante donne l'apparence visuelle d'un tel service (non balayable, honnête sur
ce qui est collecté) mais ne lie aucun `startForegroundService` natif — aucune bibliothèque de ce
type n'est une dépendance de ce paquet aujourd'hui, et en ajouter une à l'aveugle (sans terminal
pour la calibrer) serait exactement le genre de choix à signaler plutôt qu'à trancher seul
(CLAUDE.md, « pas de dépendance nouvelle sans nécessité »). Conséquence concrète : Android peut
throttler les minuteurs JS de `tracker.ts` une fois l'app reléguée en arrière-plan prolongé,
au-delà de ce qu'aucun test ici ne peut prouver ni infirmer. Trois options posées dans l'écart,
aucune tranchée — la première (mesurer avant de décider) est un préalable aux deux autres.

### Tests

- `location/__tests__/adaptive.test.ts` (11 tests) : les quatre états et leurs cadences, le mode
  dégradé, la détection de mouvement (vitesse et déplacement cumulé, séparément et ensemble),
  fenêtre glissante, `reset()`.
- `location/__tests__/permissions.test.ts` (6 tests) : premier plan et arrière-plan, Android et
  iOS, accordée et refusée -- jamais d'exception.
- `location/__tests__/tracker.test.ts` (11 tests) : les cinq critères d'acceptation de la
  spécification (aucune capture hors ligne ; fréquence selon les quatre états ; agrégation par
  taille ET par délai ; continuité -- notification affichée/effacée ; refus de permission non
  bloquant), plus l'arrêt immédiat (hors ligne, perte de session), le repli, l'instrumentation.
- `packages/contracts/test/realtime.test.ts` : forme additive de `position.update`
  (`precedingSamples` par défaut vide, un lot valide avec plusieurs points).
- `services/realtime/test/ingest.test.ts` : un message agrégé traite chaque point dans l'ordre,
  la position stockée est la plus récente, chaque point compte dans les métriques de rejet/accept.
- `components/__tests__/AvailabilityToggle.test.tsx`, `screens/__tests__/HomeScreen.test.tsx` :
  double du singleton `locationTracker` -- sans lui, `setOnline(true)` dans un test démarrerait de
  vrais minuteurs GPS récursifs sur le singleton réel (trouvé en lançant la suite complète pour la
  première fois : `HomeScreen.test.tsx` faisait planter le worker Jest après son propre
  achèvement -- exactement le genre de fuite que ces doubles existent pour éviter).
- `docs/contracts/verify-realtime-message-map.js` : `position.update` passe de `pending` à
  `wired`, émetteur nommé.

### Doute pour quelqu'un de réel

**Tout ce qui précède est vérifié en JavaScript pur, contre des dépendances doublées.** Rien n'a
tourné sur un vrai téléphone, avec un vrai GPS, une vraie gestion de batterie de fabricant, un vrai
Doze mode Android. Les quatre cadences, les deux seuils de mouvement, la taille et le délai du
lot : dix-sept valeurs plausibles, aucune calibrée. C'est exactement le travail que L6-17 doit
faire, et pour lequel ce soir a posé les compteurs à lire.

### Réglages recommandés pour le premier jour du pilote, et les plus risqués

**Recommandés au démarrage, sans y toucher :**

- `LOCATION_CAPTURE_INTERVAL_RIDE_MS = 5000` et `LOCATION_BATCH_SIZE = 5` : en course, un lot part
  environ toutes les 25 secondes. C'est la donnée qui alimente le tracé (L3-10) et le suivi client
  (`driver.position`, diffusé à part, cadence propre) -- la moins risquée à laisser telle quelle,
  parce que c'est la plus courte durée d'exposition (une course dure rarement plus d'une heure).
- `LOCATION_DEGRADED_MODE = false` au premier jour, **mais l'interrupteur doit être vérifié
  fonctionnel avant le départ** (un test manuel : bascule à `true`, `make client`/`make driver`,
  observer la cadence hors course ralentir) -- c'est le levier à actionner en urgence si la
  batterie ne tient pas, il ne doit pas être découvert cassé le jour où il sert.

**Les plus risqués, à surveiller dès la première heure :**

- `LOCATION_CAPTURE_INTERVAL_IDLE_MS = 90000` (immobile) et `LOCATION_CAPTURE_INTERVAL_MOVING_MS
  = 15000` (en mouvement, hors course) : ce sont des suppositions pures, jamais mesurées contre un
  vrai chauffeur qui attend une course sur le bord d'une route à Douala. Trop courtes, elles
  videront la batterie avant la fin de la matinée -- c'est le risque nommé depuis le début de la
  nuit (« un chauffeur dont la batterie tient trois heures désinstalle l'application »). Trop
  longues, la position affichée aux clients (`nearby.drivers`) sera perçue comme périmée, et
  `L3-05` ne peut rien y faire : la fraîcheur qu'il diffuse dépend entièrement de ce que ce module
  lui fournit.
- **La fiabilité de la capture en arrière-plan prolongé** (voir l'écart ci-dessus) : c'est le
  risque qui ne se mesure pas en changeant une valeur, seulement en observant un vrai téléphone,
  écran éteint ou Google Maps au premier plan, pendant une heure. Si L6-17 montre une perte de
  capture significative, la première question à se poser est laquelle des trois options de
  `amoa/questions/L6-05.md` -- pas un réglage à ajuster dans `config.ts`.
- `LOCATION_IDLE_SPEED_THRESHOLD_MPS = 1.0` et `LOCATION_IDLE_DISPLACEMENT_THRESHOLD_METERS = 40` :
  si la détection de mouvement se trompe dans un sens (un chauffeur réellement en attente classé
  « en mouvement » en continu), la batterie en pâtit sans que personne ne comprenne pourquoi --
  c'est un mode de défaillance silencieux, à chercher en premier si la consommation mesurée par
  L6-17 dépasse le seuil attendu sans explication évidente.

---
