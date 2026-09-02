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

_(complétée après exécution de la passe finale)_

---

## Ce qui me laisse un doute pour quelqu'un de réel

_(complété au fil des trois commits — voir « point pour le relecteur » de chaque section)_
