# Rapport de nuit — J34

Tenu au fil de l'eau, une entrée par tâche finie. Lu en entier : `CLAUDE.md`,
`amoa/questions/REPONSES-2026-09-10.md`, la spécification L9 (`amoa/specs/L9-backoffice.md`) et
L5 (`amoa/specs/L5-caisse.md`), le rapport J33, `babana_fare_rule.py`, `babana_zone.py`,
`services/pricing.py`, `services/routing.py`, `controllers/quote.py`, `babana_cash_remittance.py`,
`babana_cash_discrepancy.py`, `babana_driver.py`, `controllers/driver.py`,
`packages/contracts/src/http/settlement.ts`, `packages/api-client/src/http/rpc.ts`,
`apps/driver/src/screens/SettlementScreen.tsx`, `apps/driver/src/navigation/*`.

Périmètre confié : L9-04, L9-05, L5-07 — de ce que le superviseur saisit à ce que le chauffeur
voit. Trois commits, plus trois correctifs trouvés par `make test` sur base fraîche (détaillés
plus bas), tous sur la branche `J34-caisse-backoffice-and-driver-cash`, fusionnée sur `master`.

---

## 1. L9-04 — Grille tarifaire et zones (back-office)

### Un défaut trouvé en vérifiant la consigne du soir, pas un écart de spécification

La consigne demandait de vérifier que l'heure vue par le superviseur et l'heure appliquée par le
moteur sont la même heure. Elles ne l'étaient pas : `time_start`/`time_end` sont saisis en heure
locale de Douala, mais `_find_applicable_rule` comparait ces bornes à `at_datetime.hour`, où
`at_datetime` est `fields.Datetime.now()` — un datetime UTC, jamais converti. Même défaut que D45
(recette du jour, `babana_driver.py`), ici sur la face horaire de la grille tarifaire plutôt que
sur la borne calendaire d'un compte. Corrigé (`_operating_timezone()`, réutilise
`babana.default_account_tz` posé par D45), avec un test de régression qui échouait sur l'ancien
code : `test_time_window_is_matched_in_operating_local_time_not_utc`.

### Avertissement de recouvrement (critère 1)

Champ calculé `has_overlap` / `overlap_rule_ids`, non stocké. La difficulté n'était pas la
comparaison d'intervalles (bornes de dates, jours de semaine en masque de bits, plages horaires
avec le cas « à cheval sur minuit » déjà traité une fois par `_applies_at_time`, réutilisé côté
paire via `_time_subintervals`), mais un faux positif : la règle de repli
(`data/fare_rule_default.xml`, sans aucune restriction) recouvre *toute* autre règle par
construction — la signaler aurait produit un avertissement sur chaque règle jamais créée. Exclue
explicitement (`_is_generic()`).

