# Arrêts d'une course (L2-08, amoa/questions/MULTISTOP-2026-11-17.md) : paramètres
# d'exploitation, sans montant. Les montants (forfait, attente, bande de distance) vivent sur
# babana.fare.rule, versionnés et gelés avec le devis ; ceux-ci ne décident que du moment où un
# événement d'arrêt se produit, jamais de son prix -- d'où leur place dans Paramètres > Babana.
from __future__ import annotations

MAX_STOPS_PARAM = "babana.max_stops_per_ride"
MAX_STOPS_DEFAULT = 3

# Lus par l'app chauffeur (L6-21) : arrivée automatique dans ce rayon, départ automatique après
# un mouvement de plus de N mètres, à plus de V km/h, pendant D secondes.
ARRIVAL_RADIUS_PARAM = "babana.stop_arrival_radius_m"
ARRIVAL_RADIUS_DEFAULT = 50
DEPARTURE_DISTANCE_PARAM = "babana.stop_departure_distance_m"
DEPARTURE_DISTANCE_DEFAULT = 60
DEPARTURE_SPEED_PARAM = "babana.stop_departure_speed_kmh"
DEPARTURE_SPEED_DEFAULT = 8
DEPARTURE_DURATION_PARAM = "babana.stop_departure_duration_s"
DEPARTURE_DURATION_DEFAULT = 10


def max_stops(env) -> int:
    return int(env["ir.config_parameter"].sudo().get_param(MAX_STOPS_PARAM, MAX_STOPS_DEFAULT))


def detection_config(env) -> dict:
    """Seuils de détection d'arrivée et de départ lus par l'app chauffeur (L6-21)."""
    param = env["ir.config_parameter"].sudo().get_param

    def number(name, default):
        try:
            return float(param(name, default))
        except (TypeError, ValueError):
            return float(default)

    return {
        "arrivalRadiusMeters": number(ARRIVAL_RADIUS_PARAM, ARRIVAL_RADIUS_DEFAULT),
        "departureDistanceMeters": number(DEPARTURE_DISTANCE_PARAM, DEPARTURE_DISTANCE_DEFAULT),
        "departureSpeedKmh": number(DEPARTURE_SPEED_PARAM, DEPARTURE_SPEED_DEFAULT),
        "departureDurationSeconds": number(DEPARTURE_DURATION_PARAM, DEPARTURE_DURATION_DEFAULT),
    }
