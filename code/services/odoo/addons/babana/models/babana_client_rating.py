# Notation du client par son chauffeur (2 novembre, amoa/questions/NOTATION-2026-11-02.md) --
# le miroir de babana.rating (L4-09), avec une différence voulue : le chauffeur peut corriger sa
# note après coup, depuis son historique. Une seule ligne par course, que la correction réécrit.
#
# Ce n'est pas une transition (la course ne change pas d'état, invariant 2), et chaque écriture
# suit un geste du chauffeur (invariant 1). Le commentaire reste au back-office, comme pour L4-09.
from __future__ import annotations

from odoo import _, api, fields, models

from .babana_rating import RatingNotAllowed

# Une course terminée, encaissée ou non : l'écran d'encaissement propose la note, et une
# confirmation encore en file hors connexion ne doit pas la faire refuser.
CLIENT_RATING_STATES = ("completed", "settled")


class BabanaClientRating(models.Model):
    _name = "babana.client.rating"
    _description = "Note du client par son chauffeur"
    _order = "write_date desc, id desc"
    _rec_name = "ride_id"

    ride_id = fields.Many2one("babana.ride", string="Course", required=True, index=True, ondelete="restrict", readonly=True)
    driver_id = fields.Many2one("babana.driver", string="Chauffeur", required=True, index=True, ondelete="restrict", readonly=True)
    client_id = fields.Many2one("res.partner", string="Client", required=True, index=True, ondelete="restrict", readonly=True)
    rating = fields.Integer(string="Note", required=True, readonly=True)
    comment = fields.Text(string="Commentaire", readonly=True)

    _sql_constraints = [
        ("babana_client_rating_ride_unique", "unique(ride_id)", "Cette course a déjà une note du chauffeur."),
        ("babana_client_rating_range", "CHECK(rating >= 1 AND rating <= 5)", "Une note va de 1 à 5."),
    ]

    @api.model
    def _rate_client(self, ride, driver, rating: int, comment: str | None = None):
        """Seul chemin d'écriture : crée la note, ou la réécrit si le chauffeur la corrige."""
        ride = ride.sudo()
        if ride.driver_id != driver:
            raise RatingNotAllowed(_("Seul le chauffeur de la course peut noter son client."))
        if ride.state not in CLIENT_RATING_STATES:
            raise RatingNotAllowed(_("Seule une course terminée se note."))
        # Verrou de la course : deux envois simultanés ne se disputent pas la contrainte unique.
        self.env.cr.execute("SELECT id FROM babana_ride WHERE id = %s FOR UPDATE", (ride.id,))
        text = (comment or "").strip() or False
        existing = self.sudo().search([("ride_id", "=", ride.id)], limit=1)
        if existing:
            existing.write({"rating": rating, "comment": text})
            return existing
        return self.sudo().create(
            {
                "ride_id": ride.id,
                "driver_id": driver.id,
                "client_id": ride.client_id.id,
                "rating": rating,
                "comment": text,
            }
        )

    @api.model
    def _summary(self, average: float, count: int) -> dict:
        """Forme servie aux apps (`rating` de `GET /me`) : la moyenne à une décimale, `None` tant
        que le nombre d'avis reste sous babana.rating_min_count -- « nouveau », jamais zéro
        (L4-09). Partagée par les deux sens."""
        enough = count >= self.env["babana.rating"]._min_count()
        return {"average": round(average, 1) if enough else None, "count": count}

