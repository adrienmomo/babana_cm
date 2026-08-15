# Réponses mises en cache par identifiant d'idempotence (L4-03, critère d'acceptation 6).
# Réseau intermittent oblige (CLAUDE.md, "contexte à ne pas perdre de vue") : l'app mobile
# rejoue un appel dont elle n'a jamais reçu la réponse. Un identifiant fourni par le client
# (en-tête HTTP Idempotency-Key) permet de renvoyer le résultat du premier appel sans
# réappliquer la transition -- indispensable puisque les transitions de babana.ride ne sont
# pas idempotentes par nature (accepter deux fois une course déjà acceptée échoue).
from __future__ import annotations

from odoo import fields, models


class BabanaIdempotencyRecord(models.Model):
    _name = "babana.idempotency.record"
    _description = "Réponse HTTP mise en cache par identifiant d'idempotence (L4-03)"

    idempotency_key = fields.Char(required=True, index=True)
    endpoint = fields.Char(
        required=True,
        index=True,
        help="Chemin de la route (pas seulement la clé) : la même clé sur deux endpoints "
        "différents ne doit jamais partager une réponse.",
    )
    response_status = fields.Integer(required=True)
    response_body = fields.Text(required=True)

    _sql_constraints = [
        (
            "babana_idempotency_key_endpoint_unique",
            "unique(idempotency_key, endpoint)",
            "Une seule réponse mise en cache par identifiant d'idempotence et par endpoint.",
        ),
    ]
