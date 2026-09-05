# Écart — `test_weekday_mask_restricts_applicability` rouge entre 23h et minuit UTC (5 septembre 2026)

Trouvé en exécutant `make test` en entier sur une base fraîche (protocole L6-18, pas dans le
périmètre de cette tâche) — consigné plutôt que corrigé à la volée sur du code hors périmètre
(`services/odoo/addons/babana/tests/test_fare_rule.py`, `models/babana_fare_rule.py`, L2-01).

## Constaté

```
FAIL: TestBabanaFareRule.test_weekday_mask_restricts_applicability
AssertionError: babana.fare.rule(1,) != babana.fare.rule(21,)
```

Échoué à 23:32:07 UTC. `date -u` sur cette machine au moment de l'investigation : `4 sept. 2026
23:33:37 UTC` — dans la fenêtre exacte que le diagnostic ci-dessous prédit.

## Cause identifiée, pas corrigée

Le test (`test_fare_rule.py:112`) calcule `a_monday`/`a_tuesday` à partir de `datetime.now()` —
naïf, heure système du conteneur (UTC) — en ne décalant que la **date**, jamais l'heure :

```python
today = datetime.now()
a_monday = today + timedelta(days=(0 - today.weekday()) % 7)
a_tuesday = a_monday + timedelta(days=1)
```

`_find_applicable_rule` (`babana_fare_rule.py:316`, comportement voulu et documenté, **pas le
défaut**) traite `at_datetime` comme de l'UTC naïf et le convertit en heure locale de Douala
(UTC+1) avant de lire `weekday_mask` — exactement ce que D45 exige déjà côté horaire
(`time_start`/`time_end`), étendu ici au jour de semaine.

**La combinaison des deux est le défaut** : quand le test tourne entre 23h00 et 23h59 UTC,
`a_monday` porte l'heure courante (23hXX) sur la date d'un lundi — une fois convertie en UTC+1,
elle bascule après minuit, donc en **mardi local**. La règle « lundi seulement » ne s'applique
alors plus à ce qui est censé être « un lundi », et la sélection retombe sur la règle de repli
(id 1) au lieu de la règle du test (id 21 ici) — le message d'assertion l'un contre l'autre est
la conséquence directe, pas une coïncidence.

Même famille que `amoa/questions/L5-collected-today-timezone-boundary.md`, déjà connu dans ce
dépôt sous un autre module : un test qui construit un instant « valable aujourd'hui » sans fixer
l'heure du jour est correct 23 heures sur 24, et faux dans la fenêtre où la conversion de fuseau
fait franchir minuit à la date locale.

## Pas allé plus loin

Hors du périmètre de cette nuit (L6-18, export web du Client) — `models/babana_fare_rule.py` et
`tests/test_fare_rule.py` n'ont aucun rapport avec l'export web, et le corriger à la volée aurait
été improviser sur du code que la consigne ne nommait pas.

**Le moteur de tarification n'est pas en cause** : la conversion UTC→local de
`_find_applicable_rule` est le comportement documenté et voulu (D45 étendu). Le défaut vit
entièrement dans le test, qui doit fixer une heure de la journée loin des deux bords (par exemple
midi UTC) plutôt que de reprendre l'heure courante telle quelle.

## Proposition

Fixer l'heure de `a_monday`/`a_tuesday` à une valeur du milieu de journée UTC (`replace(hour=12,
minute=0, second=0, microsecond=0)`) avant tout calcul de décalage — rend le test correct à
toute heure d'exécution, sans changer ce qu'il vérifie. Un balayage de `test_fare_rule.py` et des
autres tests de ce module sensible (L2, couverture exhaustive exigée par CLAUDE.md) pour le même
motif (heure courante non fixée, proche d'un bord de fuseau) serait la bonne occasion d'inclure ce
correctif.
