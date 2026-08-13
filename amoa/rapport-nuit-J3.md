# Rapport de nuit — J3 (nuit du 11 au 12 août 2026)

Tenu au fil de l'eau, même structure que les nuits précédentes. Périmètre : corrections
(L4-02R, L4-01R, champs-pont, L0-03R) puis flotte et tarification (L1-07 → L1-08 → L1-10 →
L2-01 → L2-02 → L2-03), selon `amoa/PROMPT-NUIT-J3.md`.

**État de départ vérifié en fin de nuit** : `L4-02-state-machine` reste sur sa branche, non
fusionnée — un seul commit ajouté (`L4-02R`), rien d'autre touché dessus. `master` propre,
aucun changement non commité.

---

## Corrections (phase 1)

### L4-02R — sur la branche `L4-02-state-machine`

**Fait.** `tests/test_ride_state_concurrency.py` retiré (et son import dans `tests/__init__.py`) :
sa preuve relève désormais de L4-11, hors du harnais Odoo. `action_cancel` depuis `rejected`
enregistre `cancel_category = 'abandon_after_rejection'` et `cancelled_after_rejection_rank`
(compte des refus au moment de l'annulation) — deux champs ajoutés dans `babana_ride_state.py`
plutôt que dans `babana_ride.py` (déjà sur `master`, non touché).

Port du correctif L4-01R sur cette branche aussi : sans lui, `test_second_non_terminal_
request_for_same_client_is_forbidden` n'avait plus de garantie à tester une fois le contrôle
Python retiré de `action_request`. `DRIVER_ACTIVE_STATES`/`CLIENT_ACTIVE_STATES` et l'index
partiel client reproduits ici, indépendamment de `master`.

**77 tests, 0 échec** sur cette branche.

### L4-01R — sur `master`

**Fait, fusionnable** (L4-01 déjà dessus). `ACTIVE_STATES` unique remplacé par
`DRIVER_ACTIVE_STATES`/`CLIENT_ACTIVE_STATES` ; l'index partiel client couvre désormais
`requested`. **Piège trouvé** : `CREATE UNIQUE INDEX IF NOT EXISTS` seul aurait laissé dormir
l'ancienne définition sur une base déjà installée — `DROP INDEX` ajouté avant la recréation.

### Champs-pont — convention appliquée rétroactivement

`code/docs/bridge-fields.md` créé. En l'inventoriant, deux champs-pont se sont révélés déjà
résolubles sans que personne ne l'ait fait : leur tâche cible (L4-01) était terminée depuis le
10 août sans branchement. Fixé :

- `babana_role`, `babana_driver_state` (`res.users`, L1-01) — **supprimés**, pas remplacés par
  un champ-pont mieux nommé. Le rôle et le statut chauffeur se lisent désormais par l'existence
  d'un `babana.driver` rattaché (`res.users._babana_role`, `_babana_driver`). A forcé une reprise
  plus large que prévu : `_babana_find_or_create_from_google` ne créait jamais de
  `babana.driver` au premier sign-in chauffeur — complété, avec une fiche `hr.employee` minimale
  faute de provisionnement RH préalable spécifié (`amoa/questions/L1-03R.md`, question ouverte
  pour arbitrage).
- `babana.driver.ride_count`, `res.partner.babana_rides_count` — branchés sur un `search_count`
  réel au lieu de renvoyer `0`.

Restent des champs-pont légitimes (tâche cible pas encore écrite) : `rating_avg`/`rating_count`
(L4-09), `cash_balance` (L5-01), `babana.ride.quote_reference` (L2-04), `promotion_code` (L2-06),
et deux nouveaux ce soir : `babana.driver.license_expires_on`/`license_alert_sent_on` (L1-05,
détail plus bas). Tous inscrits dans le registre avec leur tâche cible et la raison.

### L0-03R — build Android

**Fait, vérifié aussi loin que cette machine le permet.** `settings.gradle` et
`app/build.gradle` (client et driver) résolvent le plugin Gradle React Native et
`react-native`/`codegen` via `node --print require.resolve(...)` plutôt que des chemins relatifs
qui supposaient une app autonome. Deux pièges trouvés en vérifiant :

1. `pluginManagement {}` doit être la toute première instruction d'un `settings.gradle` — la
   résolution ne peut donc pas être factorisée dans une variable posée avant, elle est répétée
   deux fois.
2. Le `node` par défaut de cette machine (`/usr/local/bin/node`, Homebrew) est cassé
   (`Library not loaded: libicui18n.74.dylib`) — sans rapport avec le monorepo. Contourné pour la
   vérification avec le `node` géré par nvm (`~/.nvm/versions/node/v22.23.2`), qui correspond à
   `.nvmrc`.

**Vérifié** : `./gradlew help --stacktrace` sur `apps/client/android` et `apps/driver/android`
résout désormais le plugin et progresse jusqu'à la création des tâches Android, puis échoue sur
`SDK location not found` — l'outillage Android (SDK, NDK) n'est pas installé sur cette machine.
Je ne l'ai pas contourné, conformément à l'instruction. **Le critère 4 de L0-03 (un APK release
par app) reste donc à vérifier sur un poste équipé du SDK Android** — c'est la seule partie de
cette tâche que je ne peux pas prouver moi-même ce soir.

---

## Flotte et tarification (phase 2)

### L1-07 — `babana.motorcycle`

**Fait.** Immatriculation unique, gamme, assurance, état (`available`/`assigned`/`maintenance`/
`retired`), affectation courante. `driver_id` est la source écrite unique de l'affectation ;
`babana.driver.motorcycle_id` (absent depuis L1-03, `amoa/questions/L1-03.md`) devient un vrai
champ, calculé en miroir — premier test de la convention des champs-pont, comme prévu : il
disparaît de la liste des absences plutôt que d'y ajouter un doublon.

Deux blocages (pas des avertissements) : assurance expirée bloque l'affectation (contrainte sur
`driver_id`, déclenchée seulement par ce champ, pas par `insurance_expires_on` — sinon une
simple correction de date sur une moto déjà affectée aurait cassé rétroactivement) ; chauffeur
dont la moto n'est plus assurée ne peut pas passer en ligne (contrainte symétrique côté
`babana.driver`).

