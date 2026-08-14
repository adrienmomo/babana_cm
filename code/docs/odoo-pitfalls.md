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
