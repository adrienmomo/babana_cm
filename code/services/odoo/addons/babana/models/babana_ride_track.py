# Enregistrement du trajet pour la sécurité (L4-16, amoa/specs/L4-course.md ; cadrage
# amoa/questions/MULTISTOP-2026-11-17.md §5). Chaque trajet -- du démarrage à l'arrivée, ou à
# l'annulation en cours de route -- est conservé horodaté, une écriture par course (invariant 1),
# rejouable par les superviseurs sous audit, puis supprimé après la durée de conservation.
#
# Deux sources, une écriture : le service temps réel (sommets horodatés de son accumulation,
# lus à la fin) et, s'il n'a rien, la copie gardée par le téléphone du chauffeur et téléversée
# une fois. Celle du temps réel est toujours préférée. La trace du téléphone sert la sécurité,
# jamais le prix : arrivée après la fin de course, elle ne rouvre pas un montant déjà écrit (J24).
from __future__ import annotations

import html
import json
from datetime import datetime, timedelta

import pytz

from odoo import _, api, fields, models
from odoo.exceptions import AccessError

from .res_users import DEFAULT_ACCOUNT_TZ_FALLBACK, DEFAULT_ACCOUNT_TZ_PARAM

RETENTION_DAYS_PARAM = "babana.ride_track_retention_days"
RETENTION_DAYS_DEFAULT = 365
MAX_SPEED_PARAM = "babana.track_max_speed_mps"
MAX_SPEED_DEFAULT = 38.9  # même plafond que la plausibilité du temps réel (L3-02), 140 km/h
TIME_MARGIN_PARAM = "babana.track_time_margin_seconds"
TIME_MARGIN_DEFAULT = 120
MAX_POINTS_PARAM = "babana.track_max_points"
MAX_POINTS_DEFAULT = 5000

SOURCE_REALTIME = "realtime"
SOURCE_PHONE = "phone"

REPLAY_GROUP = "babana.group_babana_supervisor"
REPLAY_GROUPS = (REPLAY_GROUP, "babana.group_babana_manager", "babana.group_babana_admin")


def _param(env, name, default, cast):
    try:
        return cast(env["ir.config_parameter"].sudo().get_param(name, default))
    except (TypeError, ValueError):
        return default


def _parse_utc(value):
    if not value:
        return None
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(pytz.UTC).replace(tzinfo=None)
    return parsed


def _haversine_m(a, b):
    from math import asin, cos, radians, sin, sqrt

    lat1, lng1, lat2, lng2 = map(radians, (a[0], a[1], b[0], b[1]))
    h = sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin((lng2 - lng1) / 2) ** 2
    return 2 * 6_371_000 * asin(sqrt(h))


def filter_phone_points(points, *, window_start, window_end, max_speed_mps, max_points):
    """Trace venue d'un appareil qu'on ne contrôle pas : ne garde que des points horodatés, dans
    la fenêtre de la course, en ordre chronologique, sans saut impossible (vitesse implicite au
    plafond de la plausibilité, L3-02). Pure -- testée seule. Renvoie la liste retenue."""
    timed = []
    for point in points:
        try:
            when = _parse_utc(point.get("capturedAt"))
            lat = float(point["latitude"])
            lng = float(point["longitude"])
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
        if when is None or not (-90 <= lat <= 90 and -180 <= lng <= 180):
            continue
        if not (window_start <= when <= window_end):
            continue
        accuracy = point.get("accuracyMeters")
        timed.append((when, lat, lng, float(accuracy) if isinstance(accuracy, (int, float)) else None))
    timed.sort(key=lambda item: item[0])
    kept = []
    for when, lat, lng, accuracy in timed:
        if kept:
            previous = kept[-1]
            seconds = (when - previous[0]).total_seconds()
            if seconds <= 0:
                continue
            if _haversine_m((previous[1], previous[2]), (lat, lng)) / seconds > max_speed_mps:
                continue
        kept.append((when, lat, lng, accuracy))
        if len(kept) >= max_points:
            break
    return kept


