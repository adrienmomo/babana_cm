# Rapport de nuit — J26

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini). `amoa/questions/REPONSES-2026-09-03.md` lu en entier, `§4 bis` de `01-architecture.md`
(D12 réexaminée et maintenue) relu, avant d'ouvrir quoi que ce soit. Spécifications lues :
L6-05 (précision du 3 septembre), L6-15 et ses dépendances L1-05 et L9-01/L9-03, L7-01, L7-04 et
sa dépendance L3-07.

Périmètre confié : **la notification qui constate** (amendement L6-05), **L6-15** (inscription
chauffeur), **L7-01** (Firebase Cloud Messaging, cycle de vie des jetons d'appareil), **L7-04**
(notification de proposition au chauffeur hors connexion). Consigne : si le lot ne passe pas en
entier, s'arrêter après L6-15.

Branches par tâche. `make reset` et la passe complète en fin de session.

---

## La notification qui constate (amendement L6-05)

### Ce que la précision du 3 septembre change

Sans service de premier plan Android natif (`amoa/questions/L6-05.md`, non tranché — c'est une
mesure qui manque, pas une décision), rien ne garantit que les minuteurs de capture survivent au
passage en arrière-plan prolongé. Or D12 y envoie l'application **pendant toute la course**
(§4 bis). Une notification persistante qui affiche « suivi actif » affirme donc ce qu'elle ne
peut pas tenir.

`amoa/specs/L6-mobile.md` (L6-05) et `REPONSES-2026-09-03.md` §2 tranchent : elle affiche **quand
la dernière position est réellement partie** — « il y a N minutes ». Elle cesse d'affirmer et se
met à constater. Et elle devient le diagnostic dont la mesure GPS aura besoin : celui qui tient le
téléphone voit si la capture a calé, sans interroger le serveur.

### Ce qui a été fait

**`location/background.ts`** : `showTrackingNotification()` (texte statique « Partage de votre
position en cours ») devient `updateTrackingNotification(message)` + `formatLastSentMessage(lastSentAtMs,
nowMs)`, fonction pure qui compose le fait :

- `null` (aucune position partie depuis le passage en ligne) → « En ligne — position pas encore
  envoyée. » Le cas transitoire des premières secondes ; s'il persiste, la notification reste
  bloquée là plutôt que de progresser — c'est déjà un signal.
- 0 minute → « Dernière position envoyée à l'instant. »
- N ≥ 1 → « Dernière position envoyée il y a N minute(s). » Singulier/pluriel gérés.
- Horloge qui recule → borné à 0, jamais un nombre négatif.

`nowMs` est **fourni par l'appelant**, jamais `Date.now()` dans ce module : `tracker.ts` passe la
même horloge que le reste de sa logique, testable en horloge virtuelle.

**`location/tracker.ts`** : trois points d'accroche pour recomposer le texte —

1. au passage en ligne (`recomputeState`, branche `wasOffline`) : `lastPositionSentAtMs` remis à
   `null`, notification reposée, minuteur de réaffichage démarré ;
2. à chaque `flush()` réellement parti sur le fil : `lastPositionSentAtMs = now`, notification
   reposée (« à l'instant ») ;
3. périodiquement (`startNotificationTimer`, `setInterval`) : **c'est ce réaffichage qui fait
   grandir « il y a N min » quand plus aucune position ne part.** Sans lui, la notification
   resterait figée sur le dernier envoi réussi et rassurerait à tort — exactement l'inverse de
   l'intention. Cadence lue de `LOCATION_NOTIFICATION_REFRESH_MS` (config, 60 s par défaut, la
   granularité du message), jamais codée en dur (invariant 5).

Au passage hors ligne : minuteur de réaffichage arrêté, `lastPositionSentAtMs` remis à `null`,
notification effacée — elle ne survit pas à ce qu'elle annonce. Un retour en ligne repart de
« pas encore envoyée » plutôt que de rejouer un « à l'instant » périmé.

`AdaptiveCaptureConfig` gagne `notificationRefreshMs` (déjà le lieu de `batchSize`/`batchMaxWaitMs`,
qui ne sont pas non plus « adaptatifs » au sens strict — tout ce que `tracker.ts` doit régler).

### Tests

- `location/__tests__/background.test.ts` (nouveau) : `formatLastSentMessage` sur les quatre cas
  + l'horloge qui recule.
- `location/__tests__/tracker.test.ts` : trois tests ajoutés —
  - « pas encore envoyée » avant tout envoi, « à l'instant » juste après le premier `flush` ;
  - **le diagnostic** : GPS qui ne rend plus rien après un premier envoi, le réaffichage
    périodique fait passer le texte à « il y a 1 minute » puis « il y a 3 minutes » sans qu'aucun
    nouvel envoi n'ait lieu ;
  - le passage hors ligne efface la notification et son horodatage ; le minuteur de réaffichage
    ne continue pas après.
- `location/__tests__/adaptive.test.ts` : le littéral `AdaptiveCaptureConfig` complété.

`npm test` (workspaces) vert, `tsc --noEmit` et `eslint` verts sur `@babana/driver`.
