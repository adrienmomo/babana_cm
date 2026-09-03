# Facture de course (L4-06, CDC §III.3). `account.move` natif, jamais un modèle maison
# (`01-architecture.md` §6) : numérotation légale, PDF et envoi par email sont acquis sans code
# supplémentaire -- ce fichier ne fait que composer les lignes depuis le détail décomposé gelé
# de la course (fare_rule_snapshot, L2-04) et poser la pièce.
from __future__ import annotations

import base64
import json
import logging
import threading

import odoo
from odoo import SUPERUSER_ID, api, fields, models
from odoo.exceptions import UserError

from ..services.pricing import FareBreakdown, round_breakdown_for_wire

_logger = logging.getLogger(__name__)

INVOICE_JOURNAL_PARAM = "babana.invoice_journal_id"
INVOICE_INCOME_ACCOUNT_PARAM = "babana.invoice_income_account_id"

# D57 (amoa/questions/REPONSES-2026-09-13.md §5) : « personne ne réclame une facture dont il
# ignore l'existence » -- la facture part donc automatiquement à l'encaissement, le bouton manuel
# ne restant qu'un rattrapage. Trois valeurs, jamais un simple booléen : distinguer « jamais
# tentée » de « tentée et en échec » est précisément ce que ce champ existe pour rendre visible
# (critère d'acceptation 7 de L4-05/L4-06 : un échec d'envoi doit se voir sans ouvrir un champ
# technique).
INVOICE_EMAIL_STATE_SELECTION = [
    ("not_sent", "Non envoyée"),
    ("sent", "Envoyée"),
    ("failed", "Échec d'envoi"),
]

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
        """Compose et tente l'envoi -- appelée par les DEUX chemins depuis D57 (amoa/questions/
        REPONSES-2026-09-13.md §5) : l'envoi automatique à l'encaissement (rattrapé par
        `_babana_settle_send_invoice_email_async` ci-dessous) et le bouton manuel du
        back-office (`button_send_invoice_email`), qui reste un rattrapage -- un client qui
        n'a pas reçu sa facture, ou dont l'adresse a changé depuis, la fait renvoyer en
        contactant l'exploitant.

        Utilise le rapport babana (report/babana_invoice_template.xml), pas le rapport
        générique d'Odoo : le client doit recevoir départ/arrivée/chauffeur/immatriculation, pas
        seulement les lignes comptables. `mail.mail` plutôt que `message_post` sur la facture --
        un envoi ponctuel à une adresse externe, pas une note de suivi interne.

        Lève `UserError` si l'envoi ne peut même pas être TENTÉ (pas de facture, pas d'adresse
        email) -- l'appelant automatique (`_babana_attempt_invoice_email`) l'attrape et
        l'enregistre comme échec visible ; le bouton manuel la laisse remonter telle quelle,
        pour un retour immédiat à qui clique. Renvoie l'enregistrement `mail.mail` lui-même
        (pas un simple booléen) : `mail.state`/`mail.failure_reason` sont ce qui distingue un
        envoi réellement parti d'un échec SMTP silencieux (D59, le défaut du 13 septembre)."""
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
        mail = self.env["mail.mail"].sudo().create({
            "subject": f"Votre facture babana.cm -- {self.reference}",
            "body_html": (
                f"<p>Bonjour,</p><p>Voici la facture de votre course {self.reference}.</p>"
            ),
            "email_to": self.client_id.email,
            "attachment_ids": [(6, 0, [attachment.id])],
        })
        mail.sudo().send()
        return mail

    def _babana_attempt_invoice_email(self):
        """Point d'entrée PARTAGÉ par le bouton manuel et l'envoi automatique (D57) -- ne lève
        JAMAIS, dépose toujours un compte rendu sur la FACTURE (`account.move.babana_mail_id` /
        `babana_mail_error`), jamais sur la course : `babana.ride.write()` interdit toute
        écriture une fois `state == 'settled'`, sans exception, y compris pour un administrateur
        (invariant 2, babana_ride_state.py) -- et l'envoi automatique n'a de sens qu'après
        l'encaissement. `babana.ride.invoice_email_state` (champ CALCULÉ, jamais stocké,
        ci-dessous) lit ce compte rendu à travers `invoice_id` : aucune écriture sur la course,
        donc aucun conflit avec l'invariant.

        `mail.sudo().send()` n'échoue pas forcément par exception (Odoo l'avale déjà et pose
        `state='exception'` + `failure_reason` -- exactement le mécanisme qui a caché la panne
        SMTP du 13 septembre, D59) : le succès de l'appel Python ne suffit donc pas, il faut
        relire `mail.state` après coup pour distinguer un envoi réellement parti d'un échec
        silencieux."""
        self.ensure_one()
        invoice = self.invoice_id
        try:
            mail = self._babana_send_invoice_email()
        except UserError as exc:
            invoice.sudo().write({"babana_mail_error": str(exc)})
            return None, str(exc)
        if mail.state in ("exception", "cancel"):
            reason = mail.failure_reason or (
                "Échec d'envoi (raison inconnue -- voir Discussion > Emails sur la facture)."
            )
            invoice.sudo().write({"babana_mail_id": mail.id, "babana_mail_error": reason})
            return mail, reason
        invoice.sudo().write({"babana_mail_id": mail.id, "babana_mail_error": False})
        return mail, None

    def _babana_settle_send_invoice_email_async(self):
        """Enregistre l'envoi automatique de la facture au COMMIT de la transaction
        d'encaissement (D57) -- jamais depuis le savepoint qui vient de la créer, et c'est la
        distinction que D58 a posée en clarifiant D32/D33 : la facture elle-même (`account.move`)
        est une écriture PostgreSQL ordinaire, défaite par le même ROLLBACK que le reste, donc
        elle reste dans le savepoint (`_babana_generate_invoice`) -- l'EMAIL, lui, est un appel
        SMTP sortant qu'un ROLLBACK ne peut pas défaire. S'il partait depuis le savepoint et que
        l'encaissement échouait ensuite (plafond, mouvement de compte courant), le client
        recevrait la facture d'une course qui n'a en réalité pas été encaissée -- exactement le
        défaut que D32 ferme pour le service temps réel, appliqué ici à un second effet
        irréversible.

        Fil de fond + nouveau curseur, même patron que `services/push.py::notify_users_async` :
        un envoi SMTP lent ne doit jamais retarder la réponse d'encaissement à l'application
        chauffeur, et toute écriture ORM après un commit exige un curseur neuf (celui de la
        requête d'origine est sur le point de se fermer)."""
        self.ensure_one()
        dbname = self.env.cr.dbname
        ride_id = self.id
        self.env.cr.postcommit.add(lambda: _spawn_invoice_email(dbname, ride_id))

    def button_send_invoice_email(self):
        """Bouton du formulaire (`views/babana_ride_views.xml`) -- même patron que
        `babana.cash.remittance.button_validate` : sans argument, l'action ne dépend que de
        l'enregistrement affiché. Rattrapage depuis D57 (l'envoi part désormais automatiquement
        à l'encaissement) : un clic donne un retour immédiat, contrairement à l'envoi
        automatique qui ne fait qu'enregistrer un état visible (`invoice_email_state`).

        D60 (amoa/questions/REPONSES-2026-09-14.md §2) : sur échec, ce gestionnaire NE LÈVE PAS.
        Un premier correctif faisait `env.cr.commit()` juste avant de lever `UserError` -- il
        fonctionnait, mais `Cursor.commit()` exécute au passage tous les points d'accroche au
        commit encore en attente sur ce curseur (`env.cr.postcommit`, D32/D33) : un gestionnaire
        qui commite puis lève déclenche donc les effets externes d'une requête qui se termine en
        erreur. Rien ne pose de point d'accroche avant ce bouton aujourd'hui, mais la garantie
        tenait alors à ce fait précaire -- pas à une propriété du code. Lever est une façon
        d'ANNULER une transaction, pas une façon d'afficher un message ; un échec qui doit
        laisser une trace (`invoice_email_state` posé à 'failed' par
        `_babana_attempt_invoice_email` ci-dessus) ne peut donc pas être signalé par une
        exception. La notification cliente (`ir.actions.client` / `display_notification`) rend
        le même message visible sans franchir cette porte : la transaction se termine
        normalement, l'écriture dedans."""
        self.ensure_one()
        _mail, error = self._babana_attempt_invoice_email()
        if error:
            return {
                "type": "ir.actions.client",
                "tag": "display_notification",
                "params": {
                    "title": "Envoi de la facture",
                    "message": error,
                    "type": "danger",
                    "sticky": True,
                },
            }
        return True

    invoice_email_state = fields.Selection(
        INVOICE_EMAIL_STATE_SELECTION,
        string="Envoi de la facture",
        compute="_compute_invoice_email_state",
        help="Calculé depuis account.move.babana_mail_id/babana_mail_error à travers "
        "invoice_id -- jamais stocké sur la course : une écriture directe est interdite une "
        "fois 'settled' (invariant 2), et l'envoi automatique (D57) n'a de sens qu'après.",
    )
    invoice_email_failure_reason = fields.Text(
        string="Motif de l'échec d'envoi", compute="_compute_invoice_email_state"
    )

    @api.depends("invoice_id.babana_mail_id.state", "invoice_id.babana_mail_error")
    def _compute_invoice_email_state(self):
        for ride in self:
            invoice = ride.invoice_id
            mail = invoice.babana_mail_id
            if invoice and invoice.babana_mail_error:
                ride.invoice_email_state = "failed"
                ride.invoice_email_failure_reason = invoice.babana_mail_error
            elif mail and mail.state in ("exception", "cancel"):
                ride.invoice_email_state = "failed"
                ride.invoice_email_failure_reason = mail.failure_reason or (
                    "Échec d'envoi (raison inconnue -- voir Discussion > Emails sur la facture)."
                )
            elif mail:
                ride.invoice_email_state = "sent"
                ride.invoice_email_failure_reason = False
            else:
                ride.invoice_email_state = "not_sent"
                ride.invoice_email_failure_reason = False