class BabanaRideTrack(models.Model):
    _name = "babana.ride.track"
    _description = "Trajet enregistré pour la sécurité (L4-16)"
    _order = "id desc"

    ride_id = fields.Many2one("babana.ride", required=True, index=True, ondelete="cascade")
    source = fields.Selection(
        [(SOURCE_REALTIME, "Service temps réel"), (SOURCE_PHONE, "Téléphone du chauffeur")],
        string="Source",
        required=True,
    )
    points_json = fields.Text(
        string="Points",
        required=True,
        help="[{latitude, longitude, t (ISO UTC ou null), accuracy}] dans l'ordre du trajet.",
    )
    point_count = fields.Integer(string="Points enregistrés")
    first_point_at = fields.Datetime(string="Premier point")
    last_point_at = fields.Datetime(string="Dernier point")

    _sql_constraints = [
        (
            "babana_ride_track_one_per_ride",
            "unique(ride_id)",
            "Un seul trajet enregistré par course : une écriture par course (invariant 1).",
        ),
    ]

    def _points(self):
        self.ensure_one()
        return json.loads(self.points_json or "[]")

    @api.model
    def _babana_retention_days(self):
        return max(1, _param(self.env, RETENTION_DAYS_PARAM, RETENTION_DAYS_DEFAULT, int))

    @api.model
    def _cron_purge_expired_tracks(self, now=None):
        """Conservation (L4-16) : un trajet terminé ou annulé depuis plus de
        `babana.ride_track_retention_days` jours est supprimé -- sauf si la course porte un
        incident non clôturé, gardé jusqu'à sa clôture. La course, son prix détaillé et ses
        horodatages restent ; seule la trace part."""
        now = now or fields.Datetime.now()
        limit = now - timedelta(days=self._babana_retention_days())
        expired = self.sudo().search(
            [
                "|",
                ("ride_id.completed_at", "<", limit),
                "&",
                ("ride_id.completed_at", "=", False),
                ("ride_id.cancelled_at", "<", limit),
            ]
        )
        expired = expired.filtered(
            lambda track: not track.ride_id.incident_ids.filtered(lambda i: i.status != "closed")
        )
        count = len(expired)
        expired.unlink()
        return count


