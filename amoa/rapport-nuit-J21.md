# Rapport de nuit — J21

Tenu au fil de l'eau, une entrée par tâche finie, commitée avec elle (point 8 de la définition de
fini, `CLAUDE.md`). `amoa/questions/REPONSES-2026-08-29.md` lu en entier avant d'ouvrir quoi que
ce soit. Périmètre confié : D45 (fuseau) et D46 (banc de vérification) d'abord — la suite reste
rouge tant que D45 n'est pas traité — puis L8-03 (partage de trajet) et L8-04 (bouton d'urgence),
cinq nuits reportées.

---

## D45 — le fuseau se pose à la création, et les deux bornes du jour se convertissent en UTC

Les deux moitiés, comme demandé — corriger l'une sans l'autre laisse un décalage d'une heure à
Douala, plus rare donc plus difficile à voir.

### Moitié 1 — tout compte reçoit son fuseau à la création

`_babana_find_or_create_from_google` (`models/res_users.py`) ne posait jamais `tz` dans les `vals`
du `create()` — tout compte héritait donc du défaut Odoo, `Europe/Brussels`. Corrigé : `tz` est
désormais lu depuis `ir.config_parameter` (`babana.default_account_tz`, repli `Africa/Douala`),
même idiome que `CASH_LIMIT_PARAM` et les autres paramètres du dépôt (invariant 5) — configurable
sans déploiement, comme demandé (« le jour où le service dépasse le Cameroun, cette valeur doit
changer sans toucher au code »).

### Moitié 2 — la conversion en UTC qui manquait

`_babana_cash_collected_today` (`models/babana_driver.py`) calculait `today` correctement avec
`fields.Date.context_today(self)` (le fuseau réel du compte connecté — code/docs/odoo-pitfalls.md
réserve `context_today()` exactement à ce cas), mais construisait ensuite `start`/`end` comme des
`datetime` **naïfs** sur ce jour calendaire local, comparés tels quels à `create_date` (stocké en
UTC). Corrigé par localisation explicite (`pytz`) : chaque borne est construite séparément
(`combine` sur `today` puis sur `today + 1 jour`, pas `start + timedelta(days=1)`) pour rester
correcte un jour de changement d'heure, puis convertie en UTC avant la requête.

### Recherche d'autres occurrences du même motif

