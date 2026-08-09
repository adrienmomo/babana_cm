# Machine à états de `babana.ride`

Référence unique pour l'implémentation de L4-02 et pour tout endpoint touchant au cycle de vie
d'une course. Toute écriture du champ `state` en dehors d'une des transitions ci-dessous est un
bug de conception (invariant 2).

Source de vérité machine-readable : [`ride-state-machine.json`](./ride-state-machine.json).
Un script de vérification structurelle est fourni : [`verify-ride-state-machine.js`](./verify-ride-state-machine.js).

> **Écart documenté.** Deux points de cette spécification contredisent la conception qui suit ;
> voir `amoa/questions/C-03.md` pour le détail et l'hypothèse retenue :
> 1. Le critère d'acceptation 1 exige que chaque état apparaisse en source, sauf `draft` et
>    `settled`. `cancelled` est traité ici comme un troisième état sans transition sortante
>    (terminal, au même titre que `settled`), ce qui contredit la lettre du critère.
> 2. Le critère d'acceptation 3 de C-01 exige exactement quatre moments d'écriture Odoo. Les
>    trois transitions `→ cancelled` écrivent aussi dans Odoo, pour clôturer proprement la
>    course. Ce document les traite comme des écritures de clôture distinctes des quatre moments
>    de la règle de partition, pas comme un cinquième moment de la même famille.

---

## États

`draft`, `requested`, `proposed`, `assigned`, `in_progress`, `completed`, `settled`,
`rejected`, `cancelled`.

**`draft` n'est jamais persisté.** Il désigne l'état conceptuel du devis (résultat de
`POST /quote`), avant toute création d'enregistrement `babana.ride`. Le premier enregistrement
naît directement en `state = requested` — il n'existe donc aucune ligne en base à l'état
`draft`. C'est pourquoi `draft` n'est jamais cible : la transition `draft → requested`
correspond à la création du enregistrement, pas à sa modification.

---

## Table des transitions

### 1. `draft → requested`

| Colonne | Contenu |
|---|---|
| Déclencheur | Le client valide l'estimation reçue de `POST /quote` |
| Acteur | Client |
| Préconditions | Estimation non expirée (sinon `QUOTE_EXPIRED`) ; client authentifié et son numéro rattaché ; aucune autre course du client dans un état non terminal (`requested`, `proposed`, `assigned`, `in_progress`) |
| Effets | **Écriture Odoo — moment 1/4 de la règle de partition.** Création de l'enregistrement `babana.ride` : `state = requested`, départ, arrivée, tarif figé depuis l'estimation, client |
| Irréversible | Non — la course peut être annulée ou progresser |

### 2. `requested → proposed`

| Colonne | Contenu |
|---|---|
| Déclencheur | Le client sélectionne un chauffeur parmi les 5 proposés (`POST /rides/{id}/select-driver`) |
| Acteur | Client |
| Préconditions | `ride.state == requested` ; chauffeur choisi présent dans la dernière liste des 5 chauffeurs proposés à ce client ; chauffeur disponible et réservable |
| Effets | **Aucune écriture Odoo.** Réservation atomique du chauffeur en Redis (retrait du pool des disponibles, script unique — L3-06) et création de la proposition avec délai d'expiration, entièrement en Redis. `DRIVER_ALREADY_TAKEN` si la réservation échoue |
| Irréversible | Non |

### 3. `proposed → assigned`

| Colonne | Contenu |
|---|---|
| Déclencheur | Le chauffeur accepte la proposition (`proposal.accept`) |
| Acteur | Chauffeur |
| Préconditions | `ride.state == proposed` ; proposition active non expirée ; le chauffeur qui accepte est celui de la proposition en cours |
| Effets | **Écriture Odoo — moment 2/4.** `state = assigned`, chauffeur affecté, horodatage d'affectation, consolidation dans l'historique des refus de tous les refus Redis accumulés sur cette course |
| Irréversible | Non |

### 4. `proposed → rejected`

| Colonne | Contenu |
|---|---|
| Déclencheur | Le chauffeur refuse (`proposal.reject`) ou le délai d'acceptation expire (`proposal.expired`, minuteur Redis) |
| Acteur | Chauffeur, ou système en cas d'expiration |
| Préconditions | `ride.state == proposed` ; proposition active correspondante |
| Effets | **Aucune écriture Odoo.** Libération du chauffeur dans le pool disponible (Redis). Ajout de l'entrée (chauffeur, horodatage, motif) à l'historique des refus tenu en Redis jusqu'à la prochaine écriture Odoo |
| Irréversible | Non |

### 5. `rejected → proposed`

| Colonne | Contenu |
|---|---|
| Déclencheur | Le client sélectionne un autre chauffeur, sur la **même course** (D11) |
| Acteur | Client |
| Préconditions | `ride.state == rejected` ; nouveau chauffeur disponible et réservable |
| Effets | **Aucune écriture Odoo.** Réservation atomique du nouveau chauffeur en Redis (L3-06), nouvelle proposition avec délai d'expiration |
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
| Effets | **Écriture Odoo — moment 3/4.** `state = completed`, distance et durée consolidées depuis Redis, montant final calculé, polyline archivée en une seule fois. Purge des données Redis de la course (chronomètre, distance en cours) |
| Irréversible | Distance, durée, montant et polyline deviennent immuables à partir d'ici |

### 8. `completed → settled`