**58 tests, 0 échec.**

### L1-08 — `babana.assignment`

**Fait.** Historique moto ↔ chauffeur : au plus une affectation active par moto et par chauffeur
(index partiel, même schéma que `babana.ride`), périodes qui ne se chevauchent jamais (contrainte
Python, au-delà du seul index), affectation close immuable, jamais supprimée (`unlink()` lève).

**Piège trouvé** : clore une affectation puis en créer aussitôt une autre pour la même moto
échouait sur l'index partiel, alors que la clôture avait réussi côté ORM. `write()` sur un champ
n'est pas toujours poussé en base avant qu'un `create()` suivant (SQL brut) n'en ait besoin dans
la même transaction — `flush_recordset()` explicite après la clôture. **Ce piège s'est reproduit
deux fois de plus ce soir** (voir L2-02) ; je le signale comme un défaut de plateforme récurrent
plutôt que trois incidents isolés — voir « Ce que je ferais ensuite ».

**77 tests, 0 échec** (compte cumulé avec L1-07).

### L1-10 — alertes d'échéance

**Fait**, avec un écart. Tâche planifiée quotidienne : alerte par le fil Odoo dans la fenêtre
configurable (`babana.expiry_alert_window_days`, D21, défaut 15 jours), blocage automatique à
l'échéance (moto → `maintenance`, chauffeur → hors ligne), idempotent (champ de dernière alerte
comparé à la date du jour).

