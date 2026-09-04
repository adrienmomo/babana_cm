# Pièges de plateforme Odoo

Quand Odoo se comporte autrement que le bon sens le suggère, ça s'écrit ici plutôt que dans un
message de commit (`CLAUDE.md`, non-régression). Chaque entrée : le piège, comment il a été
rencontré, la règle à en tirer.

---

## Les routes `auth='none'` sont en lecture seule par défaut depuis Odoo 18

Support des répliques de lecture (read replicas) : une route déclarée `auth='none'` est montée en
lecture seule sauf `readonly=False` explicite dans sa déclaration. Sans ce paramètre, toute
écriture (création d'utilisateur, rotation ou révocation de jeton) échoue silencieusement avec
`ReadOnlySqlTransaction`.

Rencontré en implémentant L1-01 (`controllers/auth.py`) : les trois routes publiques (`/auth/
google`, `/auth/refresh`, `/auth/logout`) écrivent toutes, et portent donc `readonly=False`
explicite dans `_PUBLIC_AUTH_ROUTE`.

**Règle** : toute route `auth='none'` qui écrit porte `readonly=False` explicite -- ne pas compter
sur le comportement par défaut.

**Récidive le 4 septembre (D68, `controllers/documents.py`)** : la règle ci-dessus n'a pas suffi à
l'éviter une seconde fois -- elle protège une route déclarée en écrivant dès le départ, pas une
route déclarée `readonly=True` en toute honnêteté (elle ne lisait alors vraiment que la base) à
laquelle une tâche ultérieure ajoute une écriture sans revenir sur son `readonly`. L8-09 a posé
l'écriture de l'entrée d'audit dans `_signed_url` (`_URL_ROUTE`, alors `readonly=True`) : elle
échouait silencieusement à chaque appel réel, absorbée par le savepoint de `_babana_record`
(critère 3) -- trouvé en construisant le signal de panne du journal d'audit (D68), pas par la
règle ci-dessus, qui ne se relit jamais toute seule quand le corps d'une route change.

**Corollaire** : cette règle ne se vérifie qu'à la création de la route. Toute tâche qui AJOUTE
une écriture dans le corps d'une route `auth='none'` existante doit relire son `readonly` déclaré
-- ne pas supposer qu'il est déjà correct parce que la route existait avant.

---

## `env.user` vide sous `uid=None` casse des hooks internes

`auth='none'` lie la requête à `uid=None` (`ir_http._auth_method_none`), donc `env.user` y est un
recordset vide. Plusieurs hooks internes d'Odoo (`hr`, `mail`) n'acceptent pas cet utilisateur
vide dans leurs propres surcharges de `create()`/`write()`. `.sudo()` seul ne change pas
`env.uid` : il faut rebasculer explicitement sur un utilisateur réel avant toute écriture qui
traverse ces modules.

Rencontré en implémentant L1-01 : `_superuser_env()` dans `controllers/auth.py` fait
`request.env(user=SUPERUSER_ID)`, pas seulement `.sudo()`.

**Règle** : sous une route `auth='none'`, rebasculer sur un utilisateur réel (typiquement
`SUPERUSER_ID`) avant toute écriture, ne pas se fier à `.sudo()` seul.

---

## Un `write()` n'est pas toujours poussé en base avant qu'un `create()` suivant heurte une contrainte SQL

Rencontré trois fois en une nuit (10-11 août), sur trois modèles différents : dans la même
transaction, un `write()` peut rester en cache ORM sans être poussé en base avant qu'un `create()`
suivant ne déclenche une contrainte SQL qui dépend de la valeur écrite -- la contrainte voit alors
l'ancienne valeur.

**Ce n'est pas un garde-fou à généraliser automatiquement** (un vidage systématique masquerait des
problèmes de performance ailleurs). La règle est ciblée : tout code qui s'appuie sur une contrainte
au niveau base doit provoquer le vidage avant de la déclencher, avec `flush_recordset()` explicite.

**Règle** : avant un `create()` dont la réussite dépend d'un `write()` précédent dans la même
transaction, appeler `flush_recordset()` sur l'enregistrement modifié.

---

## Un drapeau `noupdate` figé dans `ir.model.data` ne se met pas à jour rétroactivement

Modifier un enregistrement XML déjà chargé (`noupdate="1"` ou non) ne change rien pour une base qui
l'a déjà installé : Odoo lit le drapeau au moment du chargement, pas à chaque redémarrage. Une base
de développement accumulée depuis plusieurs sessions peut donc faire passer une suite de tests
verte alors qu'une installation fraîche échouerait.