# --- Envoi automatique, fil de fond + nouveau curseur (D57) ---------------------------------
#
# Même patron que services/push.py::notify_users_async/_spawn/_run_in_new_cursor -- mêmes
# raisons : un envoi lent ne doit jamais retarder la transaction appelante, et toute écriture
# ORM après un commit exige un curseur neuf (celui de la requête d'origine se ferme). Fonctions
# de module plutôt que méthodes : `_babana_settle_send_invoice_email_async` ci-dessus ne capture
# que `dbname`/`ride_id`, jamais `self` -- un recordset lié au curseur de la transaction qui
# vient de committer n'est plus sûr à utiliser depuis un fil séparé.


def _spawn_invoice_email(dbname: str, ride_id: int) -> None:
    threading.Thread(
        target=lambda: _run_invoice_email_in_new_cursor(dbname, ride_id), daemon=True
    ).start()


def _run_invoice_email_in_new_cursor(dbname: str, ride_id: int) -> None:
    """Aucune exception ne remonte jamais d'ici (même garantie que push.py) : une course
    encaissée le reste même si l'envoi automatique échoue entièrement -- l'échec doit seulement
    rester VISIBLE (`_babana_attempt_invoice_email` l'enregistre sur la facture avant même
    d'atteindre ce niveau), jamais faire tomber le fil de fond en silence sans laisser de trace
    dans les journaux non plus."""
    try:
        registry = odoo.registry(dbname)
        with registry.cursor() as cr:
            env = api.Environment(cr, SUPERUSER_ID, {})
            ride = env["babana.ride"].browse(ride_id)
            ride._babana_attempt_invoice_email()
            cr.commit()
    except Exception:
        _logger.exception(
            "[L4-06/D57] envoi automatique de la facture : échec inattendu pour la course %s",
            ride_id,
        )