**Écart** (`amoa/questions/L1-10.md`) : le permis chauffeur n'a pas encore de modèle pour porter
sa date d'expiration — `babana.driver.document` (L1-05) n'est pas prévu avant J4. Deux
champs-pont sur `babana.driver` (`license_expires_on`, `license_alert_sent_on`) portent la donnée
en attendant, inscrits dans le registre.

**Piège de plateforme, encore le rechargement des données de seed** : à un moment de la nuit,
j'ai marqué `data/fare_rule_default.xml` `noupdate="1"` en pensant que ça suffirait à empêcher
le rechargement idempotent de heurter l'immutabilité de `babana.fare.rule` — insuffisant selon
le mode de chargement effectif (`-i` sur un module déjà installé). Voir L2-01/L2-02 ci-dessous
pour la correction retenue.

**72 tests, 0 échec.**

### L2-01 — `babana.fare.rule`

**Fait**, avec un écart résolu dans la foulée. D15 respecté à la lettre : aucun champ de prix à
la minute. Sélection déterministe entre règles concurrentes (priorité, puis création la plus
récente). Une plage horaire nulle (`time_start == time_end`, y compris `0.0 == 0.0` par défaut)
signifie « aucune restriction » — convention documentée, un `Float` Odoo ne distingue pas `0.0`
de « non renseigné ». Règle de repli fournie dans `data/`, valeurs plausibles pour Douala et
provisoires (D21).

Historisation (critère 4) plus stricte que la lettre de la spécification : toute règle déjà
créée est immuable sur ses champs tarifaires, pas seulement « une règle déjà utilisée ». Sans FK
directe entre `babana.ride` et `babana.fare.rule` (le gel se fait par valeur,
`fare_rule_snapshot`, L4-01), il n'existe aucun moyen fiable de savoir si une règle précise a
servi — l'immutabilité s'applique donc à toutes, servies ou non. `new_version()` clôt et crée.

**Écart** (`amoa/questions/L2-01.md`) : `zone_id` omis, comme `motorcycle_id` avant L1-07 —
`babana.zone` est L2-02, qui suit immédiatement et l'ajoute.

**Piège de plateforme** (voir ci-dessus) : le rechargement idempotent de `fare_rule_default.xml`
appelait `write()` sur l'enregistrement déjà existant même sous `noupdate="1"`, et se heurtait à
l'immutabilité. Corrigé en rendant le garde-fou sensible à un **changement réel** de valeur, pas
à la seule présence du champ dans `vals` — une réapplication identique n'est pas une
modification au sens du critère 4.

**83 tests, 0 échec.**

### L2-02 — zones géographiques