Demandée explicitement (« c'est le genre de motif qui se recopie »). `grep` sur `combine(`,
`time.min`, `time.max`, `context_today` dans tout `services/odoo/addons/babana` (hors tests) :
`_babana_cash_collected_today` est la **seule** fonction qui construit une borne de requête depuis
un jour calendaire local. Toutes les autres occurrences de date du jour
(`babana_motorcycle.py`, `babana_fare_rule.py`, le cron d'alerte de `babana_driver.py`,
`services/routing.py`) utilisent déjà `fields.Date.today()` (UTC, sans contexte utilisateur) —
conforme à la règle documentée dans `code/docs/odoo-pitfalls.md`, rien à corriger là.

### Tests — la frontière, pas l'horloge du moment

« Un test qui tourne à quatorze heures ne dira jamais rien » : les trois tests de
`_babana_cash_collected_today` (`tests/test_driver.py`) figent `today` par `unittest.mock.patch`
sur `odoo.fields.Date.context_today` plutôt que de dépendre de l'heure réelle d'exécution, et
posent `create_date` explicitement par SQL direct (champ non-écrivable par `write()`) :

- un mouvement à 23h30 UTC (00h30 heure locale Douala, jour suivant) est bien compté dans la
  recette du jour local qui vient de commencer — exactement le mouvement qui disparaissait avant
  correctif ;
- un mouvement à 23h30 UTC un jour plus tard (00h30 locale, encore un jour plus tard) est bien
  exclu — la borne de fin est symétriquement correcte, pas seulement celle de début ;
- un chauffeur `Europe/Brussels` (le défaut Odoo qu'un compte pourrait encore porter) obtient un
  résultat différent d'un chauffeur `Africa/Douala` pour le même mouvement — preuve que le calcul
  suit réellement le fuseau du compte, pas une valeur fixe câblée dans le test.

Deux tests supplémentaires (`tests/test_auth.py`) prouvent la moitié 1 : un compte fraîchement créé
via `/auth/google` porte `Africa/Douala`, et changer `ir.config_parameter` change ce défaut sans
toucher au code.

**Logique financière, sous revue humaine** (`CLAUDE.md`) : le changement touche directement le
calcul de solde affiché au chauffeur, écrit et testé comme tel — 6 tests nouveaux, tous verts,
suite `babana` complète rejouée sur base fraîche sans régression (voir passe finale).

Deux tests jusqu'ici verts par accident deviennent verts pour la bonne raison : les tests HttpCase
`TestDriverCashController.test_returns_balance_limit_and_collected_today` et
`test_a_remittance_does_not_count_as_collected_today` (ne fixent pas l'horloge, dépendent du
moment réel d'exécution) — jusqu'ici verts sauf entre 22h et minuit UTC. Vérification obtenue sans
avoir à la provoquer : l'exécution de la suite ciblée ce soir est tombée exactement dans cette
fenêtre (23h19 UTC, `date -u` à l'appui), la même qui faisait rougir ces deux tests avant
correctif — et les deux sont passés.

**Fichiers.** `models/res_users.py`, `models/babana_driver.py`, `tests/test_auth.py`,
`tests/test_driver.py`.

---

## D46 — le banc de vérification en même origine, aucun code applicatif touché

Aucun fichier du dépôt à changer : `controllers/`, `infra/caddy/Caddyfile`, `apps/client/config.ts`
restent inchangés. La correction est entièrement dans **la façon de vérifier**, pas dans le
produit — exactement ce que D46 (`amoa/01-architecture.md` §9 ter) demande.

### Ce qui a été refait, précisément

Même montage que J16/J17 (`amoa/rapport-nuit-J16.md`, `amoa/rapport-nuit-J17.md`) : `dist-web`
construit avec `BABANA_API_URL`/`BABANA_REALTIME_WS_URL` pointés sur l'origine du banc lui-même,
et un Caddy jetable (`http://verify.localhost:8888`, jamais commité, retiré en fin de session) qui
sert `dist-web` **et** relaie `/api/*` et `/rt/*` vers Odoo et le service temps réel réels —
`api/*` sur la même origine que le bundle, pas sur une seconde. C'est précisément l'inverse du
montage de J20 (bundle sur `verify.localhost`, API laissée sur `api.localhost` — deux origines),
identifié comme la cause du préflight refusé (`amoa/questions/L6-18-cors-api-web-quote.md`).

### Preuve, pas seulement le montage

Session réelle injectée (même geste que J17 — restauration de session, pas le flux OAuth web qui
n'existe pas encore), jeton obtenu par un vrai aller-retour `mock-google-identity` → `POST
/api/v1/auth/google` contre le banc lui-même. Après rechargement : `HomeScreen` s'affiche,
`GET /api/v1/me` répond **200** sur `http://verify.localhost:8888` (même origine que la page,
`read_network_requests` à l'appui), aucune erreur console. Aucun préflight `OPTIONS` déclenché —
un navigateur n'en émet jamais pour une requête réellement same-origin, c'est tout l'intérêt du
montage.

**Ce que ça ne referme pas** : `amoa/questions/L6-18-cors-api-web-quote.md` reste ouvert tel quel
— le jour où l'app Client réelle sera déployée en web (L6-18), la topologie de production devra
elle-même être same-origin (ou une vraie politique CORS explicite posée), ce qui est le travail de
cette tâche-là, pas de ce soir. Ce soir prouve seulement que **le défaut était dans le banc**, pas
dans l'API — et que vérifié correctement, le parcours ne bute sur rien.

---
