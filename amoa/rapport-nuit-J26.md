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

---

## L6-15 — inscription chauffeur

### Le blocage que ça lève

Avant ce soir, aucun vrai chauffeur ne pouvait entrer dans le système : `DriverAppSwitch`
routait tout statut non `approved` vers un `PlaceholderScreen` (« Dossier en cours de validation
— écran à venir, L6-15 »). Un blocage dur du pilote, pas une finition.

### Deux dépendances absentes, constatées dans le dépôt — `amoa/questions/L6-15.md`

Vérifié avant d'écrire, pas supposé (CLAUDE.md, 15 août) :

- **L1-09 (vérification du numéro) n'a aucun back-end** : `@babana/contracts` déclare
  `phoneVerifyStart`/`phoneVerifyConfirm`, mais il n'y a ni `controllers/phone.py`, ni
  `services/sms.py`, ni modèle — et `endpoint-coverage.test.ts` les classe déjà en
  `NOT_YET_IMPLEMENTED`. Le découpage (§5) donne à L6-15 les dépendances **L6-02 et L1-05**
  seulement, et **aucun des cinq critères d'acceptation** ne porte sur le téléphone. L'étape
  « vérification du numéro » n'est donc pas construite : la brancher sur un 404 serait du
  théâtre. Elle s'insérera dans `resolveOnboardingRoute` quand L1-09 atterrira.
