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
