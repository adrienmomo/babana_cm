# Rapport — nuit J44 (4 septembre 2026)

Périmètre : D69 (les deux assertions comptables non bornées, plus le balayage des quatre lots
sensibles), et le `<footer>` du tableau de bord de caisse (L9-05).

---

## 1. D69 — les deux assertions bornées à leur scénario, pas à toute la base

`amoa/01-architecture.md` §9 undecies posait le diagnostic exact : deux tests du lot L5 sommaient
tous les mouvements du compte de créance présents en base (`search([("account_id", "=", ...)])`)
au lieu des seules pièces produites par leur propre scénario. Vrais sur une base vide (les deux
nombres coïncident par accident), faux dès que la base contient l'histoire d'autres remises —
c'est-à-dire faux au moment précis où le pilote démarrera.

**Les deux sites, corrigés à l'identique** :

- `test_remittance_accounting.py::test_two_successive_partial_remittances_never_leave_the_receivable_in_a_credit_balance` —
  la somme est maintenant bornée à `first.move_id | second.move_id` (les deux pièces que CE
  scénario a posées), filtrées sur le compte de créance, au lieu d'une recherche ouverte sur tout
  le compte.
- `test_discrepancy.py::test_an_explicit_adjustment_writes_off_the_remaining_receivable` — même
  correctif, bornée à `remittance.move_id | move` (la pièce de validation et la pièce
  d'extourne de ce scénario).

**Vérifié que l'assertion corrigée protège encore la règle qu'elle nomme**, pas seulement qu'elle
passe : `_babana_post_accounting_entry` cassée temporairement (`credit`/`debit` de la créance et
de la caisse gonflés de 1000 chacun, pour rester une pièce équilibrée et ne pas buter sur la garde
`_check_balanced` d'Odoo avant d'atteindre l'assertion visée) — les deux tests corrigés échouent
alors avec le bon message (`46000.0 != 45000`, `47000.0 != 45000`), sur une base **ancienne**
(celle qui a servi aux essais du soir, jamais réinitialisée entre-temps) — exactement le cas que
l'ancienne rédaction ratait. Cassure retirée, `git diff` sur le modèle revient à vide.

**Balayage des quatre lots sensibles** (`CLAUDE.md` : moteur de cotation, machine à états,
mouvements de compte courant, réservation atomique — couverture de tous les chemins exigée) :
recherche de toute agrégation (`sum(`, `search_count`, `.mapped("credit"/"debit"/"amount")`) sur
un modèle partagé, filtrée par autre chose qu'un identifiant créé DANS le test. Résultat : rien
d'autre. Les occurrences trouvées sont soit des générateurs d'unicité de fixture
(`search_count([]) + 1` pour une plaque d'immatriculation), soit un motif avant/après légitime
(`count_before` / `count_after`, sûr quel que soit l'état de la base parce qu'il mesure un delta,
jamais un total absolu), soit déjà bornées à un enregistrement créé dans le scénario
(`move.line_ids`, `ride.invoice_id.invoice_line_ids`). Côté réservation atomique
(`services/realtime/test/concurrency/reservation.test.ts`), chaque assertion porte sur un
`driverId` généré par le test (`${label}-${RUN_ID}`) — jamais une agrégation sur le pool entier.
**Rien trouvé d'autre à corriger** : les deux sites relevés dans `amoa/01-architecture.md` §9
undecies étaient les deux seuls.

Fichiers : `services/odoo/addons/babana/tests/test_remittance_accounting.py`,
`services/odoo/addons/babana/tests/test_discrepancy.py`.

---

## 2. Le `<footer>` du tableau de bord de caisse (L9-05)

Même défaut que celui trouvé et corrigé hier soir sur `babana_audit_log_health_view_form`
(D68, J43) : `babana_cash_dashboard_view_form` s'ouvre en `target="current"` (plein écran), et le
client web d'Odoo 18 ne rend jamais de `<footer>` sur une action plein écran — seulement sur une
action `target="new"` (boîte de dialogue). Le bouton « Actualiser » n'existait donc nulle part,
alors que le bandeau d'aide disait explicitement « utiliser « Actualiser » ci-dessous ».

**Correctif, même patron qu'hier** : le bouton `action_refresh` déplacé dans un `<header>`,
le bouton « Fermer » (`special="cancel"`) retiré — il n'a de sens que dans une boîte de dialogue —
et le bandeau corrigé (« ci-dessus » au lieu de « ci-dessous »). Commentaire XML posé au même
endroit que sur l'écran d'hier, avec renvoi croisé dans les deux sens.

**Ouvert pour de vrai, deux fois** (point 9) : une première fois juste après le correctif, sur la
base encore ancienne (3 heures, plusieurs exécutions de tests dedans) — bouton visible dans le
`<header>`, cliqué, la vue se recharge (`babana.cash.dashboard,1` dans le fil d'Ariane, valeurs
inchangées puisque rien n'avait bougé entre-temps). Une seconde fois après le `make reset` complet
de ce soir et un `make seed` neuf : mêmes vérifications, sur des valeurs réelles cette fois (9 200
FCFA détenus par la flotte, une remise en attente `R2026000055`). Les deux fois, bouton cliqué,
aucune erreur, la fiche se recharge normalement.

Fichiers : `services/odoo/addons/babana/views/babana_remittance_views.xml`,
`services/odoo/addons/babana/views/babana_audit_log_views.xml` (commentaire d'hier mis à jour :
il annonçait ce correctif comme non fait, il est fait).

---

## 3. Passe finale — `make reset` complet, `make seed`, suite complète

`make reset` poussé jusqu'au bout (volume Postgres et tout le reste effacés), comme les deux
nuits précédentes. Deux passes d'installation, même raison que J43 : `-i babana` seul d'abord
(sans `--test-enable`, ~24 s, pas de suite Odoo amont rejouée), puis `-i babana --test-enable`
sur le module déjà installé. **Résultat, base vraiment neuve : 0 échec, 0 erreur, 820 tests**
Odoo — les deux tests corrigés de D69 compris.

`make seed` (2 min 7 s cette fois — cohérent avec le coût documenté par J43 pour une première
installation) : 6 zones, 5 chauffeurs en ligne, 8 courses réglées, sans anomalie nouvelle.

**Les deux écrans (tableau de bord de caisse, état du journal d'audit) rouverts sur cette base
neuve**, avec de vraies valeurs cette fois — voir §2. Aucune régression du correctif d'hier soir.

### `npm test` — un échec transitoire, dans un fichier hors périmètre de cette nuit

`services/realtime` (226 tests) et `apps/*` + `packages/*` (193 tests, 28 suites Jest) sont passés
sans anomalie. Dans l'espace `test/`, `concurrency/ride-transitions.test.ts::scénario 1` a échoué
une fois (« chauffeur jamais apparu dans nearby.drivers après 20000ms »), suivi d'un silence total
dans le journal — aucune ligne nouvelle pendant seize minutes, alors que les fichiers suivants
(`select-driver-replay.test.ts`, `auth`+`http-contract`+`config`+`storage`,
`e2e/full-ride.test.ts`) prennent chacun entre 20 s et 90 s une fois exécutés seuls. Le processus
worker, observé à cet instant, tournait à 0 % CPU et ne portait plus aucune connexion réseau
ouverte (`lsof` vide) — un signal plus fort qu'une simple lenteur, sans être une preuve absolue
(la fenêtre d'observation reste ponctuelle).

**Ce que j'ai fait, plutôt que conclure directement** : le processus arrêté, puis chaque morceau
rejoué séparément sur l'environnement resté debout (aucun `make reset` entre-temps) :
`select-driver-replay.test.ts` seul (80 s, vert), `auth`+`http-contract`+`config`+`storage`
ensemble (45 tests, vert), `e2e/full-ride.test.ts` seul (5 tests, vert), et surtout
`ride-transitions.test.ts` seul, les trois scénarios : **vert, y compris le scénario 1** qui avait
échoué dans la chaîne continue (103 574 ms cette fois, contre l'échec à 49 551 ms plus tôt — pas
la même exécution, mais le même scénario). Les deux scripts de vérification des contrats
(`verify-ride-state-machine.js`, `verify-realtime-message-map.js`, jamais atteints par la chaîne
interrompue) rejoués séparément : verts, mêmes lacunes déjà documentées (`ride.cancelled`,
`ride.proposed`, `session.synced` encore sans consommateur, toutes trois déjà nommées dans
`amoa/questions/C-02R.md`).

**Verdict, honnête plutôt que définitif** : je ne peux pas distinguer avec certitude, depuis une
seule observation, un vrai figement (fuite de connexion, verrou Redis orphelin laissé par l'échec
du scénario 1) d'un artefact de mise en tampon du flux (`tee` vers un fichier, sortie TAP groupée
par fichier plutôt que par ligne). Ce que je sais : rejoué isolément juste après, sur le même
environnement sans redémarrage, le scénario 1 repasse au vert — donc ni un défaut du dépôt
reproductible à la demande, ni une contention entre deux exécutions concurrentes de ma part (une
seule instance de `node --test` tournait, vérifié par `ps`, contrairement au motif que J42 avait
diagnostiqué). **Quatrième occurrence du motif « instable, jamais retrouvé » que J41 catalogue** —
la troisième était `services/realtime/test/nearby.test.ts` (vu une fois le 15 septembre, jamais
depuis). Consigné dans la passe de clôture de J41 (ci-dessous) plutôt que classé sans suite : si le
figement de seize minutes revient un soir où il peut être observé en train de se produire (plutôt
qu'après coup), il vaut la peine d'être élucidé pour de vrai — mesurer les connexions Redis
ouvertes au moment même, pas dix minutes plus tard.

**Aucun rapport avec D69 ou L9-05** : `ride-transitions.test.ts` n'a pas été touché cette nuit, et
la suite Odoo (qui porte les deux correctifs de ce soir) était déjà verte, sur une base neuve,
avant que `npm test` ne démarre.

---

## Ce qui reste ouvert de votre côté

Inchangé depuis hier, `08-passation-pilote.md` en porte le détail. Le relais SMTP reste la seule
chose à faire si vous n'en faites qu'une.