Constaté le 12 août : cent vingt-sept tests verts sur une base ancienne, un vrai défaut découvert
au premier `make reset`.

**Règle** : la base de développement est jetable, et doit être jetée régulièrement. Avant de
déclarer une tâche finie, exécuter la suite au moins une fois sur une base fraîche (`CLAUDE.md`).

---

## `fields.Date.context_today()` dépend du fuseau horaire personnel de l'utilisateur connecté, jamais celui d'un cron

`context_today(record)` calcule « aujourd'hui » dans le fuseau horaire de `record.env.user` (champ
`tz` de `res.users`), pas dans un fuseau fixe. L'utilisateur admin de développement porte par
défaut `Europe/Brussels` (donnée de démo Odoo), sans rapport avec Douala. Résultat : entre 22h et
minuit UTC (l'écart CEST en été), `context_today()` renvoie déjà **demain** alors que
`fields.Date.today()` (UTC, sans contexte) renvoie encore **aujourd'hui**.

Découvert le 14 août en vérifiant J4 : une règle tarifaire de repli (`babana.fare.rule`, L2-01)
créée avec `active_from = context_today(self)` portait une date en avance d'un jour sur
`datetime.now()` (UTC) utilisé par `_find_applicable_rule` -- aucune règle ne semblait plus
applicable. Même mécanisme pour les alertes d'échéance (L1-10) : la tâche planifiée écrivait
`license_alert_sent_on` un jour en avance sur ce qu'un test attendait de `Date.today()`.

Un cron n'a pas d'utilisateur réel connecté -- asservir sa notion de « aujourd'hui » au fuseau
horaire personnel de celui qui l'a déclenché (ou de l'admin par défaut) n'a aucun sens métier, et
produit une fenêtre d'incohérence quotidienne d'environ deux heures.

**Règle** : toute date métier qui ne dépend pas d'un utilisateur réellement connecté (cron, valeur
par défaut d'un modèle, fenêtre de validité) utilise `fields.Date.today()`, jamais
`fields.Date.context_today()`. Réservé à `context_today()` : un contexte où une personne connectée
regarde effectivement un écran dans son propre fuseau horaire.

---

## `cr.postcommit` ignore les savepoints

Un rappel enregistré via `env.cr.postcommit.add(...)` **à l'intérieur** d'un `with
self.env.cr.savepoint():` n'est pas défait si ce savepoint est annulé. `postcommit` ne connaît que
la transaction englobante : le rappel s'exécute dès que celle-ci commite réellement, que le
savepoint qui l'a vu naître ait réussi ou non.

Ce dépôt commite délibérément des transactions dont un savepoint a été annulé -- c'est ainsi qu'un
contrôleur renvoie une erreur métier propre après un conflit (`_lock_for_update()`,
`babana_ride_state.py`) : l'exception est attrapée, traduite, et la requête HTTP se termine
normalement, donc la transaction Odoo commite. Un appel sortant enregistré à l'intérieur d'un
savepoint annulé partirait donc quand même -- pour un effet qui, du point de vue de la base, n'a
jamais eu lieu.

Découvert le 19 août en relisant `action_settle` (L4-05) : le signalement de franchissement de
plafond (`notify_cash_limit_reached`) s'enregistrait depuis l'intérieur du savepoint de
l'encaissement. Pas atteignable ce soir-là (rien n'échouait après ce point dans le savepoint), mais
la ligne suivante -- un effet de plus dans le même savepoint, comme la génération de facture prévue
par L4-06 -- l'aurait rendu réel. Arbitrage : D33 (`amoa/questions/REPONSES-2026-08-19.md` §2).

**Règle** : un effet qui sort de la base (notification, appel HTTP sortant, tout ce qui passe par
`env.cr.postcommit`) ne s'enregistre qu'**après la sortie réussie** du savepoint qui l'a produit,
jamais depuis l'intérieur. Retenir l'intention (un booléen, un identifiant) pendant le savepoint,
enregistrer l'appel une fois qu'on sait que l'effet a vraiment eu lieu.

---

## Le chargement d'un plan comptable sur une société sans écriture supprime d'abord tous les comptes et journaux existants