**Limite documentée, pas cachée** : deux règles rattachées à des zones *distinctes* mais dont les
polygones se recouvrent géographiquement ne sont pas détectées comme en recouvrement (seule
l'égalité de zone compte). Au pilote, une seule zone existe — la limite est réelle mais
inatteignable ce soir. À revoir si une deuxième zone apparaît.

### Simulateur de tarif (critère 2)

`babana.fare.simulator`, un wizard qui rejoue **exactement** le chemin de `POST /api/v1/quote` —
même résolution de zone, même sélection de règle, même appel à `services/routing.py` (patché
dans les tests, jamais un calcul parallèle qui pourrait diverger du moteur réel). L'heure simulée
est un `fields.Datetime` normal : Odoo l'affiche et la convertit dans le fuseau du compte
connecté, donc le superviseur saisit en heure locale sans rien faire de spécial, et le simulateur
reçoit la même forme UTC que le vrai contrôleur.

### « Nouvelle version », explicite (critère 5)

Une règle déjà servie (`locked_by_usage`, calculé depuis `_is_used_by_a_ride()`) verrouille ses
champs tarifaires dans le formulaire et affiche un bandeau. Le bouton qui reste ouvre
`babana.fare.rule.version.wizard`, dont le titre et le texte disent explicitement « ceci crée une
nouvelle règle et clôt l'ancienne » — jamais une modification en place.

### Deux impossibilités, même famille que L9-01/L9-03 la veille

Consignées dans `amoa/questions/L9-04.md`, spécification corrigée (critères 3 et 4) :

- **Le polygone de zone ne s'édite pas sur une carte.** Odoo Communauté n'a pas de widget carte,
  encore moins éditable. Même arbitrage que le tracé de course (D12) : un champ calculé ouvre le
  polygone courant, pré-chargé, dans geojson.io — dessiner là-bas, coller le résultat ici.
- **La vue des promotions est retirée.** `babana.promotion` (L2-06) n'existe pas ;
  `amoa/06-jalons-et-pilote.md` reporte explicitement les promotions hors du pilote. Le
  découpage des tâches (L9-04 dépend de L2-06) contredisait ce report — pas une erreur de ce
  soir, une dépendance jamais nettoyée.

### Ce que `make test` a trouvé que rien d'autre n'aurait vu

`has_overlap` n'avait pas de méthode `search()` : le filtre « En recouvrement » de la vue de
recherche a fait échouer le **chargement du module entier** sur base fraîche (`ParseError`
d'Odoo, pas un simple test rouge). `xmllint` et `py_compile`, passés avant `make test`, ne
pouvaient rien voir : c'est la validation de vue par le vrai Odoo qui l'a trouvé. Corrigé
(`_search_has_overlap`, même patron que `babana_driver.py::_search_cash_limit_reached`).

### Tests

`test_fare_rule.py` (régression tz), `test_fare_rule_backoffice.py` (recouvrement, exclusion du
repli, exclusion des règles closes, verrouillage, assistant de version), `test_fare_simulator.py`
(montant et règle appliqués, résolution de zone), `test_zone.py` (URL de l'éditeur externe).

---

## 2. L9-05 — Remises et écarts de caisse (back-office)

### Ce que le formulaire ne doit pas laisser croire

Deux bandeaux, à deux moments du même formulaire. Avant validation : « le montant compté n'a pas
besoin de correspondre au montant attendu ou déclaré » — une concordance donne `validated`, un
écart donne `disputed`, les deux valident la remise (D29). Après validation, si un écart
subsiste : « le chauffeur reste débiteur de X » — avec un lien vers l'écart lié
(`babana.cash.remittance.discrepancy_id`, calculé depuis `_compute_discrepancy_id`, au plus un
par remise puisque `action_validate` n'en crée jamais deux). C'est le point que le brief de la
nuit ciblait explicitement : ne pas laisser croire qu'il faut faire correspondre les deux
montants, et rendre visible que le solde ne repart pas à zéro pour une remise partielle.

### Historique juxtaposé (critère 2) et série repérable (critère 5)

`driver_other_discrepancy_ids` (les autres écarts du même chauffeur, les plus récents en tête)
juxtaposé à l'écart courant dans un onglet du formulaire. `same_direction_recent_count` et
`part_of_a_series` réutilisent **le même seuil et la même fenêtre glissante** que
`_babana_check_alert_thresholds` (l'alerte déjà postée à la création) — une seconde lecture
indépendante du même seuil aurait fini par diverger (D23, encore la même famille de défaut).
Décoration rouge en liste, filtre dédié.

### Tableau de bord (critère 3)

`babana.cash.dashboard`, un wizard sans formulaire de saisie — `default_get()` recalcule tout à
chaque ouverture, pas de champ à remplir. Total détenu par la flotte en premier (« l'exposition
financière de l'entreprise à un instant donné », spécification), chauffeurs au plafond et
proches du plafond, remises en attente triées par ancienneté avec la plus ancienne nommée.

« Proches du plafond » exigeait un seuil qui n'existe encore nulle part dans le code : L9-06
(paramétrage back-office des valeurs de dispatch) n'est pas fait, et L7-05 (notification
d'approche) non plus. Posé ici, à l'usage, exactement comme `babana.cash_limit` l'a été avant
que L9-06 n'existe (`babana.cash_limit_alert_ratio`, repli 80 %) — L7-05 réutilisera le même
paramètre plutôt que d'en inventer un second.

### Ce que `make test` a trouvé (même famille que L9-04)

`part_of_a_series` avait le même défaut que `has_overlap` la veille dans la même passe : pas de
`search()`, le filtre « En série » cassait le chargement du module. Même correctif.

### Tests

`test_cash_backoffice.py` : lien remise → écart, historique scopé au bon chauffeur, drapeau de
série au seuil configuré (et rattrapage du premier écart d'une série une fois le seuil atteint
par le second), total détenu par la flotte, comptage chauffeurs au plafond / proches du plafond,
`cash_limit_near` sur `babana.driver` lui-même (vrai en dessous du plafond, faux une fois
atteint — ce n'est plus « proche », c'est « atteint »).

---

## 3. L5-07 — Écran de recette (app Chauffeur)

### Ce que le découpage ne disait pas

`GET /drivers/me/cash` et `POST /remittances` existaient déjà (J12, J26) — mais aucun des deux ne
donnait accès à l'historique des remises, et le découpage de L5-07 ne listait aucun contrôleur.
D35 (01-architecture.md §5) a aboli le JSON-RPC natif pour toute lecture mobile, y compris les
« lectures secondaires » comme un historique : la seule route qui reste est un contrôleur
explicite sous `/api/v1`. Étendre `GET /drivers/me/cash` (ajout de `marginRemaining` et
`remittances` au contrat `DriverCashResponseSchema`) plutôt qu'ouvrir un second endpoint pour un
écran qui affiche les deux à la fois — un aller-retour de moins sur un réseau intermittent.
`packages/api-client/src/http/rpc.ts` reste du code mort et non branché (son commentaire de tête,
antérieur à D35, décrit encore le plan JSON-RPC abandonné) — signalé, pas touché : hors du
périmètre de ce soir.

### CashScreen et RemittanceScreen

« Recette encaissée », jamais « revenus » (É6) — testé par recherche de chaîne. Encaissé du
jour, solde à remettre, marge avant plafond avec un repère de proximité (coloré depuis
`marginRemaining`/`limit`, deux valeurs déjà serveur — aucune troisième donnée financière
dérivée), historique des remises avec statut (y compris `rejected`, le mot public pour une
remise contestée, même vocabulaire que `POST /remittances` depuis le début). Accessible en
permanence depuis Home (« Ma caisse »), pas seulement quand le plafond bloque.

`Remittance` était un espace réservé (`PlaceholderScreen title="Déclaration de remise" task="L5-07"`)
posé par L6-11, qui y navigue déjà quand le motif de refus est le plafond. Rempli ce soir : même
discipline d'idempotence que `SettlementScreen` (clé stable sur les tentatives), mise en attente
hors connexion avec renvoi manuel — le remplacement automatique à la reconnexion reste L6-16, pas
encore fait, exactement comme `SettlementScreen` ne l'a pas non plus.

### Ce que `make test` a trouvé, que la suite JS ne pouvait pas voir

`_get_cash()` lisait `self.env[...]` — `DriverController` n'a pas d'attribut `env`, seul
l'environnement retourné par `_common.authenticated_user()` en a un. `AttributeError` sur
**chaque** appel réel à `GET /drivers/me/cash`. La suite JS (Jest) mockait `apiClient.request`
et ne pouvait donc jamais exécuter le vrai contrôleur Python ; c'est `test_driver_cash_controller.py`,
contre le vrai Odoo, qui l'a trouvé (6 tests en échec). Corrigé (`env` au lieu de `_env`, plus
utilisé sous son ancien nom souligné).

### Tests

`test_driver_cash_controller.py` (marge jamais négative, historique avec statuts
pending/validated/rejected, tri par ancienneté décroissante, lecture maintenue pour un chauffeur
suspendu — D55), `CashScreen.test.tsx`, `RemittanceScreen.test.tsx`, `api/cash.test.ts` (l'enveloppe
elle-même, sinon jamais exercée puisque les tests d'écran la mockent), `HomeScreen.test.tsx` (le
nouveau bouton). `packages/contracts` (79 tests) et `packages/api-client` (80 tests) reconstruits
et repassés — trois fixtures de `client.test.ts` mises à jour pour la nouvelle forme du contrat.

---

## Non-régression

`make reset && make up && make test` sur base fraîche : suite Odoo, 755 tests, 0 échec, 0
erreur. Suites `npm test` (tous les paquets et apps), suite de concurrence (24 scénarios réels
contre Redis/PostgreSQL, y compris le canal C-01 critère 6 qui rejoue chaque endpoint contre le
vrai Odoo — `driverCash` et `createRemittance` compris), vérificateurs de contrat (machine à
états, carte des messages temps réel) : tous verts. `make seed` rejoué avec succès sur la base
ainsi construite (zones, grille tarifaire, remises, 29 courses réglées).

Trois des quatre correctifs ci-dessus (`has_overlap`, `part_of_a_series`, l'`AttributeError` du
contrôleur) n'ont été trouvés qu'à cette étape — jamais par `xmllint`, `py_compile`, `tsc`, ou la
suite JS seule. C'est exactement pour ça que le point 3 de la définition de fini existe.

---

## Ce qui me laisse un doute, pour quelqu'un de réel

**Je n'ai pas vu les écrans, seulement prouvé qu'ils ne cassent pas.** J'ai tenté une vérification
visuelle du back-office dans un navigateur réel (comme les instructions système l'exigent pour un
changement d'interface) et j'ai échoué à m'authentifier — aucun identifiant admin documenté dans
le dépôt, et mes essais (`admin@babana.cm` / `admin`, `admin` / `admin`) n'ont pas abouti. Je me
suis rabattu sur la preuve la plus forte disponible sans elle : le chargement réel du module par
Odoo (qui a trouvé les deux champs non cherchables) et la suite de bout en bout qui appelle
`driverCash` et `createRemittance` contre le vrai serveur. C'est une preuve de correction
structurelle, pas une preuve que la mise en page se lit bien — le bandeau d'alerte avec un champ
`Many2many` intégré (recouvrement de règles) ou le tableau de bord en trois blocs n'ont jamais
été regardés par un œil humain ni par moi. Si un identifiant admin existe quelque part
(`code/docs/`, une note à part), il vaut la peine d'être documenté — j'aurais dû pouvoir vérifier
visuellement sans le deviner.

**Même chose côté chauffeur, en pire : je n'ai lancé aucun bundle.** `CashScreen` et
`RemittanceScreen` sont couverts par Jest (comportement) et `tsc` (types), jamais ouverts dans
Metro ni dans l'export web (D22). Un rendu qui compile et dont chaque branche est testée peut
encore mal s'aligner sur un petit écran, ou avec des gants (contrainte réelle citée par L6-11)
sur le bouton « Déclarer ».

**Le seuil « proche du plafond » est un chiffre que j'ai choisi (80 %), pas mesuré.** Défendable
par précédent (même ordre de grandeur que `QUOTA_ALERT_RATIO_DEFAULT`), mais personne n'a
regardé la vraie distribution de encaissements pour dire si 80 % laisse une marge suffisante pour
qu'un chauffeur organise sa remise avant blocage — la spécification de L7-05 (non faite) dira si
c'est trop tard ou trop tôt.

**`packages/api-client/src/http/rpc.ts` ment maintenant plus fort qu'avant.** Son commentaire de
tête prometttait encore un pont JSON-RPC pour « historique, factures, profil » quand j'ai ouvert
le fichier ce soir — D35 l'a aboli depuis le 22 août, et ce soir j'ai justement construit
l'historique des remises par le chemin que D35 impose, pas par celui que ce commentaire annonce.
Le fichier est mort (aucun import en dehors de son propre paquet), inoffensif tel quel, mais il
induira la prochaine lecture en erreur un peu plus fort à chaque tâche qui, comme celle-ci,
confirme que le plan qu'il documente n'aura jamais lieu.
