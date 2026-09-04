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