Quand `account` s'installe sur une société qui n'a pas encore de plan comptable, il **programme**
le chargement du plan générique (`generic_coa`) pour la fin du chargement des modules :
`ir.module.module.write()` pose `registry._auto_install_template`, exécuté par
`ir.module.module._register_hook()` une fois tous les modules chargés. Ce chargement
(`account/models/chart_template.py::_load`) commence, si la société **n'a aucune écriture**
(`_existing_accounting()` faux), par `unlink()` sur **tous** les `account.account`,
`account.journal`, `account.tax`… existants, avant de poser ceux du modèle.

Avec les données de démonstration d'Odoo, ça ne se voyait pas : la démo `account` chargeait
`generic_coa` **et** créait des écritures très tôt, donc quand le module babana posait ses trois
comptes de remise de caisse et son journal (ancien `data/accounting_config.xml`, `noupdate`),
la société avait déjà un plan et des écritures — pas de ménage, les comptes babana survivaient.

Découvert le 2 septembre en implémentant D53 (`without_demo = all`). Sur une base fraîche **sans
démo** : `account` s'installe sans plan → programme `generic_coa` → babana crée ses comptes via
XML → fin du chargement → `_auto_install_template` s'exécute, supprime les comptes babana avec
les autres, charge `generic_coa`. Résultat : les quatre `ir.config_parameter` de la remise de
caisse pointaient vers des ids supprimés, et toute validation de remise (L5-05) aurait échoué.

**Règle** : un enregistrement `account.account` / `account.journal` propre à un module ne se
crée pas dans un XML `noupdate` ni dans un `post_init_hook` naïf — il serait détruit juste
après. Il se crée **après** le chargement du plan comptable : soit en s'enchaînant à
`registry._auto_install_template` (ce que fait `babana/__init__.py::_post_init_currency_and_accounting`),
soit en chargeant soi-même le plan d'abord puis en créant ses comptes par-dessus.

---

## `cr.postcommit` ne s'exécute jamais dans un test `--test-enable`, `HttpCase` compris

`Registry.cursor()` renvoie un `TestCursor` dès que `registry.test_cr` est posé -- ce qui couvre
**toute la durée d'une exécution `--test-enable`**, y compris les requêtes HTTP réellement servies
par le thread de fond d'un `HttpCase` (`url_open`). Or `TestCursor.commit()` vide `postcommit`
**sans l'exécuter** ("TestCursor ignores post-commit hooks by default", `odoo/sql_db.py`). Un test
qui appelle une vraie route HTTP puis attend l'effet d'un appel sortant enregistré par
`env.cr.postcommit.add(...)` (`realtime_client.py`) ne verra donc **jamais** cet effet -- pas une
seule fois, sans la moindre erreur ni avertissement pour le signaler : le rappel est simplement
jeté au moment du commit.

Découvert le 23 août (L3-19) en écrivant un test `HttpCase` censé prouver que `POST /rides/{id}/
start` fait réellement recevoir `ride.started` à un client WebSocket réel : dix secondes
d'attente, aucun message, aucun appel sortant journalisé côté service temps réel -- alors que la
même vérification, isolée dans un script hors du harnais de test, fonctionnait immédiatement.

**Ce n'est pas nouveau à L3-19** : `clear_engagement` (L3-17) souffre du même sort dans
`test_ride_controller.py` depuis sa création -- aucun test HttpCase existant n'a jamais prouvé que
l'engagement se relâche réellement côté temps réel après un `/complete` réel, uniquement que la
transition Odoo elle-même a lieu.

**Règle** : prouver un effet accroché à `cr.postcommit` demande de contourner `TestCursor`, jamais
de l'affronter :
- **Le point d'accroche** (s'enregistre-t-il au commit, jamais pendant, jamais depuis un
  savepoint ?) se prouve avec un `_FakeEnv`/`_FakeCursor` qui reproduit `commit()`/`rollback()`
  fidèlement (voir `test_realtime_commit_hook.py`) -- jamais `self.env` d'un test Odoo.
- **Le câblage** (la bonne méthode appelle-t-elle la bonne fonction, avec les bons arguments ?) se
  prouve par `patch.object` sur la fonction de `realtime_client`, dans un `TransactionCase` --
  n'a besoin d'aucun commit réel, seulement que l'appel Python ait eu lieu.