**Fait.** `babana.zone` : polygone GeoJSON, priorité, actif. Résolution par lancer de rayon
(PNPOLY), sans PostGIS — décision documentée comme réversible si le nombre de zones croît. Zones
autorisées à se chevaucher (voulu) ; la priorité départage ; la zone par défaut (au plus une
active, index partiel) répond quand rien ne contient le point, jamais une erreur. Point sur une
frontière : déterministe, comportement documenté (arêtes demi-ouvertes de l'algorithme).

Une seule zone pour le pilote, englobant Douala, marquée par défaut — le découpage fin attend
L9-07, le deviner d'avance serait de la fiction. Résout l'écart de L2-01 : `zone_id` ajouté à
`babana.fare.rule`, `_find_applicable_rule` filtre désormais par zone.

**90 tests, 0 échec.**

### L2-03 — moteur de cotation

**Fait.** `services/pricing.py`, fonction pure : aucune lecture de l'horloge ni de la base à
l'intérieur de `compute_fare`. Ordre imposé respecté : base + distance, coefficient d'heure de
pointe, promotion, plancher (après la promotion), arrondi au pas configuré (jamais codé en dur
dans la fonction elle-même — passé en paramètre par l'appelant). Détail décomposé en composantes
strictement additives : la somme reconstruit exactement le total
(`FareBreakdown.sum_matches_total`), vérifié sur cinq scénarios distincts, pas seulement « à peu
près complet ».

**127 tests, 0 échec — suite babana complète.**

---

## Champs-pont : état à l'arrivée

**Créés cette nuit** :
- `babana.driver.license_expires_on`, `license_alert_sent_on` (cible L1-05) — nécessaires pour
  que L1-10 fonctionne ce soir, `babana.driver.document` n'existant pas encore.

**Supprimés cette nuit** :
- `res.users.babana_role`, `babana_driver_state` (posés par L1-01, auraient dû disparaître avec
  L1-03) — leur survie était précisément ce que la consigne de ce matin demandait de vérifier.
- `babana.driver.ride_count`, `res.partner.babana_rides_count` — trouvés « oubliés » en
  inventoriant, alors que leur tâche cible (L4-01) était déjà là.

**Jamais créés, alors qu'ils auraient pu l'être** : `babana.driver.motorcycle_id` et
`babana.fare.rule.zone_id` sont passés directement de « absent, documenté en commentaire » à
« champ réel », sans étape intermédiaire de champ plat transitoire — c'était le test explicite de
la consigne pour `motorcycle_id`, et j'ai reproduit le même schéma pour `zone_id` sans qu'on me
le demande, la situation étant identique.

**`code/docs/bridge-fields.md` à l'arrivée** : quatre lignes actives (`rating_avg`,
`rating_count` → L4-09 ; `cash_balance` → L5-01 ; `quote_reference` → L2-04 ; `promotion_code` →
L2-06 ; `license_expires_on`, `license_alert_sent_on` → L1-05 — six champs en tout sur quatre
lignes, deux d'entre elles couvrant deux champs chacune), plus deux notes narratives sur les
champs déjà résolus et sur `pickup_zone_id`/`dropoff_zone_id` (`babana.ride`), volontairement non
traités ce soir — même situation que `motorcycle_id`/`zone_id` avant leurs tâches respectives,
mais toucher `babana.ride` (déjà sur `master`) sans instruction explicite m'a semblé le genre de
décision à signaler plutôt qu'à trancher en silence.

---

## Ce qui tourne

- Suite Odoo complète du module `babana` : **127 tests, 0 échec, 0 erreur**, vérifié sur une
  base réinstallée à neuf (voir « Un vrai défaut trouvé » ci-dessous — les runs précédents de
  cette même nuit, sur une base réutilisée depuis plusieurs nuits, masquaient un bug réel).
- `npm run lint --workspaces` : propre, aucune sortie.
- `npm run typecheck --workspaces` : propre, tous les paquets (`api-client`, `contracts`, `maps`,
  `ui`, `realtime`, `client`, `driver`).
- `npm test` (racine) : 63 + 19 tests `realtime`, 1 test `client`, 1 test `driver`, plus le
  script `verify-ride-state-machine.js` — tous verts.
- `sh tools/secret-scan/scan.sh` : aucun secret détecté.
- `L4-02-state-machine` : 77 tests, 0 échec, branche toujours non fusionnée.

## Ce qui ne tourne pas

- **Production d'un APK release** (critère 4 de L0-03) : impossible à vérifier jusqu'au bout sur
  cette machine, faute de SDK Android installé (`SDK location not found`). Le reste du build
  (résolution du plugin, de `react-native`, de `codegen`) fonctionne, vérifié par
  `./gradlew help --stacktrace` sur les deux apps.

## Un vrai défaut trouvé en vérifiant, pas en développant

En voulant confirmer que `noupdate="1"` réglait le rechargement de `fare_rule_default.xml`, j'ai
relancé `-i babana` sur la base de développement accumulée depuis plusieurs nuits — et découvert
que cette base contenait encore l'ancien enregistrement de la règle par défaut, créé **avant**
l'ajout de `noupdate="1"`, dont le drapeau stocké dans `ir.model.data` ne se met pas à jour
rétroactivement quand on modifie le fichier XML. Plus largement, cette base réutilisée masquait
tout ce qui n'aurait pu se produire que sur une installation fraîche. **J'ai supprimé et
réinstallé la base `babana` du conteneur `postgres` pour repartir propre** — action locale,
réversible par `make reset`, mais je la signale explicitement puisqu'elle touche une base de
données partagée par les sessions précédentes plutôt qu'un simple fichier. Les 127 tests
ci-dessus sont vérifiés sur cette base fraîche.

## Défaut de plateforme récurrent : write() non flushé avant un create() dans la même transaction

Rencontré trois fois cette nuit, sur trois modèles différents (`babana.assignment`,
`babana.zone` en test, `babana.fare.rule` via le rechargement de seed) : un `write()` qui devrait
logiquement être visible par un `create()` suivant, dans la même transaction, ne l'est pas
toujours si ce `create()` passe par une contrainte SQL brute (index partiel, `INSERT ... RETURNING`).
`flush_recordset()` explicite corrige au cas par cas, mais la récurrence suggère un motif
général plutôt que trois coïncidences. **Je ne l'ai pas généralisé en garde-fou automatique**
dans le framework du module (par exemple un flush systématique dans un `write()` de base
partagé) faute d'instruction et par prudence — un flush trop large pourrait masquer d'autres
problèmes de performance ailleurs. À évaluer : documenter ce piège dans `code/docs/` pour la
prochaine tâche qui l'ignorerait, comme demandé pour les défauts de plateforme la nuit du
10 août.

## Questions ouvertes et hypothèses prises

1. **`amoa/questions/L1-03R.md`** — la fiche `hr.employee` minimale auto-créée au premier
   sign-in chauffeur est-elle la bonne place, ou faut-il un provisionnement RH préalable
   (embauche avant le premier sign-in) avec rattachement manuel différé ? Retenu pour avancer :
   la fiche minimale, faute d'alternative spécifiée — mais ce n'est pas tranché.
2. **`amoa/questions/L1-10.md`** — `license_expires_on` sur `babana.driver` est un champ-pont en
   attendant L1-05 ; `_cron_alert_and_block_drivers` devra être repris pour lire la vraie source
   (le document `license` le plus récent) quand L1-05 existera.
3. **`amoa/questions/L2-01.md`** — résolu dans la même nuit par L2-02, mentionné pour mémoire.
4. **Zones sur `babana.ride`** (`pickup_zone_id`/`dropoff_zone_id`) : toujours absentes, comme
   avant L2-02. Je ne les ai pas ajoutées à `babana.ride` (déjà sur `master`) sans instruction
   explicite — signalé dans `code/docs/bridge-fields.md`, pas tranché.
5. **Le flush récurrent** (voir section dédiée ci-dessus) : signalé, pas généralisé.

## Ce que je ferais ensuite

- Documenter le piège du flush dans `code/docs/` (défauts de plateforme Odoo 18), sur le modèle
  des deux défauts déjà notés le 10 août (`auth='none'` readonly, `env.user` vide sous
  `uid=None`) — pour que la prochaine tâche qui écrit `write()` puis `create()` dans le même
  appel ne le redécouvre pas à la dure.
- Trancher `amoa/questions/L1-03R.md` : le provisionnement RH d'un chauffeur qui s'inscrit
  lui-même via Google mérite une décision explicite avant que L1-06 (validation du dossier
  chauffeur) ne bute dessus.
- Vérifier la production d'un APK release sur un poste équipé du SDK Android — c'est la seule
  partie de L0-03R que je n'ai pas pu prouver moi-même.
- L1-05 (documents chauffeur) devient plus pressant que sa fenêtre initiale (« repoussable après
  J3, mais pas après J4 ») ne le suggérait : deux champs-pont en dépendent maintenant
  (`license_expires_on`, `license_alert_sent_on`), en plus du besoin déjà documenté par L1-09.
