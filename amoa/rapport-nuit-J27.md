# Rapport de nuit — J27

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini). `amoa/questions/REPONSES-2026-09-04.md` lu en entier, ainsi que les quatre points
d'attention consignés dans `amoa/rapport-nuit-J26.md` pour L7-01 et L7-04.

Périmètre confié :

1. **Le dossier refusé se dit** — statut et motif dans la session, trois situations distinctes à
   l'écran de suivi de dossier.
2. **L7-01** — Firebase Cloud Messaging, cycle de vie des jetons d'appareil.
3. **L7-04** — notification de proposition au chauffeur hors connexion.

Consigne : si le lot ne passe pas en entier, s'arrêter **après L7-01** — un jeton d'appareil sans
notification qui l'utilise reste utile, l'inverse ne l'est pas.

Spécifications lues : L7 en entier (L7-01 à L7-06), L3-07 (dépendance de L7-04). Branches par
tâche. `make reset` et la passe complète en fin de session.

---

## 1. Le dossier refusé se dit

### Le trou

Un `driverStatus: 'rejected'` ou `'suspended'` — le dossier entier, décidé par un gestionnaire,
avec son motif — était routé exactement comme un `pending` : `DriverAppSwitch` envoyait tout
statut non `approved` dans `OnboardingNavigator`, qui calculait `Profile` faute de mieux. Un
chauffeur refusé voyait « déposez vos pièces » et redéposait les mêmes pièces, refusées de
nouveau, sans jamais savoir pourquoi. Le motif vivait sur `babana.driver.rejection_reason` mais
ne voyageait pas jusqu'à l'app.

C'est la règle déjà écrite dans la spécification de L6-15, appliquée cette fois au dossier
entier : « en cours de validation » n'est pas une information.

### Le motif voyage dans la session

**Contrat (C-01, extension additive)** — `AuthenticatedUserSchema` (donc la réponse de
`/auth/google`, de `/auth/refresh` et de `GET /me`, une seule définition) gagne
`driverRejectionReason: string | null`. Même règle de non-omission que le motif d'un document
rejeté (D30) : renseigné quand `driverStatus` vaut `rejected`/`suspended`, `null` explicite le
reste du temps, jamais une clé absente. L7-03 portera la même donnée par notification ; ici elle
voyage dans la session pour que l'écran de suivi de dossier la dise dès l'ouverture, sans
dépendre d'une notification qui a pu se perdre.

**Odoo** — `_build_user_payload` (`controllers/auth.py`) ajoute le champ pour un compte
chauffeur. La suspension, jusqu'ici, ne faisait que **poster** son motif au fil : `action_suspend`
le **persiste** désormais sur `rejection_reason` (c'est lui que la session lit). Symétrie tenue :
`action_approve` et `action_reactivate` effacent `rejection_reason` — un dossier d'abord rejeté
puis approuvé ne doit pas continuer de porter son ancien motif jusqu'à l'app. Le champ est
renommé « Motif de rejet ou de suspension » et documenté.

### Trois situations, trois écrans

`resolveOnboardingRoute(slots, profileAcknowledged, driverStatus)` gagne un troisième argument et
une branche prioritaire :

- **refusé** (`rejected` ou `suspended`) → nouvel écran `Rejected` : le motif en évidence, et un
  bouton « Corriger et renvoyer mes pièces » qui ramène à `Documents`. Prime sur tout le reste,
  profil non confirmé compris — un dossier refusé ne se raconte pas comme une inscription en
  cours.
- **incomplet** (un document manquant ou rejeté) → `Documents` : la pièce à (re)déposer, nommée
  (inchangé).
- **en cours de validation** (tout est déposé) → `Pending` : rien à faire qu'attendre (inchangé).

`RejectedScreen` distingue « Votre dossier n'a pas été retenu » (rejet) de « Votre compte est
suspendu », affiche le motif (ou, s'il manque — ne devrait pas, obligatoire côté Odoo —, le dit
plutôt qu'un vide), et garde le bouton contre un double appui par une garde synchrone.
`useOnboarding(userId, driverStatus)` recalcule l'écran d'entrée quand le statut change ; le
défaut-refus est préservé : un `driverStatus` absent (rafraîchissement de session échoué hors
ligne) reste routé vers l'inscription, jamais vers `Rejected` ni vers les écrans de course.

### Tests

- `test_me_controller.py` : un chauffeur `rejected` puis un `suspended` portent statut **et**
  motif dans `/me` ; un `pending` porte `driverRejectionReason: null` (non-omission).
- `test_driver_approval.py` : `action_suspend` persiste son motif ; `action_reactivate` et
  `action_approve` l'effacent.
- `state.test.ts` : `resolveOnboardingRoute` route `rejected`/`suspended` vers `Rejected` quel
  que soit l'état des pièces et du profil ; `pending`/`approved`/inconnu n'y vont jamais.
- `AppNavigator.test.tsx` : un chauffeur `rejected`/`suspended` voit l'écran de dossier refusé
  avec son motif, jamais les écrans de course ni « Votre inscription » ; un statut inconnu reste
  en défaut-refus.
- `RejectedScreen.test.tsx` (nouveau) : motif affiché, resoumission déclenchée une seule fois,
  titre distinct par statut, absence de motif dite.

### Au passage — un test instable réparé

`ProposalScreen.test.tsx` échouait une fois sur deux dans la suite complète (« compte à rebours
attendu 30, reçu 27 »), jamais isolément. Cause : `PARAMS.expiresAt` était calculé à l'heure
**réelle** du chargement du module, alors que `Date.now()` vu par l'écran est **gelé** par
`jest.useFakeTimers()` à l'heure réelle du `beforeEach` ; sous forte charge (24 fichiers de test
en parallèle, un de plus avec `RejectedScreen`), l'écart entre les deux dépasse trois secondes.
`expiresAt` est désormais recalculé dans `beforeEach`, après l'installation des faux minuteurs.
Vérifié : suite chauffeur verte cinq fois de suite. C'est un défaut préexistant que ce lot a
seulement rendu systématique — non-régression, pas contournement (CLAUDE.md : un test instable
est un défaut).

### Ce qui me laisse un doute pour quelqu'un de réel

- **`RejectedScreen` ne relit pas le statut du dossier.** Un chauffeur qui renvoie ses pièces
  reste `rejected` au niveau session jusqu'à ce qu'il rouvre l'app (là, `useSession` rappelle
  `GET /me`). Il atterrit sur `Pending` après resoumission, ce qui est correct, mais s'il ne
  ferme jamais l'app il ne verra pas un éventuel passage à `approved`. Un bouton « vérifier mon
  dossier » qui force un rafraîchissement de session serait le complément honnête — hors des
  critères, noté.
