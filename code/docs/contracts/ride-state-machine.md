# Machine à états de `babana.ride`

Référence unique pour l'implémentation de L4-02 et pour tout endpoint touchant au cycle de vie
d'une course. Toute écriture du champ `state` en dehors d'une des transitions ci-dessous est un
bug de conception (invariant 2).

Source de vérité machine-readable : [`ride-state-machine.json`](./ride-state-machine.json).
Un script de vérification structurelle est fourni : [`verify-ride-state-machine.js`](./verify-ride-state-machine.js).

> **Révision C-03R, 10 août 2026.** La version précédente de ce document distinguait des
> écritures « moment de partition » (quatre, comptées) et des écritures « de clôture »
> (les quatre transitions `→ cancelled`, tenues à part). Cette distinction n'a plus lieu d'être :
> l'invariant 1 a été reformulé sans compteur dans `amoa/01-architecture.md` §2, à la suite d'un
> écart relevé sur ce document (la boucle proposition–refus–resélection introduite par D10 et
> les quatre points d'entrée de l'annulation rendaient le compte de « quatre moments » faux).
> Toutes les écritures ci-dessous sont désormais des **écritures d'événement métier**, à égalité
> — il n'existe plus de catégorie à part. Voir `amoa/questions/C-03.md` pour l'historique de
> l'écart et son arbitrage.
>
> Conséquence qui change le comportement documenté, pas seulement le vocabulaire : la
> « proposition à un chauffeur » (`requested → proposed` et `rejected → proposed`) et le
> « refus » (`proposed → rejected`) écrivent désormais chacun dans Odoo au moment où ils se
> produisent. L'ancienne version différait ces écritures jusqu'à l'affectation ou l'annulation
> pour limiter le volume sur une chaîne de refus longue ; ce n'est plus le design retenu —
> `amoa/01-architecture.md` §2 les énumère explicitement parmi les événements qui écrivent, et
> chaque refus reste une décision humaine unique, donc borné par construction.

---

## États

`draft`, `requested`, `proposed`, `assigned`, `in_progress`, `completed`, `settled`,
`rejected`, `cancelled`.

**`draft` n'est jamais persisté.** Il désigne l'état conceptuel du devis (résultat de
`POST /quote`), avant toute création d'enregistrement `babana.ride`. Le premier enregistrement
naît directement en `state = requested` — il n'existe donc aucune ligne en base à l'état
`draft`. C'est pourquoi `draft` n'est jamais cible : la transition `draft → requested`
correspond à la création de l'enregistrement, pas à sa modification.

---

## Les sept événements métier qui écrivent

Pour vérification croisée avec `amoa/01-architecture.md` §2. Chaque écriture Odoo de ce document
est rattachée à l'un de ces sept événements — jamais à un tick GPS, un ETA recalculé, une
distance en cours d'accumulation, ou l'expiration d'un compte à rebours sans effet métier.

| Événement | Écrit | Transition(s) |
|---|---|---|
| Création de la demande | La course, à l'état `requested` | `draft → requested` |
| Proposition à un chauffeur | Le chauffeur sélectionné, l'horodatage | `requested → proposed`, `rejected → proposed` |
| Acceptation | L'affectation | `proposed → assigned` |
| Refus ou expiration | Une ligne à l'historique des refus de la course | `proposed → rejected` |
| Annulation, depuis n'importe quel état | L'état terminal, l'acteur, le motif | `requested → cancelled`, `proposed → cancelled`, `assigned → cancelled`, `rejected → cancelled`, `in_progress → cancelled` (chauffeur uniquement) |
| Fin de course | Distance, durée, tracé archivé en une seule écriture | `in_progress → completed` |
| Encaissement | Le règlement, le mouvement de compte courant, la facture | `completed → settled` |

