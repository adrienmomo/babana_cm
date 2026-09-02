# Rapport de nuit — J32

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition
de fini). Lu en entier : `CLAUDE.md`, `amoa/questions/REPONSES-2026-09-08.md`, la spécification
L8 (`amoa/specs/L8-securite.md`, dont le tableau L8-01 corrigé le 8 septembre), la spécification
L9 (`amoa/specs/L9-backoffice.md`), le rapport J31, et les contrôleurs authentifiés
(`services/odoo/addons/babana/controllers/`).

Branche `J31-securite` (non fusionnée), qui accueille les trois corrections avant la seconde
relecture. Un commit par tâche, dans l'ordre de dépendance : **D55, puis D54, puis L8-01**
(D54 route les lectures à travers les règles que D55 vient d'assouplir).

Périmètre confié :

1. **D54** — les lectures des contrôleurs au nom de l'utilisateur.
2. **D55** — une suspension empêche de travailler, pas de voir.
3. **Le tableau L8-01 corrigé** — deux cellules réconciliées.
4. **L9-01 à L9-03** — début du back-office superviseur, *si le lot passe en entier*.

**Le lot ne passe pas en entier : je m'arrête après les trois corrections**, comme le prompt le
prévoit. L9-01 à L9-03 est un corps de travail à part entière (vues, menus, filtres, codes
couleur, aperçu signé des pièces, motif de refus qui voyage) ; le bâcler pour tenir dans la nuit
irait contre la règle du lot qui rétrécit, sur le seul lot en deux passes de relecture. Il part
au prochain lot, seul.

---

## 2. D55 — une suspension empêche de travailler, pas de voir

### Le constat de la revue

`state = 'approved'` figurait dans **toutes** les règles d'enregistrement. Deux effets de bord
que personne n'avait cherchés :

- Un chauffeur **suspendu** ne voyait plus son compte courant ni ses remises — il doit de
  l'argent et perdait tout moyen de savoir combien (le raisonnement de D29 retourné contre nous).
- Il perdait aussi **la course qu'il était en train de faire** : l'application cessait de
  fonctionner au milieu d'un trajet, avec un passager. Une prise en urgence veut arrêter le
  *prochain* trajet, pas casser celui-ci.

### Le correctif

`('driver_id.state', '=', 'approved')` / `('state', '=', 'approved')` retiré de tous les
domaines de `security/babana_record_rules.xml` — `babana.ride` (branche chauffeur),
`babana.driver` (fiche propre), `babana.driver.document`, `babana.motorcycle`,
`babana.cash.movement`, `babana.cash.remittance`. Idem dans
`res_partner._babana_partners_reachable_by_driver_user` (le chauffeur suspendu doit joindre le
passager de sa course en cours ; la fenêtre tient déjà à `state in (assigned, in_progress)`).

Le domaine se réduit à « **mes** lignes, quel que soit l'état de mon dossier ». La suspension
agit là où elle agissait déjà :

- `babana_driver._check_online_eligibility` → `DRIVER_NOT_APPROVED` ;
- la contrainte `_check_online_requires_approved` ;
- `babana_driver.write()` qui force `is_online = False` dès que `state != 'approved'` ;
- `action_suspend` qui révoque la famille de jetons (L1-06).

`GET /drivers/me/cash` (`driver.py::_get_cash`) : la garde `state != 'approved'` devient
`state not in ('approved', 'suspended')` — un suspendu lit son solde ; un dossier
`pending` / `rejected`, qui n'a jamais encaissé, reçoit toujours `DRIVER_NOT_APPROVED`.

### Vérification

`test_suspended_or_rejected_driver_loses_access_immediately` (J31) est **remplacé** par
`test_suspension_blocks_working_not_reading` : pour chaque état `suspended` / `rejected` /
`pending`, le chauffeur **voit toujours** sa course en cours, son compte courant, ses remises,
ses documents et sa propre fiche — mais **ne peut pas passer en ligne** (`DRIVER_NOT_APPROVED`
+ `ValidationError` sur `is_online = True`). Il ne voit jamais les lignes d'un autre.

Le `_comment` de `tests/fixtures/access_matrix.json` est corrigé : `own` pour un chauffeur ne
suppose plus `approved`.

### Un point pour le relecteur

`action_suspend` **révoque toujours** la famille de jetons du chauffeur (L1-06). Un chauffeur
suspendu en plein trajet est donc déconnecté ; il doit re-signer (Google → nouvelle session,
`driverStatus = 'suspended'`, `driverRejectionReason` porté) pour retrouver l'accès en
lecture que D55 lui rend — après quoi il peut terminer sa course (aucune transition
`start`/`complete`/`settle` ne teste l'état du chauffeur). Retirer cette révocation dépasse le
périmètre de D55 (« la suspension agit sur la disponibilité ») ; à trancher si l'on veut qu'un
suspendu garde sa session vivante jusqu'à la fin du trajet en cours.

### Fichiers

`code/services/odoo/addons/babana/security/babana_record_rules.xml` ;
`code/services/odoo/addons/babana/models/res_partner.py` ;
`code/services/odoo/addons/babana/controllers/driver.py` ;
`code/services/odoo/addons/babana/tests/fixtures/access_matrix.json` ;
`code/services/odoo/addons/babana/tests/test_access_rights.py`.

---

## 1. D54 — les lectures passent par l'utilisateur

### Le constat de la revue

Les règles d'enregistrement de L8-01 sont justes, et **elles ne s'exécutaient jamais** : chaque
contrôleur authentifié faisait `env["babana.ride"].sudo().search(...)`, puis re-scopait à la
main (`ride.client_id == user.partner_id`). Deux gardes pour une règle, une seule sur le chemin
— la configuration que D26 et D31 ont appris à ce dépôt à redouter, ici sur la sécurité.

### Le correctif

Le lookup de la ressource passe désormais par `with_user(user)` dans tout contrôleur
authentifié par jeton :

| Contrôleur | Lookup | Avant | Après |
|---|---|---|---|
| `ride.py::_find_ride` | `babana.ride` par `public_id` | `sudo` | `with_user` |
| `ride.py::_find_ride_and_assigned_driver` | idem + fiche chauffeur | `sudo` | `with_user` puis `sudo` |
| `incident.py::_trigger_incident` | `babana.ride` | `sudo` | `with_user` |
| `share.py::_find_owned_ride` | `babana.ride` | `sudo` | `with_user` |
| `documents.py::_signed_url` | `babana.driver.document` par id | `sudo().browse` | `with_user().search` |
| `documents.py::_list_documents` | `driver.document_ids` | `sudo` | `with_user` |
| `driver.py::_get_cash` | champs `cash_*` du chauffeur | `sudo` | `with_user` |

Une fois la **porte de visibilité** franchie (la règle a laissé voir la ligne), le contrôleur
rebascule en `sudo` pour assembler sa réponse en liste blanche — notamment `_summary(ride)`, qui
lit `assignedDriverId` : le client n'a aucun accès ORM à `babana.driver`, et c'est le contrôleur
qui sert cette identité avec sa propre projection (L8-01, tableau corrigé). `_signed_url` :
`exists()` seul ne suffisait pas (il ignore les règles) — remplacé par un `search` au nom de
l'appelant, qui applique la règle et revient vide pour le document d'un autre. Le contrôle
explicite qui subsiste dans chaque contrôleur ne dit plus **si** l'accès est permis, seulement
**pourquoi** il est refusé pour un appelant qui, lui, voit la ressource.

**Cas `sudo` nommés, jamais généralisés :**

- `ride.py::_select_driver` — la recherche du chauffeur choisi par le client
  (`env["babana.driver"].sudo().search([("public_id","=",driver_id)])`). Le client n'a **aucun**
  accès ORM à `babana.driver` ; ce chauffeur vient de la liste servie par le service temps réel,
  et c'est `reserve_and_propose` qui vérifie qu'il figurait bien dans la dernière liste montrée à
  ce client (`DRIVER_NOT_IN_LAST_LIST` sinon). Chercher ce chauffeur **avant** de savoir si
  l'appelant y a droit exige `sudo` pour cette recherche-là.
- `internal.py`, `internal_profiles.py` — canal interne temps réel → Odoo, sans utilisateur
  humain : restent en `request.env(user=SUPERUSER_ID)`. Hors D54.
- `auth.py`, `quote.py`, `devices.py` — aucun lookup de ressource appartenant à un *autre*
  utilisateur. `auth` s'authentifie avant qu'un utilisateur n'existe ; `quote` crée une
  estimation et ne lit que des données de référence (zones, règles tarifaires) ; `devices`
  n'écrit que des jetons rattachés à l'appelant. Inchangés.

### Ce que ça change dans les réponses (et les tests qui suivent)

Une ressource que l'appelant **n'a aucun droit de voir** devient **introuvable** (404), pas
**interdite** (403) — on ne confirme pas son existence. Les codes `*_NOT_OWNED` (403) subsistent
pour l'appelant qui **voit** la ressource sans droit d'agir. Tests mis à jour dans ce sens
(jamais l'inverse — aucun 403 rétabli pour faire passer un test) :

| Test | Avant | Après |
|---|---|---|
| `test_client_cannot_select_driver_on_another_clients_ride` | 403 `RIDE_NOT_OWNED` | 404 `RIDE_NOT_FOUND` |
| `test_stranger_cannot_cancel_a_ride` | 403 `RIDE_NOT_OWNED` | 404 `RIDE_NOT_FOUND` |
| `test_complete_by_unassigned_driver_is_rejected` | 403 `DRIVER_NOT_IN_PROPOSAL` | 404 `RIDE_NOT_FOUND` |
| `test_settle_by_unassigned_driver_is_rejected` | 403 `DRIVER_NOT_IN_PROPOSAL` | 404 `RIDE_NOT_FOUND` |
| `test_rejected_for_a_ride_that_is_not_the_caller_s` (incident) | 403 `RIDE_NOT_OWNED` | 404 `RIDE_NOT_FOUND` |
| `test_driver_cannot_get_url_for_another_drivers_document` | 403 `DOCUMENT_NOT_OWNED` | 404 `DOCUMENT_NOT_FOUND` |

`test_only_the_client_can_create_a_share_not_the_driver` **ne change pas** : le chauffeur
affecté *voit* la course (branche `driver_id.user_id` de la règle) → 403 `RIDE_NOT_OWNED`, le
contrôle explicite fait toujours son travail. Nouveau test `test_client_cannot_drive_own_ride` :
le client voit sa course mais n'a pas de fiche chauffeur → 403 `DRIVER_NOT_IN_PROPOSAL`, le code
qui distingue « pas votre rôle » de « introuvable » reste couvert.

Contrat : note ajoutée à `code/docs/contracts/http-api.md` (section « Conventions générales »).
Aucune union d'erreurs modifiée — `RIDE_NOT_FOUND` / `DOCUMENT_NOT_FOUND` figuraient déjà dans
chacune.

### Un point pour le relecteur

`_get_cash` garde `DRIVER_NOT_APPROVED` pour `pending`/`rejected` (voir aussi §2) : un chauffeur
`rejected` qui *avait* encaissé avant son rejet ne verrait plus sa dette par cet endpoint, alors
que la règle d'enregistrement, elle, la lui montrerait. À arbitrer si le cas se présente.

Correctif de suite (commit `D54 (correctif)`) : dans `_select_driver`, le `ride = ride.sudo()`
est remonté **avant** le test `ride.client_id != user.partner_id`. Sans ça, un chauffeur qui
appellerait cet endpoint client sur une course `proposed` (état hors `assigned`/`in_progress`,
donc le client n'est pas « joignable » pour lui) heurtait un `AccessError` en lisant
`ride.client_id` → `INTERNAL_ERROR 500` au lieu de `RIDE_NOT_OWNED 403`. Les trois autres
contrôleurs (`cancel`, `incident`, `share`) faisaient déjà le contrôle sur un enregistrement
`sudo`.

### Fichiers

`code/services/odoo/addons/babana/controllers/ride.py`, `incident.py`, `share.py`,
`documents.py`, `driver.py` ;
`code/services/odoo/addons/babana/security/babana_record_rules.xml` (en-tête, §D54) ;
`code/services/odoo/addons/babana/tests/fixtures/access_matrix.json` (`_comment`) ;
`code/services/odoo/addons/babana/tests/test_ride_controller.py`, `test_incident.py`,
`test_documents.py` ; `code/docs/contracts/http-api.md`.

---

## 3. Tableau L8-01 — deux cellules réconciliées

La spécification a été corrigée le 8 septembre (commit `97c29ba`, en amont de cette session) :
les cellules `client` de `babana.driver` et `babana.motorcycle` passent de « champs publics des
chauffeurs proches » à « **aucun accès ORM** ». Le code de J31 appliquait déjà la lecture
stricte (rapport J31, doute n°2) ; il ne restait qu'à la **prouver explicitement** et à
raccorder les commentaires.

- Nouveau test `TestAccessSpecialCases.test_client_has_no_orm_window_onto_drivers_or_motorcycles` :
  un client ne voit **aucune** ligne `babana.driver` ni `babana.motorcycle` — pas même celle du
  chauffeur de sa course active — et toute lecture directe ou par relation lève `AccessError`.
  La liste des chauffeurs proches vient du service temps réel (liste blanche), l'identité du
  chauffeur affecté du contrôleur (liste blanche) — jamais de l'ORM au nom du client.
- L'en-tête de `security/babana_record_rules.xml` porte maintenant un paragraphe « tableau
  L8-01 corrigé » : pourquoi la formulation d'origine n'était pas exprimable, et pourquoi le
  portail garde un `perm_read` sur le *modèle* sans qu'un client n'en voie jamais une ligne.
- La matrice (`access_matrix.json`) note déjà `client` = `none` sur ces deux modèles ; les
  tests générés (`test_matrix__babana_driver__client__read`, idem motorcycle) le figent, le
  nouveau cas particulier le rend lisible.

Aucun changement de règle : `client` n'avait déjà aucune ligne de résultat sur ces modèles.

### Fichiers

`code/services/odoo/addons/babana/tests/test_access_rights.py` ;
`code/services/odoo/addons/babana/security/babana_record_rules.xml` (en-tête).

---

## 4. Passe finale

Quatre commits sur `J31-securite` :

| Commit | |
|---|---|
| `cd65339` | D55 — règles assouplies |
| `3bbf735` | D54 — lectures `with_user` |
| `acbab96` | L8-01 — tableau réconcilié |
| `c923ea3` | D54 (correctif) — `_select_driver` repasse en `sudo` avant le contrôle |

Environnement rejoué de zéro : `make reset` (`down -v`) → `make up` (base `babana` recréée,
`without_demo = all`) → `make seed` → `make test` → `make lint` → `make typecheck` →
`make secrets-scan`. Docker Desktop, PostgreSQL 16.

### `make test` — base fraîche, aucune édition pendant l'exécution

- **Suite Odoo babana** : `0 failed, 0 error(s) of 685 tests` (683 à J31 : +2 nets —
  `test_client_cannot_drive_own_ride` et `test_client_has_no_orm_window_onto_drivers_or_
  motorcycles` ajoutés, `test_suspended_or_rejected_driver_loses_access_immediately` remplacé
  1-pour-1 par `test_suspension_blocks_working_not_reading`).
- **npm** : `@babana/api-client` 80, `@babana/contracts` 79, `@babana/maps` 19,
  `@babana/navigation` 4, `@babana/realtime` 206, `@babana/client` 106, `@babana/driver` 162,
  `@babana/concurrency-tests` 37 (Redis + Odoo réels, les 4 scénarios de concurrence dont
  l'encaissement concurrent) — tous verts, `fail 0` partout.

Note de méthode : une première passe avait vu `scénario 3 -- encaissement concurrent` tomber
sur un `UND_ERR_SOCKET: other side closed`. Cause identifiée : j'éditais encore des fichiers
`.py`/`.xml` pendant que la suite tournait, et `--dev=reload` redémarrait le serveur 8069 en
plein test de concurrence. La passe finale a été lancée sans aucune édition concurrente —
verte, scénario 3 compris.

### `make lint`, `make typecheck`, `make secrets-scan`

`LINT_RC=0`, `TYPECHECK_RC=0`, `SECRETS_RC=0` (« aucun secret détecté dans les fichiers suivis
par git »).

### Un piège rencontré, corrigé, consigné

Deux commentaires XML que j'ai ajoutés (en-tête de `babana_record_rules.xml`) contenaient un
`--` (double tiret comme ponctuation) — interdit dans un commentaire XML, `lxml` refuse le
fichier et le module ne s'installe plus. Vu au premier `make seed` sur base fraîche (jamais
sur les runs `-u babana` ciblés, faits avant ces ajouts). Les quatre commits ont été
reconstruits proprement pour qu'aucun n'introduise un module qui ne s'installe pas. Règle
retenue : dans ce dépôt, une prose de commentaire XML n'utilise jamais `--` — deux-points ou
tiret cadratin.

---

## Ce qui me laisse un doute pour quelqu'un de réel

1. **La révocation de jeton à la suspension.** D55 rend la lecture, mais `action_suspend`
   (L1-06) déconnecte quand même : le chauffeur suspendu en course doit re-signer (Google) pour
   revoir ce qu'il doit et finir son trajet en cours. C'est récupérable, pas transparent —
   l'app affiche `driverStatus = 'suspended'` mais le solde et la course reviennent seulement
   après re-signature. Retirer cette révocation dépasse « la suspension agit sur la
   disponibilité » ; à arbitrer.

2. **`_get_cash` : `suspended` oui, `pending`/`rejected` non.** `DRIVER_NOT_APPROVED` reste
   pour ces deux états parce qu'ils n'ont jamais encaissé — mais un `rejected` qui *avait*
   encaissé avant son rejet (rejet après une période d'activité) ne verrait plus sa dette par
   l'endpoint, alors que la règle d'enregistrement, elle, la lui montre. À aligner si le cas
   se présente : ne garder `DRIVER_NOT_APPROVED` que pour l'absence de fiche.

3. **Déclarer une remise en étant suspendu.** `POST /remittances` garde `state != 'approved'`.
   D55 parle de *lecture* ; déclarer une remise est une écriture (L5-04). Un chauffeur suspendu
   qui veut rendre la caisse pour solder sa dette ne le peut pas par l'app — il passe par un
   superviseur. Cohérent avec « la suspension empêche de travailler », à confirmer au vu de
   D29.

4. **Le superviseur qui annule par l'API mobile.** `ride.py::_cancel_ride` gère un
   `is_supervisor`, et `with_user(superviseur)` fonctionne (droit d'accès ORM, aucune règle
   portail ne le restreint) — mais aucun test n'exerce ce chemin, et il n'est pas établi qu'un
   superviseur obtienne un jeton d'accès mobile. Le code reste correct ; le chemin est
   spéculatif.

5. **Les contrôleurs restent en `env(user=SUPERUSER_ID)` par construction.** `authenticated_
   user()` renvoie un env `SUPERUSER_ID` ; D54 fait que chaque lookup de ressource repart en
   `.with_user(user)`, mais un futur endpoint qui oublierait ce `.with_user` retomberait dans
   la configuration d'avant. Une garde plus forte serait `authenticated_user()` renvoyant
   directement un env lié à l'utilisateur — refactor plus large, hors périmètre des trois
   corrections.

6. **L9 n'est pas commencé.** Le back-office superviseur — validation des dossiers avec aperçu
   signé des pièces (L1-05), motif de refus qui voyage jusqu'au chauffeur, suivi des courses
   comme outil de travail (courses en cours, mal terminées, chauffeurs au plafond) — reste
   entier. C'est le chemin par lequel un chauffeur entre au pilote.