class BabanaRide(models.Model):
    _inherit = "babana.ride"

    has_security_track = fields.Boolean(
        string="Trajet enregistré", compute="_compute_has_security_track"
    )

    def _compute_has_security_track(self):
        tracks = self.env["babana.ride.track"].sudo().search([("ride_id", "in", self.ids)])
        with_track = set(tracks.mapped("ride_id").ids)
        for ride in self:
            ride.has_security_track = ride.id in with_track

    def _babana_track(self):
        self.ensure_one()
        return self.env["babana.ride.track"].sudo().search([("ride_id", "=", self.id)], limit=1)

    def _babana_store_realtime_track(self, measurement):
        """Trace du service temps réel, lue à la fin ou à l'annulation en cours de route. Une
        écriture ; rien si la mesure n'a pas de sommet."""
        self.ensure_one()
        points = (measurement or {}).get("points") or []
        if not points or self._babana_track():
            return False
        rows = []
        for point in points:
            rows.append({
                "latitude": point["latitude"],
                "longitude": point["longitude"],
                "t": point.get("capturedAt"),
                "accuracy": point.get("accuracyMeters"),
            })
        return self._babana_create_track(rows, SOURCE_REALTIME)

    def _babana_store_phone_track(self, points):
        """Copie du téléphone (L4-16), téléversée une fois après la fin : retenue seulement si
        le temps réel n'a rien laissé. Rejeu : renvoie la trace existante, n'écrit rien."""
        self.ensure_one()
        existing = self._babana_track()
        if existing:
            return existing
        start = self.started_at
        end = self.completed_at or self.cancelled_at
        if not start or not end:
            return False
        margin = timedelta(seconds=_param(self.env, TIME_MARGIN_PARAM, TIME_MARGIN_DEFAULT, int))
        kept = filter_phone_points(
            points,
            window_start=start - margin,
            window_end=end + margin,
            max_speed_mps=_param(self.env, MAX_SPEED_PARAM, MAX_SPEED_DEFAULT, float),
            max_points=_param(self.env, MAX_POINTS_PARAM, MAX_POINTS_DEFAULT, int),
        )
        if not kept:
            return False
        rows = [
            {"latitude": lat, "longitude": lng, "t": when.isoformat() + "Z", "accuracy": accuracy}
            for when, lat, lng, accuracy in kept
        ]
        return self._babana_create_track(rows, SOURCE_PHONE)

    def _babana_create_track(self, rows, source):
        times = [_parse_utc(row["t"]) for row in rows if row.get("t")]
        track = self.env["babana.ride.track"].sudo().create({
            "ride_id": self.id,
            "source": source,
            "points_json": json.dumps(rows),
            "point_count": len(rows),
            "first_point_at": min(times) if times else False,
            "last_point_at": max(times) if times else False,
        })
        self._babana_journalize("track_recorded", source=source, points=len(rows))
        return track

    def _babana_security_notice(self):
        """Avis montré au client à chaque démarrage (L4-16) -- traduisible, jamais dans l'app."""
        return _("Votre trajet est enregistré pour votre sécurité.")

    def action_open_track_replay(self):
        """« Rejouer le trajet » (L4-16) : réservé aux superviseurs et au-dessus, chaque ouverture
        journalisée. Le trajet n'a pas d'autre porte d'entrée au back-office."""
        self.ensure_one()
        user = self.env.user
        if not any(user.has_group(group) for group in REPLAY_GROUPS):
            raise AccessError(_("Seuls les superviseurs peuvent rejouer un trajet."))
        if not self._babana_track():
            raise AccessError(_("Aucun trajet enregistré pour cette course."))
        wizard = self.env["babana.ride.track.replay"].create({"ride_id": self.id})
        self.env["babana.audit.log"]._babana_record(
            event="ride.track_viewed",
            model_name="babana.ride",
            res_id=self.id,
            record_reference=self.reference,
            actor=user,
        )
        return {
            "type": "ir.actions.act_window",
            "name": _("Trajet de %s", self.reference),
            "res_model": "babana.ride.track.replay",
            "res_id": wizard.id,
            "view_mode": "form",
            "target": "new",
        }


class BabanaRideTrackReplay(models.TransientModel):
    """Lecture d'un trajet (option A, décision du 17 novembre) : le tracé dessiné en SVG, sans
    fond de carte ni bibliothèque, et la table des points horodatés avec les événements de la
    course. Créé seulement par `action_open_track_replay`, qui journalise."""

    _name = "babana.ride.track.replay"
    _description = "Lecture d'un trajet enregistré (L4-16)"

    ride_id = fields.Many2one("babana.ride", string="Course", required=True, readonly=True, ondelete="cascade")
    source = fields.Char(string="Source", compute="_compute_replay", readonly=True)
    replay_html = fields.Html(
        string="Trajet", compute="_compute_replay", sanitize=False, readonly=True
    )

    def _compute_replay(self):
        for wizard in self:
            track = wizard.ride_id.sudo()._babana_track()
            if not track:
                wizard.source = False
                wizard.replay_html = False
                continue
            wizard.source = dict(track._fields["source"].selection).get(track.source)
            wizard.replay_html = _render_replay(wizard.env, wizard.ride_id.sudo(), track._points())


def _local(env, value):
    if not value:
        return "—"
    tz_name = env["ir.config_parameter"].sudo().get_param(
        DEFAULT_ACCOUNT_TZ_PARAM, DEFAULT_ACCOUNT_TZ_FALLBACK
    )
    try:
        tz = pytz.timezone(tz_name)
    except pytz.UnknownTimeZoneError:
        tz = pytz.UTC
    return pytz.UTC.localize(value).astimezone(tz).strftime("%d/%m/%Y %H:%M:%S")