- **Aucune bibliothèque native de capture / compression d'image** dans `apps/driver` — même
  situation que le service de premier plan de L6-05, même règle (signaler, pas ajouter à
  l'aveugle). La sélection + compression est isolée derrière `ImageSource`, injectée aux écrans ;
  la valeur par défaut **échoue franchement** (jamais d'image inventée, principe de D43).

### Contrat (C-01) — extension additive

`GET /api/v1/driver/documents` : liste des documents du chauffeur courant avec
`verificationStatus`, `rejectionReason` (renseigné seulement si rejeté, `null` sinon — D30),
`expiresOn`, `uploadedAt`. Le contrat n'avait qu'un endpoint d'écriture et un d'URL signée ; les
critères 3 et 5 exigent une lecture. Même précédent que L2-04 / L3-04. Enregistré dans
`HTTP_ENDPOINTS`, exercé contre le vrai Odoo par `endpoint-coverage.test.ts` (C-01 critère 6).

### Odoo

- `controllers/documents.py` : `GET /driver/documents` — même chemin que l'upload, méthode
  distincte. Ne renvoie que **le plus récent par type** : un document renvoyé après rejet ajoute
  une ligne (l'upload crée toujours), l'ancienne reste en base pour l'audit, l'app ne voit que
  l'état courant.
- `babana.driver` : `document_ids` (One2many) — nécessaire à la lecture et à la vue.
- `babana.driver.document` : `action_verify` / `action_reject(reason)` (motif obligatoire,
  journalisé au fil du dossier), plus une contrainte `_check_rejected_requires_reason` qui vaut
  aussi pour l'édition inline. Le minimum pour que « le refus se dit avec son motif » ne soit pas
  du décor : un gestionnaire vérifie/rejette depuis la fiche chauffeur (page « Documents »
  ajoutée à la vue). L'assistant dédié et la notification push restent L9-01 / L7-03.
- Tests : `test_documents.py` — projection JSON (motif présent seulement si rejeté), liste par
  type, un seul état par type après renvoi, refus d'un compte non-chauffeur ; `action_verify` /
  `action_reject` et la contrainte de motif. 15 tests ciblés verts sur base à jour (`-u babana`).

### `@babana/api-client`

`createDriverDocumentUploader` (`src/documents/`) : le seul chemin `multipart/form-data` du
client — `createHttpClient` sérialise toujours en JSON. En-tête `Authorization`, catalogue
d'erreurs C-01, et renouvellement transparent (un `refresh` + un unique réessai sur
`TOKEN_EXPIRED`, comme `withTransparentRefresh`). La **lecture** passe par le client REST
générique (`apiClient.request('listDriverDocuments')`), rien de spécial. 5 tests.

### App Chauffeur

- `screens/onboarding/` : `ProfileScreen` (confirmation de l'identité Google), `DocumentsScreen`
  (dépôt, une ligne indépendante par pièce), `PendingScreen` (état précis de chaque pièce,
  motif + « Renvoyer ce document » sur un rejet).
- `state.ts` : dérivation pure de l'avancement (`documentSlots`, `resolveOnboardingRoute`) +
  persistance AsyncStorage (drapeau « profil confirmé », photos en attente d'envoi), cloisonnée
  par utilisateur.
- `useOnboarding` : **reprenable** (critère 1) — l'écran d'entrée se calcule à l'ouverture depuis
  l'état serveur (`GET /driver/documents`) + le drapeau local. Rouvrir l'app retombe sur la bonne
  étape. Hors ligne : parcours utilisable, tout « à déposer », l'envoi retentera.
- **Le téléversement survit à une coupure** (spécification) : la photo prise puis compressée est
  persistée **avant** l'envoi ; un échec réseau laisse un bouton « Réessayer l'envoi » qui rejoue
  le **même fichier** — le chauffeur ne reprend pas la photo. Une erreur métier (type MIME)
  abandonne le fichier et demande une nouvelle photo.
- **Compression** (critère 2) : le plafond (`ONBOARDING_MAX_DOCUMENT_BYTES`, config, 4 Mio par
  défaut, bien sous les 10 Mio serveur) est passé à `imageSource.pick` ; une image encore trop
  lourde n'est jamais envoyée.
- Navigation : `PendingNavigator` (placeholder) remplacé par `OnboardingNavigator`.
  `DriverPendingParamList` → `DriverOnboardingParamList` (`Profile`/`Documents`/`Pending`,
  `Documents` porte `focusType` pour revenir renvoyer une pièce précise).
- `AppNavigator.test.tsx` : les 4 cas qui vérifiaient le texte du placeholder vérifient
  maintenant l'entrée dans le parcours réel — l'invariant de L6-00 (critère 5 : un chauffeur non
  approuvé n'atteint aucun écran de course) reste testé. Arbres démontés en `afterEach` : l'effet
  asynchrone de `useOnboarding` ferait fuir un `setState` sinon (« worker failed to exit »).
- 8 nouveaux fichiers de test, 31 tests d'inscription. `@babana/driver` : 22 suites / 137 tests,
  `tsc` et `eslint` verts, aucune fuite de minuteur.

### Ce qui me laisse un doute pour quelqu'un de réel

- **Sans sélecteur de photo natif, un vrai chauffeur ne peut pas encore déposer une pièce.**
  Tout le reste — reprise, compression, survie à la coupure, renvoi ciblé, motif de rejet — est
  réel et testé, mais l'ouverture de l'appareil photo est un `throw` explicite en attendant la
  bibliothèque native (à valider sur le terminal du pilote, comme L6-05). C'est le trou visible
  demain matin.
- **L'écran d'attente ne dit rien du dossier rejeté globalement.** Un `driverStatus: 'rejected'`
  ou `'suspended'` (le dossier entier, décidé par un gestionnaire, avec son motif) route
  aujourd'hui vers le parcours d'inscription comme un `pending`. Le motif du refus global vit sur
  `babana.driver.rejection_reason` mais ne voyage pas dans `AuthenticatedUser` — c'est L6-11 /
  L7-03 qui le portera. Un chauffeur rejeté verra donc « déposez vos pièces » au lieu de « votre
  dossier a été refusé : <motif> ».
- **Pas d'aperçu des pièces déjà déposées.** L'app affiche l'état (`pending`/`verified`/
  `rejected`) mais ne re-télécharge pas la photo par URL signée pour la montrer au chauffeur. Ce
  n'est dans aucun critère, mais un chauffeur qui a un doute sur la photo qu'il a envoyée ne peut
  pas la revoir.
- **La vérification back-office est minimale.** Édition inline dans la fiche chauffeur, pas
  d'assistant, pas d'aperçu du fichier depuis le formulaire, pas de notification au chauffeur
  (L7-03). Un gestionnaire peut rejeter avec un motif ; le chauffeur le voit à sa prochaine
  ouverture de l'app, pas par une notification.