| Colonne | Contenu |
|---|---|
| Déclencheur | Encaissement confirmé (`POST /rides/{id}/settle`) |
| Acteur | Chauffeur |
| Préconditions | `ride.state == completed` ; montant déclaré == montant dû (D9, espèces uniquement) ; le plafond d'encaisse du chauffeur n'est pas dépassé après cet encaissement (D8, sinon `CASH_LIMIT_REACHED`) |
| Effets | **Écriture Odoo — moment 4/4.** `state = settled`, mouvement de compte courant chauffeur, génération de la facture (`account.move`) |
| Irréversible | Oui, totale. Plus aucun champ de la course ne change après ce point |

### 9. `requested → cancelled`

| Colonne | Contenu |
|---|---|
| Déclencheur | Annulation par le client avant toute sélection de chauffeur (`POST /rides/{id}/cancel`) |
| Acteur | Client, ou superviseur |
| Préconditions | `ride.state == requested` |
| Effets | **Écriture Odoo de clôture** (hors des quatre moments de la règle de partition, voir écart) : `state = cancelled`, motif, horodatage |
| Irréversible | Oui |

### 10. `proposed → cancelled`

| Colonne | Contenu |
|---|---|
| Déclencheur | Annulation par le client pendant qu'une proposition est active |
| Acteur | Client, ou superviseur |
| Préconditions | `ride.state == proposed` |
| Effets | Libération immédiate du chauffeur réservé en Redis. **Écriture Odoo de clôture** : `state = cancelled`, motif, horodatage, consolidation de l'historique des refus accumulé |
| Irréversible | Oui |

### 11. `assigned → cancelled`

| Colonne | Contenu |
|---|---|
| Déclencheur | Annulation par le client ou par le chauffeur après affectation, avant démarrage |
| Acteur | Client, chauffeur, ou superviseur |
| Préconditions | `ride.state == assigned` |
| Effets | **Écriture Odoo de clôture** : `state = cancelled`, motif, horodatage. Les règles de pénalité éventuelles (annulation tardive) sont hors périmètre v1 |
| Irréversible | Oui |

### 12. `rejected → cancelled`

*Choix d'implémentation non spécifié par C-03 — ajouté pour couvrir le cas où le client
abandonne après un refus plutôt que de resélectionner. Sans cette transition, un client qui
renonce après un refus laisserait la course bloquée en `rejected` indéfiniment.*

| Colonne | Contenu |
|---|---|
| Déclencheur | Le client renonce après un refus, sans resélectionner de chauffeur |
| Acteur | Client, ou superviseur |
| Préconditions | `ride.state == rejected` |
| Effets | **Écriture Odoo de clôture** : `state = cancelled`, motif, horodatage, consolidation de l'historique des refus |
| Irréversible | Oui |

---

## Transitions interdites

| Interdite | Raison |
|---|---|
| Tout départ de `settled` | Invariant 2 : rien ne change après règlement. Le compte courant et la facture sont émis, les réouvrir casserait la comptabilité |
| Tout départ de `cancelled` | `cancelled` est terminal au même titre que `settled` (voir écart : ceci contredit la lettre du critère d'acceptation 1, qui n'exempte que `draft` et `settled`) |
| `completed → in_progress` | Une course terminée ne redémarre pas. Distance, durée et montant sont déjà consolidés et immuables ; toute correction passe par un avoir, pas par une réouverture de la course |
| `requested → assigned` (directement) | Viole D10 : le client doit désigner un chauffeur, ce qui exige de passer par `proposed`. Court-circuiter `proposed` contourne aussi la réservation atomique de L3-06 |
| `rejected → assigned` (directement) | Un chauffeur qui a refusé ne peut être affecté sans une nouvelle proposition explicite et son acceptation. Le chemin correct est `rejected → proposed → assigned` |
| `in_progress → cancelled` | Absente de la liste minimale de C-03. Une fois le trajet physiquement démarré, la course va jusqu'à `completed` ; un incident en cours de trajet se traite via `babana.incident`, pas par une annulation de la course (hypothèse, à confirmer — voir `amoa/questions/C-03.md`) |
| Toute écriture directe de `state` hors de ces fonctions | Invariant 2 : les transitions sont les seules portes d'écriture |

---

## Champs immuables par état

| État | Devient immuable |
|---|---|
| `requested` | Départ, arrivée, tarif figé, client — ne changent plus jamais, quel que soit l'état ultérieur |
| `assigned` | Chauffeur affecté (sauf nouvelle affectation après un futur refus, ce qui n'arrive plus une fois `assigned` atteint) |
| `completed` | Distance, durée, montant final, polyline |
| `settled` | Tout — plus aucun champ ne change |
| `cancelled` | Motif, horodatage d'annulation — tout le reste reste figé à sa dernière valeur avant annulation |

---

## Les quatre moments d'écriture Odoo de la règle de partition

Pour vérification croisée avec `amoa/01-architecture.md` §2 et le critère d'acceptation 3 de C-01.

1. `draft → requested` — création de la demande
2. `proposed → assigned` — affectation du chauffeur
3. `in_progress → completed` — fin de course, consolidation
4. `completed → settled` — encaissement

Les transitions `→ cancelled` (9, 10, 11, 12) écrivent également dans Odoo, mais comme écritures
de clôture distinctes de cette liste des quatre — voir l'écart documenté en tête de ce fichier.
Aucune autre transition n'écrit dans Odoo.

---

## Historique des refus

Porté par la course elle-même (champ sur `babana.ride`), jamais par la création d'une nouvelle
course à chaque refus (critère d'acceptation 2). Accumulé en Redis pendant la période
`proposed`/`rejected`, consolidé dans Odoo à la prochaine écriture (affectation ou annulation).
