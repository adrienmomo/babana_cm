# Rapport de nuit — J23

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini). `amoa/questions/REPONSES-2026-08-31.md` lu en entier avant d'ouvrir quoi que ce soit.
Périmètre confié : les trois correctifs de contrat (D49, D50, D51), puis L6-13 et L6-14 — avec
arrêt après L6-13 si le lot ne passe pas en entier.

Branches par tâche, comme la nuit précédente. `make reset` et la passe complète en fin de session.

---

## D49 — `proposal.accepted` entre au contrat, les 1500 ms devinées disparaissent

### Le motif, une fois de plus : là où l'application devinait, il manquait un message

`ProposalScreen` (L6-12) attendait `ACCEPT_CONFIRMATION_GRACE_MS` (1500 ms) après avoir envoyé
`proposal.accept`, puis basculait vers `ActiveRide` « en confiance » — parce que le contrat ne
portait que les issues négatives (`proposal.expired`). Un délai deviné est toujours trop court ou
trop long : sur un réseau de Douala, un aller-retour peut dépasser 1500 ms, et l'écran serait
parti vers une course en cours pendant qu'un `proposal.expired` était encore en chemin. Tant
qu'`ActiveRide` était un `PlaceholderScreen`, le risque était borné ; L6-13 (cette nuit) le rend
réel.

### Ce qui a été fait

- **Contrat** (`packages/contracts/src/realtime/server-to-client.ts`) : `proposal.accepted`
  (destinataire chauffeur, `{ rideId }`), ajouté au `ServerToClientMessageSchema`. Symétrique de
  `ride.assigned` côté client. `docs/contracts/realtime-events.md` et `realtime-message-map.json`
  mis à jour (statut `wired`, émetteur + consommateur réels).
- **Service** (`services/realtime/src/proposal/lifecycle.ts::accept`) : émet `proposal.accepted`
  au chauffeur **dès le succès de `resolveProposal`**, avant tout `await` sur Odoo ou le cache de
  profils, et **sans dépendre de `consumeRecord`** — la certitude du chauffeur ne doit pas tenir à
  un enregistrement Redis qui pourrait manquer. Même point de code que `ride.assigned`.
- **App** (`apps/driver/src/screens/ProposalScreen.tsx`) : plus aucun délai. `handleAccept` n'est
  plus `async`, il envoie `proposal.accept` et passe en `accepting`. La bascule vers `ActiveRide`
  n'a lieu que sur `proposal.accepted` (rideId correspondant, décision encore `accepting` ou
  `idle`). `proposal.expired` garde son rôle (expiration simple / acceptation tardive, critères 3
  et 4 de L6-12).

### Le filet, sans réintroduire de délai deviné

Si `proposal.accepted` se perd **sans** que la connexion tombe puis se rétablisse, rien sur le
fil ne le rattrape immédiatement. `ProposalScreen` écoute donc aussi `session.synced` : la
resynchronisation automatique (`@babana/api-client`, émise à chaque `connected`) rapporte
`activeRideId` / `activeRideState` ; si la course est la sienne et vaut `assigned` / `in_progress`,
bascule vers `ActiveRide`. C'est « demander au serveur » plutôt que « deviner d'un délai » — même
esprit que le reste de la nuit. Le cas résiduel (double perte `proposal.accept` **et**
`proposal.expired`, sans aucune reconnexion) reste borné par le battement de cœur ajouté en J22
(`ws/liveness.ts`), qui finit par fermer une connexion à moitié morte → reconnexion → resync.

### Tests

- `packages/contracts/test/realtime.test.ts` : `ProposalAcceptedMessageSchema` accepte l'exemple.
- `services/realtime/test/proposal.test.ts` : `accept()` pousse `['proposal.new',
  'proposal.accepted']` au chauffeur ; une double acceptation ne produit qu'**un** accusé (celui
  de l'acceptation qui a gagné la résolution atomique).
- `apps/driver/src/screens/__tests__/ProposalScreen.test.tsx` : accepter n'envoie que
  `proposal.accept` ; aucune bascule après 60 s sans accusé ; bascule sur `proposal.accepted` ;
  `proposal.accepted` d'une autre course ignoré ; filet `session.synced` (n'agit que sur la bonne
  course dans un état affecté) ; acceptation tardive inchangée.

`make test` complet et `tsc --noEmit` : voir la passe finale.

### Doute pour un chauffeur réel

Le cas résiduel ci-dessus (double perte sans reconnexion) laisse l'écran sur « Envoi de votre
acceptation… » jusqu'au prochain battement de cœur. C'est strictement mieux que l'ancienne bascule
optimiste (qui, avec un `ActiveRide` désormais réel, afficherait une course en cours qui n'existe
pas), mais un chauffeur pressé pourrait quitter l'app entre-temps. À observer au pilote.

`amoa/questions/L6-12.md` (premier écart) : **résolu** par D49.
