# Rapport de nuit — J28

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition
de fini). Lu en entier : `amoa/questions/REPONSES-2026-09-05.md`, l'écart `amoa/questions/L7-04.md`
(déposé J27), et les spécifications L7-04, L3-07 (cycle de proposition), L3-11 (resynchronisation).

Périmètre confié : **L7-04 en tâche pleine** — contrat, service temps réel, application — avec la
part native explicitement rattachée à L6-19.

---

## L7-04 — Notification de proposition au chauffeur

### Le trou, rappelé

L'écart de J27 avait établi que `ProposalScreen` ne revalidait rien auprès du serveur : il
recevait tous les détails par `route.params` depuis `proposal.new`, et n'avait aucun moyen
d'obtenir les détails ni l'échéance d'une proposition qu'il n'avait jamais reçue — le cas central
de L7-04, l'application fermée à l'émission. `session.resync` ne renvoyait rien sur une
proposition `proposed`.

### Ce qui a été fait

**1. Le contrat (`@babana/contracts`).**

- `session.synced` porte désormais `activeProposal` : `ActiveProposalSchema` (même forme que
  `proposal.new`, plus `emittedAt`) **ou `null` explicite**. C'est l'Option A de l'écart —
  réutiliser le chemin de resynchronisation existant plutôt qu'ajouter une paire de messages —
  rendue **explicite** comme le prompt l'exigeait : l'absence se dit (`null`), elle ne se déduit
  pas d'un `proposal.new` qui n'arrive pas (l'inférence par le silence que D49 a supprimée).
- Nouveau message client→serveur `proposal.seen { rideId, emittedAt }` — purement télémétrique,
  jamais mis en file hors connexion (comme `position.update`).

**2. Le service temps réel.**

- **Les deux durées alignées.** `propose()` stocke maintenant dans l'enregistrement Redis de la
  proposition (`proposalRecordKey`) l'`expiresAt` réel — `Date.now() +
  PROPOSAL_ACCEPTANCE_TIMEOUT_SECONDS` — et l'`emittedAt`. Auparavant seul le TTL de la clé était
  disponible, et ce TTL est `RESERVATION_TTL_SECONDS` : une durée **voisine mais distincte** (la
  marge de sécurité qui doit survivre au minuteur JS, `config.ts` `.refine`). Un compte à rebours
  dérivé du TTL aurait affiché trente-cinq secondes là où il en restait vingt. Les TTL Redis
  n'ont pas bougé — c'est la véritable échéance qui est désormais portée explicitement, pas
  devinée d'une durée qui n'est pas la sienne.
- `ProposalLifecycle.peekActiveProposal(driverId)` : relit — sans consommer — la proposition
  active, et renvoie `null` si elle est déjà échue (`expiresAt <= now`) ou déjà résolue
  (`proposalRideIdKey` effacée par un chemin de résolution). Une notification ouverte vingt
  secondes trop tard n'ouvre donc jamais un écran de décision (critère 3).
- `ws/resync.ts` inclut `peekActiveProposal` dans `session.synced` (chauffeur uniquement ;
  toujours `null` pour un client). Sur Odoo injoignable, `session.synced` n'est pas envoyé du
  tout — comportement L3-11 inchangé, `activeProposal` ne part jamais seul.
- `proposal/notify.ts` : `notifyDriverOfProposal` — appel non bloquant vers Odoo
  (`/api/internal/drivers/proposal-push`), **en parallèle** de `proposal.new`, jamais à sa place
  (critère 1). Le service temps réel n'a pas de canal push à lui (invariant 1 : ni PostgreSQL —
  donc pas la table des jetons — ni SDK Firebase) : il délègue à l'unique émetteur FCM,
  `services/push.py`. Injectable dans `ProposalLifecycle` pour les tests.
- `proposal/delivery-metrics.ts` : `ProposalDeliveryMetrics` (même patron que `ExpansionMetrics`)
  — délai émission → affichage, compteur de dépassement du budget d'acceptation, écarte les
  valeurs non plausibles. Alimenté par `proposal.seen` dans `ws/dispatch.ts`.

**3. Odoo.**

- `POST /api/internal/drivers/proposal-push` : résout le compte du chauffeur, compose un
  `PushMessage` **minimal** (« Nouvelle course proposée » / « Ouvrez l'application pour répondre »
  — ni montant, ni point, l'écran verrouillé est lisible par un tiers), **haute priorité**
  (réveille l'appareil), `collapse_key` (une seule proposition à la fois), données de routage
  (`type: proposal`, `rideId`, `expiresAt`). Envoi asynchrone via `notify_users_async`
  (`cr.postcommit` + fil de fond, discipline L7-01). Un chauffeur sans `res.users` →
  `{ notified: false }`, pas une erreur.

**4. L'application Chauffeur.**

- `proposalDedup.ts` : **un seul registre** de déduplication par `rideId`, partagé par les deux
  sources — le WebSocket (`HomeScreen`) et la notification (`push/handlers.ts`). Comme l'écart le
  demandait, la déduplication existante est **complétée** pour la source distante, pas doublée.
  Un chauffeur connecté qui reçoit le message temps réel **et** la notification ne voit qu'un
  écran.
- `push/handlers.ts` : `routeProposalNotification` (décision pure : `shown` / `duplicate` /
  `ignored`) + `handleProposalPushMessage` (le point d'entrée que le binding natif de **L6-19**
  appellera). Navigation différée si la nav n'est pas encore prête (démarrage à froid depuis un
  appui sur la notification) — `HomeScreen` la consomme à son montage. **Rien de natif ici** :
  recevoir réellement un message Firebase exige un build mobile ; la logique de routage et de
  déduplication, elle, s'écrit et se teste sans SDK, et c'est fait.
- `ProposalScreen` : deux modes. `source: 'realtime'` — détails d'emblée, comme avant.
  `source: 'notification'` — l'écran **revalide** (une `session.resync` forcée) et **attend** un
  `session.synced` explicite : soit une `activeProposal` pour ce `rideId` (détails + véritable
  échéance), soit `null` → « Cette course n'est plus à prendre. » et retour automatique. Aucun
  délai inventé, aucune conclusion tirée d'un silence.
- `proposal.seen` est signalé **une fois**, au premier affichage réel des boutons, avec
  l'`emittedAt` d'origine — quelle que soit la source.
- `HomeScreen` ouvre aussi l'écran sur `session.synced.activeProposal` non nul : une proposition
  retrouvée après une reconnexion ou une relance de l'app, même sans notification (recouvre aussi
  L7-06 critère 5).
- `navigationRef` déplacé dans `navigation/ref.ts` pour que `push/handlers.ts` l'importe sans
  cycle avec `navigation/index.tsx`.

### Critères d'acceptation

1. **La notification part en parallèle du WebSocket, pas à sa place** — `notifyDriverOfProposal`
   appelé inconditionnellement dans `propose()`, prouvé même chauffeur connecté
   (`proposal.test.ts`).
2. **La déduplication empêche un double affichage** — registre partagé `proposalDedup`, prouvé
   côté `HomeScreen` (WS puis `session.synced`) et `push/handlers` (WS puis notification).
3. **Une notification ouverte après expiration affiche un message clair, pas les boutons** —
   `peekActiveProposal` renvoie `null` sur échéance dépassée ; `ProposalScreen` mode notification
   affiche « plus à prendre » et revient.
4. **Le délai d'acheminement est mesuré et exposé en métrique** — `proposal.seen` →
   `ProposalDeliveryMetrics.snapshot()`.

### Ce qui reste explicitement à L6-19

Le binding natif FCM dans `apps/driver` — recevoir réellement un message, app fermée. `L7-01` a
été construite pour que ce soit la seule pièce cliente manquante ; `handleProposalPushMessage` est
le point d'accroche. Troisième dépendance native après le service de premier plan (L6-05) et le
sélecteur de pièces (L6-15), toutes trois pour la même session avec appareil.

### Tests

- `@babana/contracts` : `session.synced` avec/sans `activeProposal` (requis, `null` explicite),
  `proposal.seen` (payload `emittedAt` requis).
- `services/realtime` : `proposal.test.ts` — notification en parallèle, alignement des deux
  durées (échéance ≈ acceptation, pas ≈ réservation), `peekActiveProposal` (vivante / échue /
  résolue / jamais posée) ; `resync.test.ts` — `activeProposal` restitué avec sa vraie échéance,
  `null` pour un chauffeur sans proposition, jamais consulté pour un client ;
  `proposal-delivery.test.ts` — la classe de métriques, et le câblage `proposal.seen` → métrique
  (garde de rôle comprise).
- Odoo : `test_internal_controller.py` — `proposal-push` compose un message minimal, haute
  priorité, données de routage, pour le bon compte (interception à la frontière
  `notify_users_async`, cf. `odoo-pitfalls.md` « `cr.postcommit` ne s'exécute jamais dans un
  test ») ; chauffeur sans compte → pas d'envoi ; driver inconnu → 400 ; secret absent → 401.
- `apps/driver` : `push/__tests__/handlers.test.ts` (routage + dedup partagée) ; `HomeScreen` —
  ouverture depuis `proposal.new` (avec `emittedAt`) et depuis `session.synced.activeProposal`,
  `null` n'ouvre rien, dedup WS+resync ; `ProposalScreen` — `proposal.seen` à l'affichage (une
  fois), mode notification (revalide, remplit, ou « plus à prendre » + retour), `proposal.new`
  qui rattrape.

---

## Qu'est-ce qui me laisse un doute pour quelqu'un de réel

1. **Le premier vrai réveil d'un téléphone reste une inconnue.** Toute la chaîne — `propose()` →
   Odoo → `notify_users_async` → FCM HTTP v1 → appareil endormi → `handleProposalPushMessage` →
   `ProposalScreen` mode notification → `session.resync` → affichage — n'a jamais tourné bout en
   bout sur un appareil. Chaque maillon est testé isolément ; leur composition en conditions
   réelles (veille profonde, gestionnaire de batterie agressif, réseau de Douala) est
   précisément ce que L6-19 doit mesurer. Sans elle, on ne sait pas si un chauffeur endormi voit
   la course en cinq secondes ou en quarante.

2. **La métrique de délai porte deux imprécisions assumées.** `delayMs` = `réception du
   proposal.seen` − `emittedAt`, à l'horloge du serveur : il **inclut** la latence de remontée du
   `proposal.seen` (le chauffeur a vu la proposition un peu plus tôt), et il **exclut** tout
   écart d'horloge appareil/serveur (les deux bornes sont serveur). Au pilote, avec un volume
   faible, c'est le bon compromis — mais un `delayMs` de huit secondes peut vouloir dire « vu en
   six, remonté en deux ». Documenté dans `delivery-metrics.ts`.

3. **Odoo injoignable pendant une resynchronisation prive le chauffeur de sa proposition
   retrouvée.** `session.synced` bail entièrement si `fetchActiveRide` échoue (comportement L3-11
   voulu : ne jamais renvoyer `activeRideId: null` par défaut). L'`activeProposal`, elle, est
   locale et aurait pu partir — mais la mélanger à un `activeRideId: null` trompeur serait pire.
   L'app resynchronise à la reconnexion suivante et `ProposalScreen` mode notification affiche
   « Vérification… » en attendant. Acceptable, mais c'est une fenêtre où une vraie proposition
   vivante n'est pas montrée.

4. **`ProposalScreen` mode notification attend indéfiniment si `session.resync` ne revient
   jamais.** Pas de délai de repli — c'était la consigne (aucun délai inventé sur ce réseau).
   Hors connexion, `session.resync` est mis en file et part à la reconnexion, donc l'attente se
   résout dès que le réseau revient. Mais si la connexion ne revient pas du tout, l'écran reste
   sur « Vérification… » jusqu'à ce que le chauffeur en sorte. C'est honnête (on ne prétend rien
   qu'on ne sait pas) mais peu confortable.

---

## Passe finale

`make reset && make up && make lint && make typecheck && make test` sur base fraîche :

- **`make lint`** et **`make typecheck`** : aucun problème, les neuf espaces de travail.
- **Odoo** : `0 failed, 0 error(s) of 2309 tests` (2305 à J27 ; +4 = les nouveaux
  `test_proposal_push` de `test_internal_controller.py`).
- **npm** : `@babana/api-client` 80, `@babana/contracts` 79 (+1), `@babana/maps` 19,
  `@babana/navigation` 4, `@babana/realtime` 205 (+17), `@babana/client` 106, `@babana/driver`
  159 (+16) — tous verts.
- **`@babana/concurrency-tests`** (Redis + Odoo réels, L3-13) : scénario d'acceptation concurrente
  (20 × 8 appels simultanés) vert ; la passe `make` a été interrompue par l'environnement pendant
  ce dernier espace de travail, la suite a été relancée seule et terminée.
- **verify-ride-state-machine** et **verify-realtime-message-map** : OK — 23 messages du contrat
  cartographiés (`proposal.seen` câblé, `session.synced` complété par `activeProposal`).