**Ce qui n'écrit jamais** : position, ETA, distance en cours d'accumulation, compte à rebours,
expiration d'une réservation non suivie d'effet (un verrou Redis qui expire sans jamais avoir
produit d'état `proposed` durable). Tout cela vit dans Redis et sur le WebSocket.

`assigned → in_progress` (démarrage de la course) n'écrit pas non plus dans Odoo : c'est une
décision humaine, mais l'invariant borne le nombre d'écritures par le nombre de décisions, il
n'exige pas une écriture par décision. L'horodatage de démarrage sera reconstitué à la
consolidation de fin de course (L4-04), depuis Redis.

---

## Table des transitions

### 1. `draft → requested`

| Colonne | Contenu |
|---|---|
| Déclencheur | Le client valide l'estimation reçue de `POST /quote` |
| Acteur | Client |
| Préconditions | Estimation non expirée (sinon `QUOTE_EXPIRED`) ; client authentifié et son numéro rattaché ; aucune autre course du client dans un état non terminal (`requested`, `proposed`, `assigned`, `in_progress`) |
| Effets | **Écriture Odoo — événement « création de la demande ».** Création de l'enregistrement `babana.ride` : `state = requested`, départ, arrivée, tarif figé depuis l'estimation, client |
| Irréversible | Non — la course peut être annulée ou progresser |

### 2. `requested → proposed`

| Colonne | Contenu |
|---|---|
| Déclencheur | Le client sélectionne un chauffeur parmi les 5 proposés (`POST /rides/{id}/select-driver`) |
| Acteur | Client |
| Préconditions | `ride.state == requested` ; chauffeur choisi présent dans la dernière liste des 5 chauffeurs proposés à ce client ; chauffeur disponible et réservable |
| Effets | Réservation atomique du chauffeur en Redis (retrait du pool des disponibles, script unique — L3-06) et création de la proposition avec délai d'expiration, en Redis. Réservation réussie seulement : **écriture Odoo — événement « proposition à un chauffeur »** : `state = proposed`, chauffeur sélectionné, horodatage. `DRIVER_ALREADY_TAKEN` si la réservation échoue, sans écriture Odoo ni transition |
| Irréversible | Non |

### 3. `proposed → assigned`

| Colonne | Contenu |
|---|---|
| Déclencheur | Le chauffeur accepte la proposition (`proposal.accept`) |
| Acteur | Chauffeur |
| Préconditions | `ride.state == proposed` ; proposition active non expirée ; le chauffeur qui accepte est celui de la proposition en cours |
| Effets | **Écriture Odoo — événement « acceptation ».** `state = assigned`, chauffeur affecté, horodatage d'affectation |
| Irréversible | Non |

### 4. `proposed → rejected`

| Colonne | Contenu |
|---|---|
| Déclencheur | Le chauffeur refuse (`proposal.reject`) ou le délai d'acceptation expire (`proposal.expired`, minuteur Redis) |
| Acteur | Chauffeur, ou système en cas d'expiration |
| Préconditions | `ride.state == proposed` ; proposition active correspondante |
| Effets | Libération du chauffeur dans le pool disponible (Redis). **Écriture Odoo — événement « refus ou expiration »** : `state = rejected`, ajout d'une ligne (chauffeur, horodatage, motif ou « expiré ») à l'historique des refus porté par la course |
| Irréversible | Non |

### 5. `rejected → proposed`

| Colonne | Contenu |
|---|---|
| Déclencheur | Le client sélectionne un autre chauffeur, sur la **même course** (D11) |
| Acteur | Client |
| Préconditions | `ride.state == rejected` ; nouveau chauffeur disponible et réservable |
| Effets | Réservation atomique du nouveau chauffeur en Redis (L3-06). Réservation réussie seulement : **écriture Odoo — événement « proposition à un chauffeur »**, comme la transition 2 |
| Irréversible | Non |

### 6. `assigned → in_progress`

| Colonne | Contenu |
|---|---|
| Déclencheur | Le chauffeur démarre la course (`ride.start`) |
| Acteur | Chauffeur |
| Préconditions | `ride.state == assigned` ; chauffeur = chauffeur affecté |
| Effets | **Aucune écriture Odoo.** Démarrage du chronomètre et de l'accumulation de distance en Redis. L'enregistrement Odoo reste en apparence `assigned` jusqu'à la fin de course — conséquence assumée de la règle de partition : rien n'est écrit pendant le trajet |
| Irréversible | Non |

### 7. `in_progress → completed`

| Colonne | Contenu |
|---|---|
| Déclencheur | Le chauffeur termine la course (`ride.complete`) |
| Acteur | Chauffeur |
| Préconditions | `ride.state == in_progress` |
| Effets | **Écriture Odoo — événement « fin de course ».** `state = completed`, distance et durée consolidées depuis Redis, montant final calculé, polyline archivée en une seule fois. Purge des données Redis de la course (chronomètre, distance en cours) |
| Irréversible | Distance, durée, montant et polyline deviennent immuables à partir d'ici |

### 8. `completed → settled`

| Colonne | Contenu |
|---|---|
| Déclencheur | Encaissement confirmé (`POST /rides/{id}/settle`) |
| Acteur | Chauffeur |
| Préconditions | `ride.state == completed` ; montant déclaré == montant dû (D9, espèces uniquement) ; le plafond d'encaisse du chauffeur n'est pas dépassé après cet encaissement (D8, sinon `CASH_LIMIT_REACHED`) |
| Effets | **Écriture Odoo — événement « encaissement ».** `state = settled`, mouvement de compte courant chauffeur, génération de la facture (`account.move`) |
| Irréversible | Oui, totale. Plus aucun champ de la course ne change après ce point |

### 9. `requested → cancelled`

| Colonne | Contenu |
|---|---|
| Déclencheur | Annulation par le client avant toute sélection de chauffeur (`POST /rides/{id}/cancel`) |
| Acteur | Client, ou superviseur |
| Préconditions | `ride.state == requested` |
| Effets | **Écriture Odoo — événement « annulation ».** `state = cancelled`, motif, horodatage. Aucun frais (v1) |
| Irréversible | Oui |

### 10. `proposed → cancelled`

| Colonne | Contenu |
|---|---|
| Déclencheur | Annulation par le client pendant qu'une proposition est active |
| Acteur | Client, ou superviseur |
| Préconditions | `ride.state == proposed` |
| Effets | Libération immédiate du chauffeur réservé en Redis. **Écriture Odoo — événement « annulation »** : `state = cancelled`, motif, horodatage |
| Irréversible | Oui |

### 11. `assigned → cancelled`

| Colonne | Contenu |
|---|---|
| Déclencheur | Annulation par le client ou par le chauffeur après affectation, avant démarrage |
| Acteur | Client, chauffeur, ou superviseur |
| Préconditions | `ride.state == assigned` |
| Effets | Libère le chauffeur affecté. **Écriture Odoo — événement « annulation »** : `state = cancelled`, motif (obligatoire si acteur chauffeur — L4-07), horodatage, acteur. Les règles de pénalité éventuelles (annulation tardive) sont hors périmètre v1 |
| Irréversible | Oui |

### 12. `rejected → cancelled`

| Colonne | Contenu |
|---|---|
| Déclencheur | Le client renonce après un refus, sans resélectionner de chauffeur (`POST /rides/{id}/cancel`) |
| Acteur | Client, ou superviseur |
| Préconditions | `ride.state == rejected` |
| Effets | **Écriture Odoo — événement « annulation »** : `state = cancelled`, motif, horodatage |
| Irréversible | Oui |

> Cette transition figure explicitement dans la liste à couvrir de `amoa/specs/C-contrats.md`
> (C-03, corrigé le 10 août). **Elle est absente du tableau de règles de L4-07** (`assigned`,
> `in_progress` et `requested`/`proposed` y sont couverts, `rejected` non) — écart relevé et
> déposé dans `amoa/questions/L4-07.md`. Hypothèse retenue ici, pour ne pas bloquer L4-02 : même
> traitement que `requested → cancelled` (annulation simple, aucune réservation active à
> libérer puisqu'elle l'a déjà été à l'entrée dans `rejected`).

### 13. `in_progress → cancelled`

| Colonne | Contenu |
|---|---|
| Déclencheur | Le chauffeur signale une panne, un accident ou une agression en cours de trajet (`POST /rides/{id}/cancel`) |
| Acteur | **Chauffeur uniquement.** Interdite au client — une fois le trajet commencé, il ne peut pas y mettre fin unilatéralement (voir L4-07) |
| Préconditions | `ride.state == in_progress` ; motif obligatoire |
| Effets | **Écriture Odoo — événement « annulation ».** `state = cancelled`, motif, horodatage, acteur = chauffeur. Signalement au back-office (traçabilité, à relier à `babana.incident`, L8-04). La course apparaît distinctement des courses terminées dans les indicateurs — elle n'a produit aucun encaissement |
| Irréversible | Oui |

---

## Transitions interdites

| Interdite | Raison |
|---|---|
| Tout départ de `settled` | Invariant 2 : rien ne change après règlement. Le compte courant et la facture sont émis, les réouvrir casserait la comptabilité |
| Tout départ de `cancelled` | `cancelled` est terminal au même titre que `settled` (C-03, critère d'acceptation 1, corrigé le 10 août : `cancelled` est désormais explicitement listé comme état terminal, jamais source) |
| `completed → in_progress` | Une course terminée ne redémarre pas. Distance, durée et montant sont déjà consolidés et immuables ; toute correction passe par un avoir, pas par une réouverture de la course |
| `requested → assigned` (directement) | Viole D10 : le client doit désigner un chauffeur, ce qui exige de passer par `proposed`. Court-circuiter `proposed` contourne aussi la réservation atomique de L3-06 |
| `rejected → assigned` (directement) | Un chauffeur qui a refusé ne peut être affecté sans une nouvelle proposition explicite et son acceptation. Le chemin correct est `rejected → proposed → assigned` |
| `in_progress → cancelled`, **par le client** | Une fois le trajet physiquement démarré, le client ne peut pas y mettre fin unilatéralement ; la course va jusqu'à `completed`, ou un incident se traite via `babana.incident` sans annuler la course (L4-07). Cette transition est en revanche **autorisée pour le chauffeur** — voir transition 13 |
| Toute écriture directe de `state` hors de ces fonctions | Invariant 2 : les transitions sont les seules portes d'écriture |

---

## Champs immuables par état

| État | Devient immuable |
|---|---|
| `requested` | Départ, arrivée, tarif figé, client — ne changent plus jamais, quel que soit l'état ultérieur |
| `assigned` | Chauffeur affecté (sauf nouvelle affectation après un futur refus, ce qui n'arrive plus une fois `assigned` atteint) |
| `completed` | Distance, durée, montant final, polyline |
| `settled` | Tout — plus aucun champ ne change |
| `cancelled` | Motif, horodatage d'annulation, acteur — tout le reste reste figé à sa dernière valeur avant annulation |

---

## Historique des refus

Porté par la course elle-même (champ sur `babana.ride`), jamais par la création d'une nouvelle
course à chaque refus (critère d'acceptation 2). Depuis C-03R, chaque refus écrit sa ligne
d'historique au moment où il se produit (événement « refus ou expiration » ci-dessus) — il n'est
plus accumulé en Redis puis consolidé en différé à la prochaine écriture Odoo.
