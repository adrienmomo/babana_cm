# Écart — `res.users.babana_public_id` : la contrainte d'unicité ne s'applique jamais (trouvé J29)

## Constaté

Sur une base **fraîche** (`make reset && make up && make seed`), après installation du module :

```
select babana_public_id, count(*) from res_users group by 1 order by 2 desc;
           babana_public_id           | count
--------------------------------------+-------
 b841aeaa-7497-47e0-8530-1e5fbab532e0 |     7   <- __system__, admin, default, public,
 ...                                              portaltemplate, demo, portal (ids 1..7)
```

`pg_constraint` ne contient **pas** `res_users_babana_public_id_unique`. `pg_indexes` montre
seulement `res_users__babana_public_id_index` (l'index simple du `index=True`), jamais l'index
unique. Comparaison : `babana_google_sub_unique`, déclaré juste à côté dans le même
`_sql_constraints`, **est** bien appliqué (`google_sub` est `NULL` pour les 7 comptes système,
et `NULL` n'entre pas en conflit avec `NULL`).

## Cause

`res_users.py` déclare :

```python
babana_public_id = fields.Char(..., default=lambda self: str(uuid.uuid4()))
_sql_constraints = [
    ("babana_google_sub_unique", "unique(google_sub)", ...),
    ("babana_public_id_unique",  "unique(babana_public_id)", ...),
]
```

Quand Odoo ajoute une colonne stockée avec `default` sur une table qui a **déjà des lignes** (les
7 comptes système d'Odoo existent avant l'installation du module), le remplissage se fait par un
`UPDATE ... SET col = <valeur>` où `<valeur>` est le `default` évalué **une seule fois**, pas par
ligne. Les 7 comptes reçoivent donc le **même** UUID. La contrainte `unique(babana_public_id)`
échoue alors à la création (Odoo journalise `WARNING/ERROR: unable to add constraint
'res_users_babana_public_id_unique'` et **poursuit** l'installation) — la table reste sans
garantie d'unicité en base.

Même mécanisme latent pour tout autre `default=lambda: uuid` + `unique` sur une table déjà
peuplée à l'installation. Les autres cas du module (`res_partner.babana_google_sub`,
`babana.driver.public_id`, `babana.ride.public_id`, `babana.quote.public_id`) ne se déclenchent
pas aujourd'hui : ces tables sont vides au moment de l'installation.

## Impact

**Faible aujourd'hui, réel comme garantie manquante.**

- Les 7 comptes concernés sont des comptes **système** (jamais des utilisateurs mobiles) : aucun
  jeton applicatif n'est émis pour eux, `babana_public_id` n'est jamais exposé pour ces comptes.
- Un **vrai** compte mobile créé par `_babana_find_or_create_from_google` reçoit un `uuid4`
  frais par `create()` (chemin normal, pas le remplissage de colonne) — collision avec
  `b841aeaa-…` astronomiquement improbable.
- Mais `res.users.babana_public_id` **promet** l'unicité (docstring, `UserIdSchema` C-01) et la
  base ne la fait pas respecter. Tout code qui suppose que
  `search([("babana_public_id", "=", x)])` renvoie au plus une ligne s'appuie sur une garantie
  absente.

## Hors périmètre J29

Trouvé en validant `make seed` sur base fraîche ; c'est un défaut du modèle **L1-01**, pas du
seed. Signalé plutôt que corrigé à la volée sur du code hors périmètre (protocole d'écart).

## Proposition

Un `post_init_hook` (ou une migration `pre-init`) qui, juste après la création de la contrainte,
réassigne un `uuid4` **distinct** à chaque ligne dont le `babana_public_id` est partagé, puis
laisse Odoo (re)poser la contrainte — ou, plus simple, un hook qui backfille les lignes
existantes ligne par ligne **avant** que `_sql_constraints` ne soit évalué. Même traitement à
prévoir par prudence pour `res_partner.babana_google_sub` si un jour `res.partner` est peuplé
avant l'installation. À faire porter par une petite tâche de correction L1-01, sous revue (le
modèle d'authentification).
