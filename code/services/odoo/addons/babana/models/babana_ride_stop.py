# Arrêts d'une course (L4-14, amoa/specs/L4-course.md ; cadrage
# amoa/questions/MULTISTOP-2026-11-17.md). Un arrêt prévu vient du devis ou d'un ajout confirmé
# par le client en cours de course ; un arrêt imprévu naît du bouton « Arrêt client » du
# chauffeur. Arrivée et départ sont des événements du chauffeur, une écriture chacun -- jamais
# un compteur d'attente (invariant 1) : l'attente se calcule à la fin, depuis ces horodatages
# (L4-15).
#
# Ce ne sont pas des transitions : la course reste `in_progress` (C-03 inchangée). Mais ces
# écritures passent par les méthodes ci-dessous, sous le verrou de la course, jamais par un
# write direct depuis un contrôleur -- la même discipline que l'invariant 2.
from __future__ import annotations

import dataclasses
import json
import uuid
from datetime import datetime, timedelta

from odoo import fields, models

from ..services import push, realtime_client, routing, stops as stops_service
from ..services.pricing import FareBreakdown, compute_fare, round_breakdown_for_wire
from .babana_quote import QUOTE_VALIDITY_DEFAULT, QUOTE_VALIDITY_PARAM
from .babana_ride_state import RideInvalidTransition


class StopNotFound(RideInvalidTransition):
    """Arrêt inconnu de cette course -- traduit en STOP_NOT_FOUND (C-01)."""


class TooManyStops(RideInvalidTransition):
    """Ajout au-delà de babana.max_stops_per_ride -- traduit en TOO_MANY_STOPS (C-01)."""


class StopQuoteExpired(RideInvalidTransition):
    """Cotation d'arrêt expirée, ou devenue fausse parce qu'un autre ajout a été confirmé
    entre-temps -- traduit en QUOTE_EXPIRED (C-01) : en redemander une."""


class BabanaRideStop(models.Model):
    _name = "babana.ride.stop"
    _description = "Arrêt d'une course (L4-14)"
    _order = "ride_id, sequence, id"

    ride_id = fields.Many2one("babana.ride", required=True, index=True, ondelete="cascade")
    public_id = fields.Char(
        string="Identifiant public",
        index=True,
        copy=False,
        default=lambda self: str(uuid.uuid4()),
        help="stopId de l'API mobile (C-01) -- jamais l'identifiant Odoo interne.",
    )
    sequence = fields.Integer(string="Ordre", required=True, default=0)
    latitude = fields.Float(string="Latitude", required=True, digits=(10, 6))
    longitude = fields.Float(string="Longitude", required=True, digits=(10, 6))
    label = fields.Char(string="Repère")
    kind = fields.Selection(
        [("planned", "Prévu"), ("unplanned", "Imprévu (« Arrêt client »)")],
        string="Type",
        required=True,
        default="planned",
    )
    added_during_ride = fields.Boolean(
        string="Ajouté en cours de course",
        help="Arrêt prévu demandé par le client après le démarrage, prix confirmé par lui.",
    )
    added_quote_id = fields.Many2one(
        "babana.quote",
        string="Cotation confirmée",
        ondelete="restrict",
        help="La cotation que le client a acceptée en ajoutant cet arrêt -- conservée pour "
        "rejouer le prix et trancher une contestation.",
    )
    # Heure officielle (bornée par le serveur) et heure brute du téléphone, pour l'audit. Le
    # prix final ne lit que l'heure officielle : l'heure de réception qui a servi à la borner
    # n'est conservée nulle part, seul le résultat du bornage est rejouable.
    arrived_at = fields.Datetime(string="Arrivée", readonly=True, copy=False)
    arrived_at_device = fields.Datetime(string="Arrivée (téléphone)", readonly=True, copy=False)
    departed_at = fields.Datetime(string="Départ", readonly=True, copy=False)
    departed_at_device = fields.Datetime(string="Départ (téléphone)", readonly=True, copy=False)

    _sql_constraints = [
        (
            "babana_ride_stop_public_id_unique",
            "unique(public_id)",
            "Collision d'identifiant public d'arrêt -- ne devrait jamais se produire (UUID).",
        ),
        (
            "babana_ride_stop_departure_after_arrival",
            "check(departed_at is null or (arrived_at is not null and departed_at >= arrived_at))",
            "Un arrêt ne peut être quitté qu'après y être arrivé.",
        ),
    ]

    def _wire(self) -> dict:
        self.ensure_one()
        return {
            "id": self.public_id,
            "sequence": self.sequence,
            "position": {"latitude": self.latitude, "longitude": self.longitude},
            "label": self.label or None,
            "kind": self.kind,
            "addedDuringRide": self.added_during_ride,
        }