- **La livraison réelle** (l'appel HTTP produit-il l'effet attendu de l'autre côté ?) se prouve
  côté service temps réel lui-même (`services/realtime/test/*.test.ts`, contre un Redis/WebSocket
  réels), jamais en la redemandant à un test Odoo.

Les trois preuves composées remplacent ce qu'un unique test HttpCase de bout en bout promettait
de couvrir mais ne peut structurellement pas prouver.

## L'exception D43 (vide dans `.env.example`, posée dans `infra/compose.dev.yaml`) ne convient qu'aux valeurs consommées uniquement par les conteneurs

D43 (adresses de fournisseur externe, `GOOGLE_JWKS_URL` et consorts) déplace la valeur de
développement de `.env.example` vers `infra/compose.dev.yaml`, motif : une production qui
recopierait `.env.example` ne doit jamais hériter d'une adresse de simulateur. Ce déplacement
fonctionne parce que ces adresses ne sont lues que **dans** les conteneurs Docker.

`ADMIN_PASSWORD` posée le 2 septembre a d'abord suivi ce même motif -- puis `make test` a échoué :
`test/concurrency/helpers/odoo-session.ts`, qui tourne sur l'**hôte** (`npm test`, pas dans un
conteneur), lit ses identifiants de service depuis `infra/env/.env` par un mécanisme déjà en
place (`env()`, avec repli sur `.env.example`) -- jamais depuis `infra/compose.dev.yaml`, qui
n'existe que pour la configuration *interne* d'un conteneur et n'est jamais chargé par un
processus Node lancé depuis le poste de développement. `ADMIN_PASSWORD` valait donc `admin` par
défaut côté outil de test (l'ancien Odoo out-of-the-box) pendant que le conteneur odoo, lui,
appliquait la vraie valeur de développement au compte `admin` -- deux vérités pour un seul mot de
passe, la seconde inconnue de la première.

**Règle** : avant d'appliquer D43 à une nouvelle variable, vérifier qui la consomme, pas
seulement ce qu'elle désigne. Une adresse de fournisseur ou un secret que seul le conteneur lit
peut suivre D43 sans risque. Une valeur qu'un outil hôte doit aussi connaître (ici, un secret de
service pour des fixtures de test) doit rester lisible depuis `infra/env/.env.example` /
`infra/env/.env`, quitte à y porter une valeur factice comme les autres secrets
(`POSTGRES_PASSWORD`, `JWT_SECRET`) -- la protection contre l'héritage en production reste portée
par `infra/production/deploy.sh`, pas par l'absence de la variable dans ce fichier.

---

## Un fil démon lancé depuis `env.cr.postcommit` peut mettre plus de 30 s à s'exécuter sous `workers = 0`

Le patron `env.cr.postcommit.add(lambda: _spawn(...))` (`services/push.py::notify_users_async`,
repris par `babana_ride_invoice.py::_babana_settle_send_invoice_email_async`, D57) suppose que le
fil démon qu'il lance obtient du temps CPU rapidement une fois la transaction commitée. Vérifié en
implémentant D57 : sous `services/odoo/config/odoo.conf` (`workers = 0`, un seul processus
multi-fils -- le réglage de développement, pas celui d'une vraie mise en production à plusieurs
travailleurs), un fil ainsi lancé peut rester inerte **plus de trente secondes** avant de
s'exécuter, y compris pour un échec de précondition qui ne fait ni rendu PDF ni appel réseau
(`babana_mail_error` posé pour "pas d'adresse email connue"). Ce n'est pas une latence réseau ni
de rendu -- une latence d'ordonnancement, plus marquée juste après une suite de tests qui vient de
solliciter le même processus.

Découvert le 13 septembre en vérifiant `make seed` : `odoo shell` se termine par `os._exit(0)`
(voir `services/odoo/scripts/seed.py`) -- un fil démon encore en vol à cet instant est tué net.
Une attente bornée de dix secondes après le commit ne suffisait pas ; portée à 120 s
(`_wait_for_pending_invoice_emails`), l'envoi automatique de chaque facture semée a fini par
aboutir, mais jamais en moins d'une poignée de secondes.

**Règle** : un script courte durée (`odoo shell`, un script de seed, un outil en ligne de
commande) qui déclenche un effet accroché à `env.cr.postcommit` doit attendre EXPLICITEMENT et de
façon BORNÉE que cet effet se soit réellement produit avant de laisser le processus se terminer --
en interrogeant l'état réel produit (jamais un délai fixe), avec un plafond généreux (au moins une
minute), pas les quelques secondes qui suffiraient dans un processus HTTP de longue durée.
