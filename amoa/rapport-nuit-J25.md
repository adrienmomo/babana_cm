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