def clamp_event_time(occurred_at: datetime | None, *, lower: datetime | None, received_at: datetime) -> datetime:
    """Heure officielle d'un événement d'arrêt (L4-14, MULTISTOP §3.3) : l'heure du téléphone,
    ramenée dans [événement précédent du même point, réception]. Absente, l'heure de réception.
    Pure -- testée seule."""
    value = occurred_at or received_at
    if value > received_at:
        value = received_at
    if lower is not None and value < lower:
        value = lower
    return value


class BabanaRide(models.Model):
    _inherit = "babana.ride"

    stop_ids = fields.One2many("babana.ride.stop", "ride_id", string="Arrêts")
    stop_wait_snapshot = fields.Text(
        help="Forfait par arrêt, attente, bande de distance (JSON), copiés du devis à la "
        "création (L2-08) -- ce que le prix final (L4-15) relira, jamais la grille du jour.",
    )
    pickup_departed_at = fields.Datetime(
        string="Départ de la prise en charge",
        readonly=True,
        copy=False,
        help="Premier mouvement détecté après « Sur place », avant le démarrage. L'attente à la "
        "prise en charge s'arrête à cette heure ou au démarrage, la plus tôt des deux.",
    )
    pickup_departed_at_device = fields.Datetime(readonly=True, copy=False)
    stop_quote_ids = fields.One2many(
        "babana.quote", "ride_id", string="Cotations en cours de course",
        domain=[("confirmed_at", "!=", False)],
    )

    # --- Garde commune ---------------------------------------------------------------------------

    def _babana_check_driver_event(self, by_driver, *, states):
        self.ensure_one()
        self._lock_for_update()
        if self.state not in states:
            raise RideInvalidTransition(f"Événement d'arrêt impossible depuis l'état '{self.state}'.")
        if by_driver != self.driver_id:
            raise RideInvalidTransition("Ce chauffeur n'est pas celui affecté à cette course.")

    def _babana_find_stop(self, stop_public_id):
        stop = self.stop_ids.filtered(lambda s: s.public_id == stop_public_id)
        if not stop:
            raise StopNotFound("Arrêt inconnu pour cette course.")
        return stop

    def _babana_open_stop(self):
        return self.stop_ids.filtered(lambda s: s.arrived_at and not s.departed_at)

    # --- Événements du chauffeur -----------------------------------------------------------------

    def action_stop_arrived(self, *, by_driver, stop_public_id, occurred_at=None):
        """Arrivée à un arrêt prévu (auto dans le rayon, ou bouton « Arrivé »). Une écriture ;
        un rejeu sur un arrêt déjà atteint ne déplace rien."""
        self._babana_check_driver_event(by_driver, states=("in_progress",))
        stop = self._babana_find_stop(stop_public_id)
        if stop.kind != "planned":
            raise RideInvalidTransition("Un arrêt imprévu est créé déjà atteint.")
        if stop.arrived_at:
            return stop
        if self._babana_open_stop():
            raise RideInvalidTransition("Un autre arrêt est en cours : déclarer d'abord le départ.")
        now = fields.Datetime.now()
        stop.write({
            "arrived_at": clamp_event_time(occurred_at, lower=self._babana_last_event_time(), received_at=now),
            "arrived_at_device": occurred_at,
        })
        self._babana_journalize("stop_arrived", stop=stop.public_id)
        return stop

    def action_stop_unplanned(self, *, by_driver, latitude, longitude, occurred_at=None):
        """« Arrêt client » sur une course sans arrêt prévu à cet endroit : crée l'arrêt, déjà
        atteint. Une décision du chauffeur, une écriture -- l'attente qu'il ouvre se ferme au
        départ, automatique ou par « Repartir »."""
        self._babana_check_driver_event(by_driver, states=("in_progress",))
        if self._babana_open_stop():
            raise RideInvalidTransition("Un autre arrêt est en cours : déclarer d'abord le départ.")
        now = fields.Datetime.now()
        stop = self.env["babana.ride.stop"].create({
            "ride_id": self.id,
            "sequence": self._babana_next_stop_sequence(),
            "latitude": latitude,
            "longitude": longitude,
            "kind": "unplanned",
            "arrived_at": clamp_event_time(occurred_at, lower=self._babana_last_event_time(), received_at=now),
            "arrived_at_device": occurred_at,
        })
        self._babana_journalize("stop_unplanned", stop=stop.public_id)
        return stop

    def action_stop_departed(self, *, by_driver, stop_public_id=None, occurred_at=None):
        """Départ (mouvement détecté, ou « Repartir »). `stop_public_id` absent = départ de la
        prise en charge, avant le démarrage. Un rejeu ne déplace rien."""
        if stop_public_id is None:
            return self._babana_pickup_departed(by_driver=by_driver, occurred_at=occurred_at)
        self._babana_check_driver_event(by_driver, states=("in_progress",))
        stop = self._babana_find_stop(stop_public_id)
        if stop.departed_at:
            return stop
        if not stop.arrived_at:
            raise RideInvalidTransition("Départ d'un arrêt jamais atteint.")
        now = fields.Datetime.now()
        stop.write({
            "departed_at": clamp_event_time(occurred_at, lower=stop.arrived_at, received_at=now),
            "departed_at_device": occurred_at,
        })
        self._babana_journalize("stop_departed", stop=stop.public_id)
        return stop

    def _babana_pickup_departed(self, *, by_driver, occurred_at):
        self._babana_check_driver_event(by_driver, states=("assigned",))
        if not self.arrived_at:
            raise RideInvalidTransition("Départ de la prise en charge sans « Sur place » préalable.")
        if self.pickup_departed_at:
            return self
        now = fields.Datetime.now()
        self.write({
            "pickup_departed_at": clamp_event_time(occurred_at, lower=self.arrived_at, received_at=now),
            "pickup_departed_at_device": occurred_at,
        })
        self._babana_journalize("pickup_departed")
        return self

    def _babana_last_event_time(self):
        """Borne basse d'une arrivée : le dernier départ d'arrêt connu, sinon le démarrage."""
        candidates = [self.started_at, *self.stop_ids.mapped("departed_at")]
        candidates = [value for value in candidates if value]
        return max(candidates) if candidates else None

    def _babana_next_stop_sequence(self):
        return max(self.stop_ids.mapped("sequence") or [0]) + 1

    # --- Ajout d'un arrêt par le client, en deux temps -------------------------------------------

    def _babana_planned_stops(self):
        return self.stop_ids.filtered(lambda s: s.kind == "planned").sorted("sequence")

    def action_quote_added_stop(self, *, by_partner, latitude, longitude, label=None):
        """Temps 1 : cotation de l'itinéraire prévu complet (prise en charge -> arrêts prévus ->
        arrêt ajouté -> arrivée), avec la règle tarifaire de la course -- immuable puisqu'elle
        sert déjà cette course (L2-01, critère 4) -- et la distance d'approche gelée à la
        création. Rien n'est écrit sur la course : seule une estimation (babana.quote) est créée,
        liée à la course, que le temps 2 confirmera ou non.

        Itinéraire complet plutôt que « restant depuis la position actuelle » : la bande de
        distance du prix final (L4-15) compare la distance PARCOURUE de bout en bout à cette
        distance prévue -- les deux doivent couvrir le même trajet."""
        self.ensure_one()
        if self.state != "in_progress":
            raise RideInvalidTransition(f"Ajout d'arrêt impossible depuis l'état '{self.state}'.")
        if by_partner != self.client_id:
            raise RideInvalidTransition("Seul le client de la course peut ajouter un arrêt.")
        planned = self._babana_planned_stops()
        limit = stops_service.max_stops(self.env)
        if len(planned) + 1 > limit:
            raise TooManyStops(f"Au plus {limit} arrêt(s) par course.")

        new_stop = (latitude, longitude)
        points = [
            (self.pickup_latitude, self.pickup_longitude),
            *[(s.latitude, s.longitude) for s in planned],
            new_stop,
            (self.dropoff_latitude, self.dropoff_longitude),
        ]
        rule = self.fare_rule_id.sudo()
        if not rule:
            raise RideInvalidTransition("Course sans règle tarifaire : ajout d'arrêt impossible.")
        now = fields.Datetime.now()
        vehicle_class = self.quote_id.vehicle_class or "standard"
        route = routing.get_reference_route_through(
            self.env, points=points, vehicle_class=vehicle_class, at_datetime=now
        )
        approach_m = self.quote_id.approach_distance_meters or 0
        breakdown = compute_fare(
            rule._pricing_input(),
            route.distance_meters,
            rounding_step=rule._default_rounding_step(),
            approach_distance_m=approach_m,
            stop_count=len(planned) + 1,
        )
        validity = int(
            self.env["ir.config_parameter"].sudo().get_param(QUOTE_VALIDITY_PARAM, QUOTE_VALIDITY_DEFAULT)
        )
        stops_payload = [
            {"latitude": s.latitude, "longitude": s.longitude, "label": s.label or None} for s in planned
        ] + [{"latitude": latitude, "longitude": longitude, "label": label or None}]
        return self.env["babana.quote"].sudo().create({
            "client_id": self.client_id.id,
            "ride_id": self.id,
            "pickup_latitude": self.pickup_latitude,
            "pickup_longitude": self.pickup_longitude,
            "dropoff_latitude": self.dropoff_latitude,
            "dropoff_longitude": self.dropoff_longitude,
            "pickup_zone_id": self._babana_zone_for(self.pickup_zone_id, self.pickup_latitude, self.pickup_longitude),
            "dropoff_zone_id": self._babana_zone_for(self.dropoff_zone_id, self.dropoff_latitude, self.dropoff_longitude),
            "vehicle_class": vehicle_class,
            "stops_json": json.dumps(stops_payload),
            "stop_count": len(stops_payload),
            "stop_wait_snapshot": self.stop_wait_snapshot,
            "distance_meters": route.distance_meters,
            "duration_seconds": route.duration_seconds,
            "approach_distance_meters": approach_m,
            "approach_driver_count": self.quote_id.approach_driver_count,
            "eta_seconds": route.duration_seconds,
            "fare_rule_id": rule.id,
            "fare_rule_snapshot": json.dumps(dataclasses.asdict(breakdown)),
            "amount": breakdown.total,
            "discount_amount": breakdown.discount_amount,
            "expires_at": now + timedelta(seconds=validity),
        })

    def _babana_zone_for(self, zone, latitude, longitude):
        """Zone déjà résolue à la cotation initiale ; sinon résolue depuis le point (même
        méthode que controllers/quote.py) -- une estimation a toujours ses zones."""
        if zone:
            return zone.id
        return self.env["babana.zone"].sudo().resolve_point(latitude=latitude, longitude=longitude).id

    def action_confirm_added_stop(self, *, by_partner, quote):
        """Temps 2 : le client accepte le nouveau prix. Une écriture sur la course (prix,
        distance et détail prévus), un arrêt créé, la cotation marquée confirmée et conservée.
        Le chauffeur est prévenu au commit (D32), par le temps réel et par push ; il ne peut pas
        refuser (MULTISTOP §2, réponse 8)."""
        self.ensure_one()
        self._lock_for_update()
        if self.state != "in_progress":
            raise RideInvalidTransition(f"Ajout d'arrêt impossible depuis l'état '{self.state}'.")
        if by_partner != self.client_id:
            raise RideInvalidTransition("Seul le client de la course peut ajouter un arrêt.")
        quote = quote.sudo()
        if quote.ride_id != self:
            raise StopNotFound("Cotation inconnue pour cette course.")
        if quote.confirmed_at:
            # Rejeu : déjà confirmée, rien à réécrire.
            return self.stop_ids.filtered(lambda s: s.added_quote_id == quote)
        if quote.is_expired():
            raise StopQuoteExpired("La cotation a expiré ; en redemander une.")
        planned = self._babana_planned_stops()
        quoted_stops = json.loads(quote.stops_json or "[]")
        # La cotation a été faite sur la liste d'arrêts d'alors ; si un autre ajout a été
        # confirmé entre-temps, elle ne décrit plus l'itinéraire -- en redemander une.
        if len(quoted_stops) != len(planned) + 1:
            raise StopQuoteExpired("La cotation a expiré ; en redemander une.")
        limit = stops_service.max_stops(self.env)
        if len(quoted_stops) > limit:
            raise TooManyStops(f"Au plus {limit} arrêt(s) par course.")

        added = quoted_stops[-1]
        now = fields.Datetime.now()
        stop = self.env["babana.ride.stop"].create({
            "ride_id": self.id,
            "sequence": self._babana_next_stop_sequence(),
            "latitude": added["latitude"],
            "longitude": added["longitude"],
            "label": added.get("label") or False,
            "kind": "planned",
            "added_during_ride": True,
            "added_quote_id": quote.id,
        })
        quote.write({"confirmed_at": now})
        self.write({
            "estimated_amount": quote.amount,
            "reference_distance_km": quote.distance_meters / 1000.0,
            "fare_rule_snapshot": quote.fare_rule_snapshot,
        })
        self._babana_journalize("stop_added", stop=stop.public_id, amount=quote.amount)
        realtime_client.notify_stop_added(
            self.env,
            ride_public_id=self.public_id,
            driver_public_id=self.driver_id.public_id,
            stops=[s._wire() for s in self._babana_planned_stops()],
        )
        self._babana_push_driver(
            "Arrêt ajouté",
            "Le client a ajouté un arrêt. L'itinéraire est mis à jour.",
            "stop_added",
        )
        return stop

    def _babana_push_driver(self, title, body, kind):
        """Push au chauffeur affecté (même patron que `_babana_push_client`) : au commit, sur un
        fil de fond, contenu minimal."""
        users = self.driver_id.user_id
        if not users:
            return
        push.notify_users_async(
            self.env,
            users,
            push.PushMessage(
                title=title,
                body=body,
                data={"type": "ride", "rideId": self.public_id, "event": kind},
                collapse_key="babana-ride-%s" % self.public_id,
            ),
        )

    def _babana_stop_breakdown_wire(self):
        self.ensure_one()
        if not self.fare_rule_snapshot:
            return None
        return round_breakdown_for_wire(FareBreakdown(**json.loads(self.fare_rule_snapshot)))
