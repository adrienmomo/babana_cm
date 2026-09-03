# Facture de course (L4-06, CDC §III.3). `account.move` natif, jamais un modèle maison
# (`01-architecture.md` §6) : numérotation légale, PDF et envoi par email sont acquis sans code
# supplémentaire -- ce fichier ne fait que composer les lignes depuis le détail décomposé gelé
# de la course (fare_rule_snapshot, L2-04) et poser la pièce.
from __future__ import annotations

import base64
import json

from odoo import fields, models
from odoo.exceptions import UserError

from ..services.pricing import FareBreakdown, round_breakdown_for_wire

INVOICE_JOURNAL_PARAM = "babana.invoice_journal_id"
INVOICE_INCOME_ACCOUNT_PARAM = "babana.invoice_income_account_id"

# Même décomposition, mêmes libellés, même règle de visibilité que
# apps/client/src/components/fareBreakdown.ts (FARE_LINES / visibleFareLines) : une facture qui
# nommerait les composantes autrement que l'écran qui les a déjà montrées au client (résumé de
# fin de course, D41) serait illisible en cas de contestation -- c'est le même détail décomposé,
# jamais recalculé, seulement mis en forme deux fois (une fois pour l'écran, une fois pour la
# pièce comptable). `always_shown` : ligne toujours imprimée même à zéro (une facture qui
# n'afficherait ni prise en charge ni distance serait suspecte) ; les autres n'apparaissent que
# non nulles, sans quoi la plupart des factures porteraient une ligne "Majoration : 0 FCFA".
_FARE_LINES = (
    ("baseFare", "Prise en charge", False, True),
    ("distanceFare", "Distance", False, True),
    ("surgeAmount", "Majoration", False, False),
    ("discountAmount", "Remise", True, False),
    ("floorAmount", "Ajustement plancher", False, False),
    ("roundingAmount", "Arrondi", False, False),
)