- **`suspended` et `rejected` partagent le même écran et le même geste.** Une suspension est
  souvent comportementale, pas documentaire : « renvoyer mes pièces » n'est pas toujours le bon
  remède. Le motif est affiché, donc le chauffeur sait ; mais l'app n'offre pas de chemin vers
  le support. À rediscuter avec L7-03 / le back-office superviseur.

---

## 2. L7-01 — Firebase Cloud Messaging, cycle de vie des jetons d'appareil

Le piège est le cycle de vie, pas l'intégration : un jeton périmé qui reste en base envoie dans
le vide et **ment silencieusement** sur une notification qu'on croit délivrée. Tout est construit
autour de ce point.

### Le modèle : ajouter, jamais écraser ; nettoyer sur signal, jamais deviner

`babana.device.token` (`user_id`, `token`, `platform`, `registered_at`, `last_used_at`,
`active`). Contrainte unique sur le **couple** `(user_id, token)` seulement :

- un compte, plusieurs appareils → plusieurs lignes ;
- un appareil, plusieurs comptes (partagé, ou réinstallé) → plusieurs lignes, pas de doublon
  silencieux ni de violation de contrainte. La première réinstallation d'un chauffeur ne casse
  rien.

Le champ `active` d'Odoo (archivage) porte la désactivation : un jeton désactivé sort
**automatiquement** de `_active_tokens_for_users` (filtre implicite), la table ne se vide jamais
(audit), et un jeton qui redevient valide se réactive sans doublon. Le nettoyage se fait dans
**un seul endroit** — `dispatch`, sur retour d'envoi du fournisseur (`PushResult.invalid_tokens`)
— jamais par un cron qui balaie. Un jeton d'enregistrement signalé invalide est désactivé **pour
tous les comptes** qui le portent, pas seulement celui de l'envoi en cours.

> Note de nommage : la méthode d'upsert s'appelle `_register_token`, pas `_register` — ce
> dernier est un attribut réservé du métaclasse ORM d'Odoo (un booléen), qui écrasait
> silencieusement la méthode (`'bool' object is not callable`). Trouvé en exécutant les tests,
> pas supposé.

### `services/push.py` — deux implémentations, D19 et D43

`PUSH_PROVIDER` choisit :

- **`console`** (défaut) — le simulateur : journalise la notification et la garde en mémoire
  (`recent_sent`) pour inspection. Aucun compte Firebase requis pour un parcours complet
  (critère 4). C'est l'exception que la stratégie de simulation nomme explicitement (05 §2) :
  FCM ne se simule pas par « même code, autre URL », il se remplace.
- **`fcm`** — Firebase Cloud Messaging HTTP v1 (OAuth2 par compte de service, assertion JWT
  RS256 via PyJWT, aucune dépendance nouvelle). Exige `FCM_PROJECT_ID` / `FCM_CLIENT_EMAIL` /
  `FCM_PRIVATE_KEY` ; **aucun repli** si l'une manque (D43) — non configuré, on lève, plutôt que
  de retomber en silence sur le simulateur ou sur un envoi inattendu depuis un environnement de
  dev. Ce chemin n'est pas exercé ici (aucun compte Firebase) — même statut que le chemin réel
  de `google_identity.py` / `routing.py`.

Défaut = simulateur, jamais le vrai fournisseur : les deux règles du prompt tenues ensemble.

