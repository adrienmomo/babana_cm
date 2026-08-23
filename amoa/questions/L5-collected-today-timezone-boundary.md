# Écart — `collectedToday` retombe à 0 près de minuit UTC, tous les jours (23-24 août 2026)

Trouvé par la passe finale de la nuit (`make test` sur base fraîche), pas dans le périmètre de
cette nuit (D43/D44/C-02R/L4-12, aucune tâche ne nomme le compte courant) — root-causé avant
d'écrire cette entrée, pas seulement observé, conformément au protocole.

## Constaté

`make test` sur base fraîche (`make reset && make up`) a échoué deux fois de suite, toujours sur
les deux mêmes tests, jamais sur autre chose :

```
FAIL: TestDriverCashController.test_a_remittance_does_not_count_as_collected_today
AssertionError: 0 != 1200

FAIL: TestDriverCashController.test_returns_balance_limit_and_collected_today
AssertionError: 0 != 2000
```

Un premier passage complet, plus tôt dans la nuit (avant 22h UTC), était passé sans erreur sur les
mêmes 2218 tests. Pas un flake au sens habituel de ce dépôt (aléatoire, non reproductible) : la
cause a été isolée avec certitude, pas supposée.

## Cause, vérifiée en `odoo shell`, pas supposée

```
>>> user = env["res.users"].sudo()._babana_find_or_create_from_google(sub=..., role="driver")
>>> user.tz
'Europe/Brussels'
>>> fields.Date.context_today(user)
2026-08-24
>>> datetime.utcnow()
2026-08-23 22:34:52
```

`_babana_find_or_create_from_google` (`models/res_users.py`) ne pose jamais `tz` à la création --
tout compte (client ou chauffeur) hérite donc du défaut Odoo (`Europe/Brussels`, UTC+2 en été),
quel que soit le fuseau réel de la personne (aucun chauffeur camerounais n'est à Bruxelles ; Douala
est UTC+1, WAT, jamais posé nulle part non plus).

`_babana_cash_collected_today` (`models/babana_driver.py:173-196`) calcule `today` avec
`fields.Date.context_today(self)` -- correct en soi, c'est le jour calendaire du fuseau de
l'utilisateur. Mais les bornes de la requête sont construites ensuite comme si ce jour calendaire
était directement une date UTC :

```python
today = fields.Date.context_today(self)
start = fields.Datetime.to_datetime(datetime.combine(today, time.min))  # minuit "aujourd'hui", jamais converti en UTC
end = start + timedelta(days=1)
movements = ...search([..., ("create_date", ">=", start), ("create_date", "<", end)])
```

`create_date` est stocké en UTC (comme tout Datetime Odoo). `start`/`end` sont des datetimes
naïfs construits sur le jour calendaire LOCAL, jamais décalés de l'offset du fuseau. Les deux
horloges divergent sur une fenêtre de plusieurs heures chaque jour -- pour `Europe/Brussels`
(UTC+2 en été), entre 22h00 et 23h59 UTC : `context_today()` est déjà passé au lendemain (minuit
heure de Bruxelles = 22h00 UTC), alors que `create_date` d'un mouvement posé à l'instant porte
encore la date UTC de la veille. La requête `[start, end)` du "lendemain UTC" ne le trouve donc
jamais -- `collectedToday` retombe silencieusement à 0, pour n'importe quel chauffeur, tous les
jours, sur cette fenêtre.

**Ce n'est pas qu'un artefact de test.** N'importe quel vrai chauffeur, avec le même défaut de
fuseau jamais posé à l'inscription, verrait sa recette du jour afficher 0 FCFA pendant cette
même fenêtre -- une course encaissée à l'instant, disparue de son propre écran.

## Pas allé plus loin

Hors du périmètre confié ce soir (D43/D44/C-02R/L4-12, aucun ne nomme le compte courant), et
touche `models/babana_driver.py` -- adjacent au lot L5 (logique financière), que `CLAUDE.md`
place explicitement parmi ce qui exige une revue humaine avant fusion. Corriger à la volée un
calcul de solde en fin de nuit, sur du code jamais nommé ce soir, est exactement le genre de
raccourci que le protocole d'écart demande de signaler plutôt que de trancher seul.

## Conséquence pour la passe finale de cette nuit

`make test` reste rouge sur ces deux tests précis tant que l'horloge UTC du conteneur reste dans
la fenêtre 22h00-23h59 (jusqu'à ce que ce défaut soit corrigé, ou hors de cette fenêtre). Aucun
autre test n'est concerné, sur aucune des passes de ce soir -- vérifié en isolant : le sous-lot
`babana` (418 tests, hors fenêtre) est passé deux fois de suite à 0 échec, seule la passe complète
qui recouvrait 22h-24h UTC a montré ces deux échecs, toujours les deux mêmes.

## Proposition

Corriger `_babana_cash_collected_today` pour convertir `start`/`end` en UTC réel avant la requête
(`pytz.timezone(tz).localize(...).astimezone(pytz.UTC)`, ou l'équivalent que le reste du dépôt
utilise déjà pour ce genre de conversion), **et** pour poser un `tz` réel à l'inscription plutôt
que de laisser courir le défaut Odoo -- au minimum `Africa/Douala` par défaut (D19 : une valeur
plausible mais fausse est pire qu'une absence, donc peut-être plutôt une valeur explicitement
configurable, invariant 5). Candidat naturel : une tâche du lot L5, avec revue humaine comme
`CLAUDE.md` l'exige pour ce lot.