class BabanaRide(models.Model):
    _inherit = "babana.ride"

    def _babana_invoice_accounting_param(self, param: str, label: str) -> int:
        value = self.env["ir.config_parameter"].sudo().get_param(param)
        if not value:
            raise UserError(
                f"{label} n'est pas configuré ({param}) -- impossible de générer la facture "
                "(L4-06)."
            )
        return int(value)

    def _babana_generate_invoice(self):
        """Compose et poste la facture de cette course (L4-06). Appelée depuis
        `action_settle` (babana_ride_state.py), AVANT `_babana_write_transition` -- pas après,
        et surtout pas via un rappel enregistré au commit (`env.cr.postcommit`, D32/D33) : ces
        deux règles gouvernent les appels sortants vers le SERVICE TEMPS RÉEL, dont l'écriture
        (Redis) ne peut pas être annulée si la transaction Odoo l'est ensuite -- voir l'en-tête
        de `services/realtime_client.py`. Une facture est une écriture Odoo ordinaire, comme la
        pièce comptable de la remise de caisse (`babana_cash_remittance.py::
        _babana_post_accounting_entry`, même patron, déjà en production) : la protéger par le
        savepoint existant d'`action_settle` est le comportement normal d'un effet qui doit
        s'annuler avec les autres s'il échoue -- exactement ce que demandait la spécification
        d'origine de L4-05 (« effets, dans une transaction unique ») et la recommandation
        laissée dans amoa/questions/L4-05.md (« L4-06 rejoint le même savepoint »). Appelée
        avant l'écriture de la transition (plutôt que dans le même bloc mais après) parce que
        `babana_ride_state.py::write` interdit toute écriture sur une course déjà 'settled' --
        y compris depuis l'intérieur du même savepoint qui vient de l'y faire passer ;
        `invoice_id` doit donc voyager dans le MÊME appel que `state`/`settled_at`, jamais un
        second write() après coup.

        Aucune règle métier recalculée ici (invariant 3) : le montant vient du détail décomposé
        gelé à la création de la course (fare_rule_snapshot), jamais recalculé depuis la grille
        tarifaire actuelle -- une facture qui différerait de ce que le client a payé serait
        indéfendable en cas de contestation (même raisonnement que `_babana_compute_final_amount`,
        babana_ride.py).

        `fare_rule_snapshot` absent (course créée directement par un test hors du vrai flux
        /quote -> /rides, ex. test_settlement.py, test_ride_state_machine.py) : dégrade sur une
        facture à une seule ligne portant `final_amount`, plutôt que de bloquer l'encaissement --
        même principe que `action_complete`/`notify_ride_completed` juste au-dessus (D30, "un
        défaut de donnée dégrade l'affichage, jamais la disponibilité"), étendu ici à la
        disponibilité de l'encaissement lui-même : une facture minimale reste préférable à
        aucune facture. Une vraie course, elle, porte toujours ce champ."""
        self.ensure_one()
        journal_id = self._babana_invoice_accounting_param(
            INVOICE_JOURNAL_PARAM, "Le journal de facturation"
        )
        income_account_id = self._babana_invoice_accounting_param(
            INVOICE_INCOME_ACCOUNT_PARAM, "Le compte de produit des courses"
        )

        if self.fare_rule_snapshot:
            breakdown = FareBreakdown(**json.loads(self.fare_rule_snapshot))
            wire = round_breakdown_for_wire(breakdown)
            line_vals = []
            for key, label, subtract, always_shown in _FARE_LINES:
                amount = wire[key]
                if not always_shown and not amount:
                    continue
                line_vals.append((0, 0, {
                    "name": label,
                    "account_id": income_account_id,
                    "quantity": 1,
                    "price_unit": -amount if subtract else amount,
                    # Aucune TVA en v1 (spécification, CDC §III.3 silencieux sur la fiscalité) --
                    # explicite plutôt que de laisser Odoo résoudre une taxe par défaut depuis une
                    # position fiscale qui n'a aucune raison d'exister ici.
                    "tax_ids": [(6, 0, [])],
                }))
        else:
            line_vals = [(0, 0, {
                "name": "Course",
                "account_id": income_account_id,
                "quantity": 1,
                "price_unit": self.final_amount,
                "tax_ids": [(6, 0, [])],
            })]

        # La somme des lignes égale exactement final_amount (critère d'acceptation 2) : c'est
        # round_breakdown_for_wire (services/pricing.py) qui garantit l'identité, en absorbant
        # tout résidu d'arrondi dans roundingAmount -- jamais recalculé ici.
        move = self.env["account.move"].sudo().create({
            "move_type": "out_invoice",
            "journal_id": journal_id,
            "partner_id": self.client_id.id,
            "invoice_date": fields.Date.today(),
            "currency_id": self.currency_id.id,
            "ref": self.reference,
            "invoice_line_ids": line_vals,
        })
        move.sudo().action_post()
        return move

    def _babana_send_invoice_email(self):
        """Envoi par email, À LA DEMANDE du client (CDC §III.3) -- jamais automatique à
        l'encaissement (spécification L4-06), donc jamais appelée depuis action_settle. Aucun
        écran client ni contrôleur mobile n'est dans le périmètre de fichiers de cette tâche :
        un bouton du back-office (babana_ride_views.xml, button_send_invoice_email) est le seul
        appelant ce soir -- un client qui redemande sa facture le fait aujourd'hui en contactant
        l'exploitant, pas depuis l'app.

        Utilise le rapport babana (report/babana_invoice_template.xml), pas le rapport
        générique d'Odoo : le client doit recevoir départ/arrivée/chauffeur/immatriculation, pas
        seulement les lignes comptables. `mail.mail` plutôt que `message_post` sur la facture --
        un envoi ponctuel à une adresse externe, pas une note de suivi interne."""
        self.ensure_one()
        if not self.invoice_id:
            raise UserError("Cette course n'a pas encore de facture (L4-06).")
        if not self.client_id.email:
            raise UserError(
                "Ce client n'a pas d'adresse email connue -- impossible d'envoyer la facture."
            )

        report = self.env.ref("babana.action_report_ride_invoice")
        pdf_content, _report_type = report.sudo()._render_qweb_pdf(
            report.report_name, [self.invoice_id.id]
        )
        attachment = self.env["ir.attachment"].sudo().create({
            "name": f"{self.invoice_id.name or self.reference}.pdf",
            "type": "binary",
            "datas": base64.b64encode(pdf_content),
            "res_model": "account.move",
            "res_id": self.invoice_id.id,
            "mimetype": "application/pdf",
        })
        self.env["mail.mail"].sudo().create({
            "subject": f"Votre facture babana.cm -- {self.reference}",
            "body_html": (
                f"<p>Bonjour,</p><p>Voici la facture de votre course {self.reference}.</p>"
            ),
            "email_to": self.client_id.email,
            "attachment_ids": [(6, 0, [attachment.id])],
        }).sudo().send()
        return True

    def button_send_invoice_email(self):
        """Bouton du formulaire (`views/babana_ride_views.xml`) -- même patron que
        `babana.cash.remittance.button_validate` : sans argument, l'action ne dépend que de
        l'enregistrement affiché."""
        self.ensure_one()
        return self._babana_send_invoice_email()


class AccountMove(models.Model):
    _inherit = "account.move"

    # Sens inverse de babana.ride.invoice_id (Many2one) -- porté ici en calculé plutôt qu'en
    # Many2one stocké : une seule relation, une seule source de vérité (babana.ride.invoice_id,
    # posée par action_settle), jamais deux champs à tenir synchronisés. Utilisé par le rapport
    # (report/babana_invoice_template.xml) pour retrouver départ, arrivée, distance, chauffeur et
    # immatriculation -- des mentions qu'account.move ne porte pas nativement (spécification).
    babana_ride_id = fields.Many2one(
        "babana.ride", compute="_compute_babana_ride_id", string="Course facturée"
    )

    def _compute_babana_ride_id(self):
        Ride = self.env["babana.ride"].sudo()
        for move in self:
            move.babana_ride_id = Ride.search([("invoice_id", "=", move.id)], limit=1)