### Envoi asynchrone, isolé de toute transaction (critères 3 et 5)

`notify_users_async(env, users, message)` **n'enregistre qu'un point d'accroche `cr.postcommit`**
— rien n'est envoyé pendant la transaction (critère 3), et `cr.postcommit` n'exécute son
callback qu'après un COMMIT réussi (même discipline D32/D33 que `services/realtime_client.py`).
Le callback lance un **fil de fond** qui ouvre son propre curseur (`odoo.registry(db).cursor()`),
appelle `dispatch`, et **avale toute exception** : un envoi lent ou raté ne fait échouer aucune
transaction métier (critère 5). `dispatch` lui-même est isolé de tout fil/curseur pour être
testable directement.

### Contrat et endpoints (C-01, extension additive)

`devices.ts` : `POST /api/v1/devices` `{token, platform}` → `{registered: true}` (enregistre ou
réactive) ; `POST /api/v1/devices/deactivate` `{token}` → `{deactivated: true}` (déconnexion
volontaire, idempotent). Enregistrés dans `HTTP_ENDPOINTS`, projetés dans `docs/contracts/
http-api.md`, et exercés contre le vrai Odoo par `endpoint-coverage.test.ts` (C-01 critère 6 —
la vérification de complétude aurait fait échouer la suite si je les avais oubliés).

### `@babana/api-client/src/push/` — le SDK natif reste derrière une frontière injectée

`createPushRegistrar({ apiClient, binding, platform })` : `register()` (à la connexion) demande
l'autorisation, lit le jeton, l'enregistre, et s'abonne aux **rotations** (re-enregistrement à
chaque nouveau jeton). `unregister()` (déconnexion) désactive côté serveur. `register()` **ne
rejette jamais** — un refus d'autorisation ou l'absence de SDK renvoie une issue explicite
(`permission-denied` / `unavailable` / …), jamais une exception, pour qu'aucun écran ne se
bloque (L7-06).

`@babana/api-client` ne gagne aucune dépendance native : la frontière est l'interface
`PushBinding`. `createUnavailablePushBinding()` — le défaut jusqu'à la session avec un appareil —
échoue franchement, ne renvoie jamais un jeton inventé (D43).

### Tests

- `test_push.py` : plusieurs appareils par compte ; réenregistrement du même couple = réactivé,
  jamais dupliqué ; un jeton pour deux comptes ; jetons désactivés exclus des envois ; feedback
  de jeton invalide → désactive ce jeton **seul**, tous comptes ; défaut = simulateur ;
  `PUSH_PROVIDER` inconnu et `fcm` sans identifiants → lèvent ; `notify_users_async` ne
  programme qu'un postcommit ; le fil de fond avale toute panne.
- `test_devices_controller.py` : enregistrement crée la ligne ; additif entre appareils ;
  plateforme invalide → 400 ; sans jeton d'auth → 401 ; désactivation idempotente.
- `registrar.test.ts` (@babana/api-client) : enregistrement + rotation + toutes les issues non
  bloquantes + `unregister` best-effort + pas de double abonnement.
- `endpoint-coverage.test.ts` : les deux endpoints contre le vrai Odoo.

### Corrigé au passage — un fichier de test qui ne tournait pas

`tests/__init__.py` n'importait pas `test_me_controller.py` : ce fichier, ajouté avec D35
(`GET /me`), **n'a jamais tourné en intégration continue** — Odoo ne découvre que les modules de
test importés dans `tests/__init__.py`. Ajouté, avec `test_push` et `test_devices_controller`.
Les tests de dossier refusé de la tâche 1 (écrits dans `test_me_controller.py`) tournent donc
désormais réellement. C'est un défaut préexistant que ce lot a révélé.

### Ce qui me laisse un doute pour quelqu'un de réel

- **Le chemin `fcm` n'a jamais envoyé une vraie notification.** La logique OAuth2 + HTTP v1 est
  écrite, la détection des jetons invalides (404 `UNREGISTERED`, 400 `INVALID_ARGUMENT` sur le
  champ `token`) aussi — mais rien ne l'exerce sans compte Firebase. Le premier vrai envoi est
  une inconnue, comme le premier vrai appel de routage ou de vérification Google.
- **Aucune app n'appelle encore `createPushRegistrar`.** Le binding natif (Firebase/APNs) est la
  **troisième dépendance native bloquante** après le service de premier plan (L6-05) et le
  sélecteur de pièces (L6-15) : il exige un build mobile que cet environnement ne produit pas.
  Le registrar et le contrat serveur sont réels et testés ; le câblage `bootstrap.ts` +
  `PushBinding` réel se fait dans la session avec un appareil (L6-19 et voisines).
- **L'endpoint d'inspection HTTP du simulateur n'est pas fait.** `push.recent_sent()` existe
  (Python), suffisant pour les tests de cette nuit ; l'exposition HTTP que le §2 de la stratégie
  de simulation décrit appartient au scénario e2e « notifications désactivées » de **L7-06**,
  hors périmètre — à faire avec elle.

---