class AccountMove(models.Model):
    _inherit = "account.move"

    # D57 : compte rendu de l'envoi AUTOMATIQUE ou manuel, déposé ICI plutôt que sur
    # babana.ride -- `babana_ride_state.py::write` interdit toute écriture sur une course
    # 'settled' (invariant 2, sans exception), et l'envoi n'a de sens qu'après l'encaissement.
    # `babana.ride.invoice_email_state` (ci-dessus, calculé, jamais stocké) lit ces deux champs
    # à travers `invoice_id` -- aucune écriture sur la course, donc aucun conflit avec
    # l'invariant. `babana_mail_error` porte aussi bien l'échec d'une précondition (pas
    # d'adresse email connue) que le `failure_reason` d'un `mail.mail` réellement tenté et
    # refusé par le relais SMTP -- les deux sont la même chose du point de vue d'un
    # superviseur : "la facture n'est pas partie".
    babana_mail_id = fields.Many2one(
        "mail.mail", string="Email de facture", copy=False,
        help="Dernier envoi TENTÉ (réussi ou non) -- consulter mail.state/failure_reason pour "
        "le détail technique. Vide si aucun envoi n'a jamais été tenté.",
    )
    babana_mail_error = fields.Text(
        string="Échec d'envoi de la facture", copy=False,
        help="Motif du dernier échec -- vide dès qu'un envoi réussit. Distinct de "
        "babana_mail_id.failure_reason : couvre aussi les préconditions manquantes (pas "
        "d'adresse email connue), qui n'atteignent jamais mail.mail.",
    )

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
