# Notation d'une course par son client (L4-09, CDC §II.5). Une note de 1 à 5 et un commentaire
# facultatif, posés une fois sur une course encaissée. Ce n'est pas une transition (la course
# reste `settled`, invariant 2) : un enregistrement à part, une écriture par décision humaine
# (invariant 1).
#
# Le commentaire ne quitte jamais le back-office en v1 (modération non prévue, critère 5) : le
# modèle n'a aucun droit d'accès pour les utilisateurs mobiles (tests/fixtures/access_matrix.json)
# et la réponse de POST /rides/{id}/rate ne le renvoie pas.
from __future__ import annotations

from odoo import _, api, fields, models
from odoo.exceptions import UserError

# En dessous de ce nombre d'avis, la moyenne n'est pas significative : le chauffeur est présenté
# comme « nouveau » plutôt que noté (spécification L4-09, D10).
RATING_MIN_COUNT_PARAM = "babana.rating_min_count"
RATING_MIN_COUNT_DEFAULT = 3


class RatingNotAllowed(UserError):
    """Course pas encore encaissée : pas de note (RATING_NOT_ALLOWED)."""


class RatingAlreadySubmitted(UserError):
    """Une seule note par course (RATING_ALREADY_SUBMITTED)."""


class BabanaRating(models.Model):
    _name = "babana.rating"
    _description = "Note d'une course par son client (L4-09)"
    _order = "create_date desc, id desc"
    _rec_name = "ride_id"

    ride_id = fields.Many2one("babana.ride", string="Course", required=True, index=True, ondelete="restrict", readonly=True)
    driver_id = fields.Many2one("babana.driver", string="Chauffeur", required=True, index=True, ondelete="restrict", readonly=True)
    client_id = fields.Many2one("res.partner", string="Client", required=True, ondelete="restrict", readonly=True)
    rating = fields.Integer(string="Note", required=True, readonly=True)
    comment = fields.Text(string="Commentaire", readonly=True)

    _sql_constraints = [
        ("babana_rating_ride_unique", "unique(ride_id)", "Cette course a déjà été notée."),
        ("babana_rating_range", "CHECK(rating >= 1 AND rating <= 5)", "Une note va de 1 à 5."),
    ]

    @api.model
    def _min_count(self) -> int:
        raw = self.env["ir.config_parameter"].sudo().get_param(RATING_MIN_COUNT_PARAM)
        try:
            value = int(raw)
        except (TypeError, ValueError):
            return RATING_MIN_COUNT_DEFAULT
        return value if value > 0 else RATING_MIN_COUNT_DEFAULT

    @api.model
    def _rate_ride(self, ride, client, rating: int, comment: str | None = None):
        """Seul chemin d'écriture. `ride` et `client` sont déjà établis par l'appelant (la
        course est vue au nom du client, D54) ; les conditions métier vivent ici, pas dans le
        contrôleur, pour valoir aussi depuis le back-office."""
        ride = ride.sudo()
        if ride.client_id != client:
            raise RatingNotAllowed(_("Seul le client de la course peut la noter."))
        if ride.state != "settled":
            raise RatingNotAllowed(_("Une course ne peut être notée qu'une fois encaissée."))
        # Verrou de la ligne de course : deux envois simultanés de la même note ne doivent pas
        # se disputer la contrainte unique en renvoyant une erreur interne à l'un d'eux.
        self.env.cr.execute("SELECT id FROM babana_ride WHERE id = %s FOR UPDATE", (ride.id,))
        if self.sudo().search_count([("ride_id", "=", ride.id)]):
            raise RatingAlreadySubmitted(_("Cette course a déjà été notée."))
        text = (comment or "").strip() or False
        return self.sudo().create(
            {
                "ride_id": ride.id,
                "driver_id": ride.driver_id.id,
                "client_id": client.id,
                "rating": rating,
                "comment": text,
            }
        )
