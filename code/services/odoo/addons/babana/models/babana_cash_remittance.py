# Remise de caisse chauffeur (D8, L5-03, L5-04, L5-05, L5-06). Le chauffeur déclare ce qu'il
# remet (action_declare), un superviseur compte et valide (action_validate) -- la double saisie
# est ce qui rend un écart détectable. La validation pose aussi la pièce comptable (L5-05) et,
# si l'écart est non nul, l'enregistrement dédié qui le rend visible (L5-06, D29,
# babana_cash_discrepancy.py) -- jamais absorbé en silence dans le montant principal.
from __future__ import annotations

import uuid

from odoo import api, fields, models
from odoo.exceptions import UserError

from ..services import realtime_client

# L5-05 : comptes et journal paramétrables (invariant 5), jamais codés en dur -- voir
# data/accounting_config.xml pour les valeurs par défaut (provisoires, plan comptable générique
# de démonstration, pas OHADA -- même réserve que CASH_LIMIT_FALLBACK, babana_driver.py).
CASH_REMITTANCE_JOURNAL_PARAM = "babana.cash_remittance_journal_id"
CASH_REMITTANCE_CASH_ACCOUNT_PARAM = "babana.cash_remittance_cash_account_id"
CASH_REMITTANCE_RECEIVABLE_ACCOUNT_PARAM = "babana.cash_remittance_receivable_account_id"
CASH_REMITTANCE_DISCREPANCY_ACCOUNT_PARAM = "babana.cash_remittance_discrepancy_account_id"