def _render_replay(env, ride, points):
    width, height, pad = 640, 420, 24
    stops = ride.stop_ids.sorted("sequence")
    coords = [(p["latitude"], p["longitude"]) for p in points]
    coords += [(s.latitude, s.longitude) for s in stops]
    lats = [c[0] for c in coords] or [0.0]
    lngs = [c[1] for c in coords] or [0.0]
    lat_min, lat_max, lng_min, lng_max = min(lats), max(lats), min(lngs), max(lngs)
    span = max(lat_max - lat_min, lng_max - lng_min, 1e-6)

    def xy(lat, lng):
        x = pad + (lng - lng_min) / span * (width - 2 * pad)
        y = height - pad - (lat - lat_min) / span * (height - 2 * pad)
        return f"{x:.1f},{y:.1f}"

    path = " ".join(xy(p["latitude"], p["longitude"]) for p in points)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'style="max-width:{width}px;width:100%;border:1px solid #ccc;border-radius:6px;background:#f8f9fa">',
        f'<polyline points="{path}" fill="none" stroke="#1d7f4e" stroke-width="3" '
        'stroke-linejoin="round" stroke-linecap="round"/>',
    ]
    if points:
        start, end = points[0], points[-1]
        sx, sy = xy(start["latitude"], start["longitude"]).split(",")
        ex, ey = xy(end["latitude"], end["longitude"]).split(",")
        parts.append(f'<circle cx="{sx}" cy="{sy}" r="7" fill="#22b573"><title>Départ</title></circle>')
        parts.append(f'<circle cx="{ex}" cy="{ey}" r="7" fill="#d9534f"><title>Arrivée</title></circle>')
    for stop in stops:
        cx, cy = xy(stop.latitude, stop.longitude).split(",")
        label = html.escape(stop.label or _("Arrêt %s", stop.sequence))
        parts.append(f'<circle cx="{cx}" cy="{cy}" r="6" fill="#f0ad4e"><title>{label}</title></circle>')
    parts.append("</svg>")
    parts.append(
        '<p class="text-muted small">Vert : départ · rouge : arrivée · orange : arrêts. '
        "Tracé sans fond de carte.</p>"
    )

    events = [
        (ride.arrived_at, _("Chauffeur sur place")),
        (ride.pickup_departed_at, _("Départ de la prise en charge")),
        (ride.started_at, _("Démarrage de la course")),
        (ride.completed_at, _("Fin de course")),
        (ride.cancelled_at, _("Annulation")),
    ]
    for stop in stops:
        name = stop.label or _("Arrêt %s", stop.sequence)
        events.append((stop.arrived_at, _("Arrivée — %s", name)))
        events.append((stop.departed_at, _("Départ — %s", name)))
    rows = [(when, label) for when, label in events if when]
    rows.sort(key=lambda item: item[0])
    parts.append("<h5>Événements</h5><table class='table table-sm'><tbody>")
    for when, label in rows:
        parts.append(f"<tr><td>{_local(env, when)}</td><td>{html.escape(label)}</td></tr>")
    parts.append("</tbody></table>")

    parts.append(
        f"<h5>Points horodatés ({len(points)})</h5><table class='table table-sm'>"
        "<thead><tr><th>Heure</th><th>Latitude</th><th>Longitude</th><th>Précision (m)</th></tr></thead><tbody>"
    )
    for point in points:
        when = _parse_utc(point.get("t"))
        accuracy = point.get("accuracy")
        parts.append(
            f"<tr><td>{_local(env, when)}</td><td>{point['latitude']:.6f}</td>"
            f"<td>{point['longitude']:.6f}</td><td>{'' if accuracy is None else round(accuracy)}</td></tr>"
        )
    parts.append("</tbody></table>")
    return "".join(parts)