class BabanaCashRemittance(models.Model):
    _name = "babana.cash.remittance"
    _description = "Remise de caisse chauffeur (D8, L5-03)"
    _order = "create_date desc, id desc"

    reference = fields.Char(
        required=True, copy=False, default="/", readonly=True,
        help="Référence humaine, par séquence (babana.cash.remittance) -- distincte de public_id "
        "(UUID, exposé à l'API mobile, C-01), même partition que babana.ride.",
    )
    public_id = fields.Char(
        index=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        help="Identifiant exposé à l'API mobile (CreateRemittanceResponseSchema, C-01) -- jamais "
        "l'identifiant Odoo interne, même règle que babana.ride.public_id et "
        "babana.driver.public_id (posée le 15 août).",
    )
    driver_id = fields.Many2one("babana.driver", required=True, index=True, ondelete="restrict")
    currency_id = fields.Many2one(
        "res.currency",
        required=True,
        default=lambda self: self.env.company.currency_id.id,
    )
    expected_amount = fields.Monetary(
        string="Montant attendu",
        currency_field="currency_id",
        readonly=True,
        help="Solde du chauffeur au moment de la création de la remise (critère d'acceptation "
        "1) -- figé une fois pour toutes par create(), jamais recalculé même si le solde change "
        "ensuite. Une course encaissée après cet instant n'y est donc jamais incluse (critère 2).",
    )
    declared_amount = fields.Monetary(
        string="Montant déclaré",
        currency_field="currency_id",
        help="Ce que le chauffeur annonce remettre (L5-04) -- saisi une fois, à la création.",
    )
    counted_amount = fields.Monetary(
        string="Montant compté",
        currency_field="currency_id",
        help="Ce que le superviseur compte réellement (L5-04) -- vide tant que la remise n'est "
        "pas validée ou contestée.",
    )
    discrepancy_amount = fields.Monetary(
        string="Écart",
        currency_field="currency_id",
        compute="_compute_discrepancy_amount",
        store=True,
        help="expected_amount - counted_amount, calculé, jamais saisi (critère d'acceptation 3) "
        "-- 0 tant que counted_amount n'a pas été renseigné (avant validation). Ne devient "
        "jamais négatif en pratique : une remise qui ferait passer le solde sous zéro est "
        "refusée par le mouvement de compte courant qu'elle tenterait de créer (L5-01, critère "
        "4) -- babana_cash_movement.py::_check_collection_and_remittance_never_go_negative.",
    )
    state = fields.Selection(
        [
            ("draft", "Brouillon"),
            ("declared", "Déclarée"),
            ("validated", "Validée"),
            ("disputed", "Contestée"),
        ],
        default="draft",
        required=True,
        help="'draft' n'est jamais atteint par le chemin normal (L5-04, action_declare crée "
        "directement en 'declared') -- conservé pour compléter l'énumération de la "
        "spécification (L5-03) et pour un usage back-office futur non prévu par ce lot.",
    )
    supervisor_id = fields.Many2one("res.users", ondelete="restrict")
    declared_at = fields.Datetime()
    validated_at = fields.Datetime()
    discrepancy_reason = fields.Text(
        help="Motif libre, renseignable par le superviseur à la validation. Distinct du "
        "traitement structuré de l'écart (babana.cash.discrepancy, L5-06), qui porte son "
        "propre motif catégorisé et sa propre exigence de clôture motivée.",
    )
    move_id = fields.Many2one(
        "account.move",
        copy=False,
        ondelete="restrict",
        help="Pièce comptable de la validation (L5-05) -- vide tant que la remise n'est pas "
        "validée. La pièce référence la remise en retour (account_move.py, L5-05) : référence "
        "mutuelle (critère d'acceptation 4 de L5-05).",
    )
    covered_movement_ids = fields.Many2many(
        "babana.cash.movement",
        string="Encaissements couverts",
        help="Mouvements de type 'collection' composant le solde attendu, gelés à la création "
        "(critère d'acceptation 5) -- jamais recalculés. Un encaissement déjà couvert par une "
        "remise précédente n'est jamais couvert deux fois (create(), ci-dessous).",
    )
    ride_ids = fields.Many2many(
        "babana.ride",
        compute="_compute_ride_ids",
        string="Courses couvertes",
        help="Dérivé de covered_movement_ids.ride_id -- 'on doit pouvoir dire quelles courses "
        "ont été réglées par quelle remise' (spécification L5-03).",
    )

    _sql_constraints = [
        (
            "babana_cash_remittance_public_id_unique",
            "unique(public_id)",
            "Collision d'identifiant public de remise -- ne devrait jamais se produire (UUID).",
        ),
    ]

    @api.depends("covered_movement_ids.ride_id")
    def _compute_ride_ids(self):
        for record in self:
            record.ride_ids = record.covered_movement_ids.ride_id

    @api.depends("counted_amount", "expected_amount", "state")
    def _compute_discrepancy_amount(self):
        for record in self:
            if record.state in ("validated", "disputed"):
                record.discrepancy_amount = record.expected_amount - record.counted_amount
            else:
                record.discrepancy_amount = 0.0

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            driver_id = vals.get("driver_id")
            if not driver_id:
                raise UserError("driver_id est requis pour créer une remise de caisse.")
            driver = self.env["babana.driver"].browse(driver_id)

            if not vals.get("reference") or vals.get("reference") == "/":
                vals["reference"] = self.env["ir.sequence"].next_by_code(
                    "babana.cash.remittance"
                ) or "/"
            vals.setdefault("currency_id", driver.currency_id.id)

            # Gel à la création (critère d'acceptation 1) : le solde ET les encaissements qui le
            # composent, jamais recalculés ensuite -- _babana_cash_balance() plutôt que
            # driver.cash_balance (le champ calculé, en cache) pour la même raison que
            # babana_cash_movement.py le fait déjà : on veut la somme réelle à cet instant.
            vals["expected_amount"] = driver._babana_cash_balance()

            already_covered_ids = (
                self.sudo()
                .search([("driver_id", "=", driver_id)])
                .covered_movement_ids.ids
            )
            movements = self.env["babana.cash.movement"].sudo().search(
                [
                    ("driver_id", "=", driver_id),
                    ("movement_type", "=", "collection"),
                    ("id", "not in", already_covered_ids),
                ]
            )
            vals["covered_movement_ids"] = [(6, 0, movements.ids)]
        return super().create(vals_list)

    def write(self, vals):
        for record in self:
            if record.state == "validated" and vals:
                raise UserError(
                    "Remise validée : plus aucune modification n'est permise (critère "
                    "d'acceptation 4, L5-03)."
                )
        if "expected_amount" in vals:
            raise UserError(
                "expected_amount est figé à la création, jamais réécrit ensuite (critère "
                "d'acceptation 1, L5-03)."
            )
        return super().write(vals)

    # --- L5-04 : déclaration puis validation ---------------------------------------------------

    def action_declare(self, *, driver, declared_amount):
        """Le chauffeur déclare (parcours en deux temps, L5-04) : crée la remise directement à
        l'état 'declared' -- 'draft' n'est jamais atteint par ce chemin (voir le help de
        `state`). create() (L5-03) fait le gel de expected_amount et covered_movement_ids."""
        if declared_amount <= 0:
            raise UserError("Le montant déclaré doit être strictement positif (L5-04).")
        return self.create(
            {
                "driver_id": driver.id,
                "declared_amount": declared_amount,
                "state": "declared",
                "declared_at": fields.Datetime.now(),
            }
        )

    def action_validate(self, *, supervisor, counted_amount, reason=None):
        """Le superviseur compte et valide (L5-04). Concordance déclaré/compté -> 'validated' ;
        discordance -> 'disputed' -- les deux produisent le même mouvement de compte courant
        (critère 6 : SEULE la validation, jamais la déclaration seule, ne touche le solde) : la
        discordance n'est pas un refus, c'est un signal que le comptage et la déclaration ne
        s'accordent pas, à instruire (L5-06), pas à bloquer.

        Le montant réellement remis peut être inférieur au montant dû (D29, arbitré le 17 août,
        `01-architecture.md` §7) : le mouvement `remittance` ne porte que `counted_amount`, la
        différence reste au solde du chauffeur et continue de peser sur son plafond -- "la remise
        remet le solde à zéro" (D8) n'est vrai que pour une remise complète."""
        self.ensure_one()
        if self.state != "declared":
            raise UserError(
                f"Impossible de valider une remise depuis l'état '{self.state}' (L5-04)."
            )
        if self.driver_id.user_id and self.driver_id.user_id == supervisor:
            raise UserError(
                "Un chauffeur ne peut pas valider sa propre remise, même avec le rôle de "
                "superviseur (L5-04, critère d'acceptation 2)."
            )

        concordant = self.currency_id.compare_amounts(counted_amount, self.declared_amount) == 0
        new_state = "validated" if concordant else "disputed"
        # Calculé ici, pas lu sur self.discrepancy_amount (compute, ne reflète le nouveau
        # counted_amount qu'après le write() plus bas) -- et surtout pas dans un second write()
        # après coup : le premier aura déjà posé state='validated' le cas échéant, et le garde-
        # fou d'immutabilité (write(), critère 4 de L5-03) bloquerait tout appel suivant, y
        # compris depuis l'intérieur de cette méthode.
        discrepancy_amount = self.expected_amount - counted_amount

        with self.env.cr.savepoint():
            # La pièce comptable d'abord (L5-05) : son échec (compte non configuré, par exemple)
            # ne doit laisser aucun des trois effets appliqué, même raisonnement que
            # action_settle -- et move_id part dans le MÊME write() que la transition, plus bas,
            # jamais un second après coup (voir la note ci-dessus).
            move = self._babana_post_accounting_entry(
                counted_amount=counted_amount, discrepancy_amount=discrepancy_amount
            )

            vals = {
                "counted_amount": counted_amount,
                "state": new_state,
                "supervisor_id": supervisor.id,
                "validated_at": fields.Datetime.now(),
                "move_id": move.id,
            }
            if reason is not None:
                vals["discrepancy_reason"] = reason
            self.write(vals)

            if counted_amount:
                # Un compte à zéro (chauffeur qui déclare, puis remet effectivement 0 -- écart
                # total) ne crée aucun mouvement : babana_cash_movement.py interdit un mouvement
                # à zéro (_sql_constraints, L5-01), et il n'y a rien à journaliser sur le solde
                # dans ce cas -- l'écart couvre déjà tout.
                self.env["babana.cash.movement"].sudo().create(
                    {
                        "driver_id": self.driver_id.id,
                        "movement_type": "remittance",
                        "amount": -counted_amount,
                    }
                )

            if discrepancy_amount:
                # L5-06, critère 1 : tout écart non nul crée systématiquement un enregistrement
                # dédié -- dans le même savepoint que le reste, jamais un effet séparé qui
                # pourrait exister sans la remise qui l'a produit.
                self.env["babana.cash.discrepancy"].sudo().create(
                    {
                        "remittance_id": self.id,
                        "driver_id": self.driver_id.id,
                        "amount": discrepancy_amount,
                        "direction": "shortfall",
                    }
                )

        # D33/D32 : la même discipline que action_settle -- l'appel sortant, une fois qu'on sait
        # que l'effet a vraiment eu lieu, jamais depuis l'intérieur du savepoint. Débloquer un
        # chauffeur déjà en dessous du plafond ne coûte rien (DEL Redis best-effort côté service
        # temps réel, cash-guard.ts::unblockForCash) -- appelé systématiquement plutôt que suivi
        # d'un état "était-il bloqué avant ?" à faire porter par cette méthode.
        self.driver_id.invalidate_recordset(["cash_balance"])
        if not (self.driver_id.cash_limit and self.driver_id.cash_balance >= self.driver_id.cash_limit):
            realtime_client.notify_cash_limit_cleared(
                self.env, driver_public_id=self.driver_id.public_id
            )

        return self

    def _babana_accounting_param(self, param: str, label: str) -> int:
        value = self.env["ir.config_parameter"].sudo().get_param(param)
        if not value:
            raise UserError(
                f"{label} n'est pas configuré ({param}) -- impossible de poser la pièce "
                "comptable de la remise (L5-05)."
            )
        return int(value)

    def _babana_post_accounting_entry(self, *, counted_amount, discrepancy_amount):
        """Pièce comptable de la validation (L5-05) : `account.move` natif d'Odoo, pas un modèle
        maison (`01-architecture.md` §6) -- numérotation légale, PDF et envoi par email sont
        acquis sans code supplémentaire. Deux paires débit/crédit distinctes plutôt qu'une
        seule fusionnée : un écart absorbé dans le montant principal serait invisible au
        contrôle (spécification, critère d'acceptation 3).

        Le compte de créance sur les chauffeurs est crédité pour le montant attendu EN ENTIER
        (counted_amount + discrepancy_amount = expected_amount) : la créance de cette remise est
        soldée en comptabilité, l'écart est reclassé sur son propre compte de suivi -- pas
        laissé tel quel sur la créance générale. Ceci ne contredit pas D29 : le compte courant
        Odoo (babana.cash.movement, source du plafond) est un système distinct, qui continue
        pour sa part de porter l'écart au débit du chauffeur (action_validate, ci-dessus) --
        deux systèmes, deux vérités compatibles, pas une seule redondante.

        Aucun montant nul : une paire dont le montant serait 0 (compte à zéro entièrement en
        écart, ou remise sans le moindre écart) n'est simplement pas ajoutée aux lignes."""
        self.ensure_one()
        journal_id = self._babana_accounting_param(
            CASH_REMITTANCE_JOURNAL_PARAM, "Le journal de caisse"
        )
        cash_account_id = self._babana_accounting_param(
            CASH_REMITTANCE_CASH_ACCOUNT_PARAM, "Le compte de caisse"
        )
        receivable_account_id = self._babana_accounting_param(
            CASH_REMITTANCE_RECEIVABLE_ACCOUNT_PARAM,
            "Le compte de créance sur les chauffeurs",
        )

        line_vals = []
        if counted_amount:
            line_vals += [
                (0, 0, {
                    "name": f"Remise de caisse {self.reference}",
                    "account_id": cash_account_id,
                    "debit": counted_amount,
                    "credit": 0.0,
                }),
                (0, 0, {
                    "name": f"Remise de caisse {self.reference}",
                    "account_id": receivable_account_id,
                    "debit": 0.0,
                    "credit": counted_amount,
                }),
            ]
        if discrepancy_amount:
            discrepancy_account_id = self._babana_accounting_param(
                CASH_REMITTANCE_DISCREPANCY_ACCOUNT_PARAM, "Le compte d'écart"
            )
            line_vals += [
                (0, 0, {
                    "name": f"Écart de caisse {self.reference}",
                    "account_id": discrepancy_account_id,
                    "debit": discrepancy_amount,
                    "credit": 0.0,
                }),
                (0, 0, {
                    "name": f"Écart de caisse {self.reference}",
                    "account_id": receivable_account_id,
                    "debit": 0.0,
                    "credit": discrepancy_amount,
                }),
            ]

        move = self.env["account.move"].sudo().create(
            {
                "move_type": "entry",
                "journal_id": journal_id,
                "date": fields.Date.today(),
                "ref": self.reference,
                "line_ids": line_vals,
            }
        )
        move.sudo().action_post()
        return move

    def button_validate(self):
        """Bouton du formulaire (`views/babana_remittance_views.xml`) : sans argument, contra-
        irement à `action_validate` -- `counted_amount` est un champ du formulaire, déjà
        modifiable pendant que la remise est 'declared' (write(), ci-dessus), donc déjà enregistré
        au moment du clic (Odoo sauvegarde les modifications en attente avant d'appeler une
        méthode de bouton). Pas de sudo() : l'appartenance à group_babana_supervisor est ce qui
        autorise l'écriture (ir.model.access.csv), même discipline que
        babana_driver.py::action_approve."""
        self.ensure_one()
        return self.action_validate(supervisor=self.env.user, counted_amount=self.counted_amount)
