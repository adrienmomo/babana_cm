# -*- coding: utf-8 -*-
"""Jeu de données de démonstration babana (`make seed`).

Lancé par le `Makefile` dans un `odoo shell` (`env` est le seul global fourni). But : qu'une
base **fraîche** (`make reset && make up && make seed`) soit montrable sans rien créer à la main
-- des zones réelles de Douala avec leur grille tarifaire, une petite flotte de chauffeurs
approuvés, un client, un superviseur, et un historique de courses terminées (D21 :
valeurs plausibles, jamais aléatoires ; `test_driver_3` coûte plus cher que le temps qu'il fait
gagner).

**Rejouable** : chaque objet est gardé par une clé naturelle (`google_sub`, immatriculation,
nom de zone...). Deux exécutions consécutives ne produisent pas deux flottes -- la seconde ne
fait que vérifier que tout est en place.

**Ce que ce script NE fait PAS**, et ne peut pas faire : peupler le pool géo-indexé du service
temps réel (les positions « tenues à jour en direct » de l'étape 1 du scénario de
`amoa/07-demonstration.md`). Le pool n'a qu'un seul écrivain -- le script Lua d'éligibilité
(D26) -- alimenté par des `position.update` reçus sur une connexion WebSocket chauffeur
authentifiée. Aucun jeu de données Odoo ne peut y écrire. Le compagnon `make seed-drivers`
(`services/realtime/scripts/demo-drivers.mjs`) ouvre une connexion par chauffeur semé et les
tient en ligne à des positions dispersées, par le vrai chemin (`/auth/google` -> WS ->
`availability.set` + `position.update`). Voir `amoa/questions/L0-06.md`.

Contrat partagé avec `demo-drivers.mjs` : les `google_sub` des chauffeurs de démonstration sont
`babana-demo-driver-1` .. `babana-demo-driver-<N>` (N ci-dessous). C'est la seule chose que les
deux fichiers doivent garder d'accord.
"""

import json
import logging
import math
import os
import sys
from datetime import datetime, timedelta

_log = logging.getLogger("babana.seed")
_log.setLevel(logging.INFO)
if not _log.handlers:
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(logging.Formatter("seed | %(message)s"))
    _log.addHandler(_h)


def info(msg, *a):
    _log.info(msg, *a)


# --------------------------------------------------------------------------------------------
# Données -- quartiers réels de Douala (repris de services/mocks/maps/fixtures/douala.json,
# pas réinventés) et flotte plausible.
# --------------------------------------------------------------------------------------------

# Zones : un rectangle serré (~800 m) autour du centroïde du quartier, priorité 10 pour passer
# devant le rectangle englobant par défaut (data/babana_zone_default.xml, priorité 0, conservé
# comme repli toujours résolvable). Une grille tarifaire par zone, valeurs de l'ordre de ce qui
# se pratique pour une moto-taxi à Douala -- explicitement provisoires (D21), à confirmer en
# pilote (L10-05).
ZONES = [
    # name,        lat,     lng,     base, per_km, min,  surge, note
    ("Akwa",       4.0483,  9.6934,  300,  110,    400,  1.00,  "centre commerçant"),
    ("Bonapriso",  4.0270,  9.7040,  300,  120,    400,  1.00,  "résidentiel sud"),
    ("Deïdo",      4.0680,  9.7050,  250,  100,    350,  1.00,  "rive droite"),
    ("New-Bell",   4.0530,  9.7150,  250,  100,    350,  1.00,  "quartier populaire dense"),
    ("Bonabéri",   4.0850,  9.6600,  300,  130,    500,  1.15,  "rive gauche, passage du pont"),
    ("Makepe",     4.0730,  9.7550,  300,  115,    400,  1.00,  "est de la ville"),
]
ZONE_HALF_LAT = 0.0060  # ~0,66 km
ZONE_HALF_LNG = 0.0060  # ~0,66 km à cette latitude

N_DRIVERS = 5

# Noms plausibles (Douala : mélange sawa / beti / bamiléké), motos courantes en moto-taxi.
DRIVERS = [
    # sub_suffix, full name,           plate,          brand,     model,      class,      phone
    (1, "Emmanuel Ndoumbè", "LT 4821 AC", "Sanili",  "SL125-9",  "standard", "+237690110201"),
    (2, "Aristide Mbarga",  "LT 3907 BD", "Nanfang",  "NF125-8",  "premium",  "+237690110202"),
    (3, "Cédric Ewané",     "LT 5563 AE", "Haojin",   "HJ150-7",  "standard", "+237690110203"),
    (4, "Guy Njoya",        "LT 2288 CF", "Royal",    "RY125",    "standard", "+237690110204"),
    (5, "Roland Kotto",     "LT 6142 AG", "Kymco",    "GY6-125",  "standard", "+237690110205"),
]

CLIENT_SUB = "babana-demo-client-1"
CLIENT_NAME = "Nadège Eloundou"
CLIENT_EMAIL = "nadege.eloundou@example.cm"
CLIENT_PHONE = "+237699450102"
CLIENT_EMERGENCY = "+237699887766"

SUPERVISOR_LOGIN = "superviseur.demo"
SUPERVISOR_NAME = "Béatrice Manga"
SUPERVISOR_EMAIL = "beatrice.manga@example.cm"

# Historique : (jours dans le passé, indice chauffeur 0-based, quartier départ, quartier arrivée)
HISTORY = [
    (13, 0, "Akwa", "Bonapriso"),
    (11, 1, "Deïdo", "Akwa"),
    (9,  0, "New-Bell", "Makepe"),
    (8,  2, "Bonapriso", "Bonabéri"),
    (6,  1, "Akwa", "Deïdo"),
    (5,  3, "Bonabéri", "Akwa"),
    (3,  2, "New-Bell", "Bonapriso"),
    (1,  0, "Makepe", "Akwa"),
]


# --------------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------------

def zone_polygon(lat, lng):
    d_lat, d_lng = ZONE_HALF_LAT, ZONE_HALF_LNG
    ring = [
        [lng - d_lng, lat - d_lat],
        [lng + d_lng, lat - d_lat],
        [lng + d_lng, lat + d_lat],
        [lng - d_lng, lat + d_lat],
        [lng - d_lng, lat - d_lat],
    ]
    return json.dumps({"type": "Polygon", "coordinates": [ring]})


def haversine_m(a_lat, a_lng, b_lat, b_lng):
    r = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = math.radians(b_lat - a_lat)
    dl = math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def get_or_create(model, domain, vals, label):
    rec = env[model].sudo().search(domain, limit=1)
    if rec:
        return rec, False
    rec = env[model].sudo().create(vals)
    info("+ %s : %s", label, vals.get("name") or vals.get("license_plate") or domain)
    return rec, True


# --------------------------------------------------------------------------------------------
# 1. Devise : XAF est désormais EXIGÉE à l'installation du module (D53,
#    addons/babana/__init__.py::_require_xaf_currency). Ce n'est donc plus au seed de la poser
#    -- il ne fait plus que vérifier, et échoue bruyamment si quelque chose l'a défaite. Une
#    base qui arrive ici en USD a chargé des données de démonstration (without_demo doit valoir
#    `all`) ou n'est pas fraîche : autant le savoir avant de semer 700 « XAF » qui n'en sont pas.
# --------------------------------------------------------------------------------------------

def ensure_currency():
    xaf = env.ref("base.XAF", raise_if_not_found=False)
    if not xaf or env.company.currency_id != xaf:
        raise SystemExit(
            "seed : la devise de la société est %s, pas XAF -- le hook D53 aurait dû l'imposer "
            "à l'installation. Base non fraîche, ou données de démonstration chargées "
            "(services/odoo/config/odoo.conf : without_demo = all). `make reset` puis "
            "réinstaller." % (env.company.currency_id.name or "absente")
        )
    info("devise de la société : XAF (exigée par D53)")


# --------------------------------------------------------------------------------------------
# 2. Zones + grilles tarifaires
# --------------------------------------------------------------------------------------------

def ensure_zones():
    from odoo import fields as odoo_fields

    # Grilles valides « depuis toujours » pour le pilote : sans quoi l'historique de courses
    # (jusqu'à deux semaines en arrière) ne trouverait aucune règle applicable -- active_from
    # d'une règle fraîchement créée vaut aujourd'hui (babana_fare_rule.py).
    rule_active_from = odoo_fields.Date.to_string(
        odoo_fields.Date.today() - timedelta(days=730)
    )
    by_name = {}
    for name, lat, lng, base, per_km, minimum, surge, note in ZONES:
        zone, _ = get_or_create(
            "babana.zone",
            [("name", "=", name)],
            {
                "name": name,
                "priority": 10,
                "is_default": False,
                "polygon_geojson": zone_polygon(lat, lng),
            },
            "zone",
        )
        by_name[name] = (zone, (lat, lng))

        get_or_create(
            "babana.fare.rule",
            [("name", "=", "Grille %s" % name)],
            {
                "name": "Grille %s" % name,
                "zone_id": zone.id,
                "base_fare": float(base),
                "price_per_km": float(per_km),
                "minimum_fare": float(minimum),
                "surge_multiplier": float(surge),
                "priority": 10,
                "active_from": rule_active_from,
            },
            "grille",
        )
    return by_name


# --------------------------------------------------------------------------------------------
# 3. Client + superviseur
# --------------------------------------------------------------------------------------------

def ensure_client():
    user = env["res.users"].sudo().search([("google_sub", "=", CLIENT_SUB)], limit=1)
    if not user:
        user = env["res.users"].sudo()._babana_find_or_create_from_google(
            sub=CLIENT_SUB, email=CLIENT_EMAIL, name=CLIENT_NAME, role="client"
        )
        info("+ client : %s", CLIENT_NAME)
    user.partner_id.sudo().write(
        {
            "phone": CLIENT_PHONE,
            "babana_emergency_contact": CLIENT_EMERGENCY,
        }
    )
    return user


def ensure_supervisor():
    user = env["res.users"].sudo().search([("login", "=", SUPERVISOR_LOGIN)], limit=1)
    if user:
        return user
    groups = [
        env.ref("base.group_user").id,
        env.ref("babana.group_babana_supervisor").id,
    ]
    user = env["res.users"].sudo().create(
        {
            "name": SUPERVISOR_NAME,
            "login": SUPERVISOR_LOGIN,
            "email": SUPERVISOR_EMAIL,
            "groups_id": [(6, 0, groups)],
        }
    )
    info("+ superviseur : %s (%s)", SUPERVISOR_NAME, SUPERVISOR_LOGIN)
    return user


# --------------------------------------------------------------------------------------------
# 4. Flotte : chauffeurs approuvés, motos, documents, affectations
# --------------------------------------------------------------------------------------------

def ensure_fleet():
    from odoo import fields as odoo_fields

    drivers = []
    for suffix, name, plate, brand, model, vclass, phone in DRIVERS:
        sub = "babana-demo-driver-%d" % suffix
        user = env["res.users"].sudo().search([("google_sub", "=", sub)], limit=1)
        if not user:
            user = env["res.users"].sudo()._babana_find_or_create_from_google(
                sub=sub, email="%s@drivers.example.cm" % sub, name=name, role="driver"
            )
        driver = user._babana_driver()
        driver.sudo().write({"phone_verified": True})
        if user.partner_id:
            user.partner_id.sudo().write({"phone": phone})

        if driver.state != "approved":
            # a. documents vérifiés (permis daté, pièce d'identité)
            for dtype in ("license", "id_card"):
                exists = env["babana.driver.document"].sudo().search_count(
                    [("driver_id", "=", driver.id), ("document_type", "=", dtype)]
                )
                if not exists:
                    vals = {
                        "driver_id": driver.id,
                        "document_type": dtype,
                        "storage_key": "seed/%s/%s.jpg" % (sub, dtype),
                        "mime_type": "image/jpeg",
                        "verification_status": "verified",
                    }
                    if dtype == "license":
                        vals["expires_on"] = odoo_fields.Date.to_string(
                            odoo_fields.Date.today() + timedelta(days=520)
                        )
                    env["babana.driver.document"].sudo().create(vals)

            # b. moto
            moto, _ = get_or_create(
                "babana.motorcycle",
                [("license_plate", "=", plate)],
                {
                    "license_plate": plate,
                    "brand": brand,
                    "model": model,
                    "year": 2022,
                    "vehicle_class": vclass,
                    "insurer": "Activa Assurances",
                    "insurance_policy_number": "AC-2026-%05d" % (7000 + suffix),
                    "insurance_expires_on": odoo_fields.Date.to_string(
                        odoo_fields.Date.today() + timedelta(days=260)
                    ),
                    "registration_reference": "CG-DLA-%05d" % (4000 + suffix),
                },
                "moto",
            )

            # c. affectation durable (écrit moto.driver_id via son create())
            open_assign = env["babana.assignment"].sudo().search_count(
                [("driver_id", "=", driver.id), ("end_date", "=", False)]
            )
            if not open_assign:
                env["babana.assignment"].sudo().create(
                    {"motorcycle_id": moto.id, "driver_id": driver.id}
                )
            driver.invalidate_recordset()

            # d. approbation (crée la fiche hr.employee -- seule écriture RH du système)
            driver.sudo().action_approve(new_employee_name=name)
            info("+ chauffeur approuvé : %s [%s, %s]", name, plate, vclass)

        if not driver.is_online:
            driver.sudo().write({"is_online": True})

        drivers.append(driver)
    return drivers


# --------------------------------------------------------------------------------------------
# 5. Historique de courses terminées
# --------------------------------------------------------------------------------------------

def reference_route(origin, destination):
    """Distance/durée de référence : la vraie doublure mock-maps si elle répond (comme une
    estimation réelle), sinon un repli local plausible pour que le seed n'échoue jamais sur un
    hoquet réseau. Renvoie (distance_m, duration_s, polyline)."""
    from odoo.addons.babana.services import routing

    try:
        r = routing.get_reference_route(
            env,
            origin=origin,
            destination=destination,
            vehicle_class="standard",
            at_datetime=datetime.now(),
        )
        return int(r.distance_meters), int(r.duration_seconds), r.polyline or ""
    except Exception as exc:  # noqa: BLE001 -- routing.RouteUnavailable et cie
        crow = haversine_m(origin[0], origin[1], destination[0], destination[1])
        dist = int(crow * 1.35)  # facteur route/vol d'oiseau, ordre de grandeur urbain
        dur = int(dist / 6.5)  # ~23 km/h moyen en ville
        info("mock-maps indisponible (%s) -- repli local : %d m", exc, dist)
        return dist, dur, ""


def make_history(client_user, drivers, zones_by_name):
    from odoo import fields as odoo_fields
    from odoo.addons.babana.services import pricing

    partner = client_user.partner_id
    rounding_step = env["babana.fare.rule"].sudo()._default_rounding_step()
    made = 0

    # Rejouabilité (docstring de tête) : la clé naturelle d'une entrée HISTORY ne peut pas être
    # un champ métier -- ni la date (calculée depuis datetime.now(), donc différente à chaque
    # nuit) ni la paire de zones (deux entrées distinctes de HISTORY peuvent la partager). Gardée
    # à part, dans ir.config_parameter, plutôt que dans pickup_label : jusqu'au 2 septembre ce
    # marqueur technique ("seed-history:1:0:Makepe>Akwa") était affiché tel quel comme adresse de
    # départ dans "Courses récentes" -- constaté en revue visuelle du back-office, jamais vu avant
    # faute d'identifiant admin (amoa/questions/REPONSES-2026-09-11.md §1).
    Param = env["ir.config_parameter"].sudo()
    seen_markers = set(json.loads(Param.get_param("babana.seed_history_markers") or "[]"))

    for days_ago, driver_ix, from_name, to_name in HISTORY:
        driver = drivers[driver_ix]
        _, (o_lat, o_lng) = zones_by_name[from_name]
        _, (d_lat, d_lng) = zones_by_name[to_name]
        # léger décalage pour ne pas empiler tous les départs sur le centroïde exact
        o_lat += 0.0011 * ((days_ago % 3) - 1)
        d_lng += 0.0011 * ((driver_ix % 3) - 1)

        when = datetime.now() - timedelta(days=days_ago, hours=(driver_ix + 1))

        marker = "seed-history:%d:%d:%s>%s" % (days_ago, driver_ix, from_name, to_name)
        if marker in seen_markers:
            continue

        pickup_zone = env["babana.zone"].sudo().resolve_point(latitude=o_lat, longitude=o_lng)
        dropoff_zone = env["babana.zone"].sudo().resolve_point(latitude=d_lat, longitude=d_lng)
        rule = env["babana.fare.rule"].sudo()._find_applicable_rule(
            zone=pickup_zone, vehicle_class="standard", at_datetime=when
        )
        dist_m, dur_s, polyline = reference_route((o_lat, o_lng), (d_lat, d_lng))

        breakdown = pricing.compute_fare(
            pricing.FareRuleInput(
                base_fare=rule.base_fare,
                price_per_km=rule.price_per_km,
                minimum_fare=rule.minimum_fare,
                surge_multiplier=rule.surge_multiplier,
            ),
            dist_m,
            rounding_step=rounding_step,
        )
        snapshot = json.dumps(_breakdown_dict(breakdown))

        quote = env["babana.quote"].sudo().create(
            {
                "client_id": partner.id,
                "pickup_latitude": o_lat,
                "pickup_longitude": o_lng,
                "dropoff_latitude": d_lat,
                "dropoff_longitude": d_lng,
                "pickup_zone_id": pickup_zone.id,
                "dropoff_zone_id": dropoff_zone.id,
                "vehicle_class": "standard",
                "distance_meters": dist_m,
                "duration_seconds": dur_s,
                "eta_seconds": dur_s,
                "fare_rule_id": rule.id,
                "fare_rule_snapshot": snapshot,
                "amount": breakdown.total,
                "promo_applied": False,
                "discount_amount": breakdown.discount_amount,
                "expires_at": odoo_fields.Datetime.to_string(when + timedelta(minutes=5)),
            }
        )

        ride = env["babana.ride"].sudo().action_request(
            {
                "client_id": partner.id,
                "pickup_latitude": o_lat,
                "pickup_longitude": o_lng,
                "pickup_label": "%s (démo)" % from_name,
                "dropoff_latitude": d_lat,
                "dropoff_longitude": d_lng,
                "dropoff_label": "%s (démo)" % to_name,
                "pickup_zone_id": pickup_zone.id,
                "dropoff_zone_id": dropoff_zone.id,
                "quote_id": quote.id,
                "currency_id": quote.currency_id.id,
                "estimated_amount": quote.amount,
                "reference_distance_km": dist_m / 1000.0,
                "estimated_duration_minutes": dur_s / 60.0,
                "fare_rule_id": rule.id,
                "fare_rule_snapshot": snapshot,
                "discount_amount": breakdown.discount_amount,
            }
        )
        ride.sudo().action_propose(by_partner=partner, driver=driver)
        ride.sudo().action_accept(by_driver=driver)
        ride.sudo().action_start(by_driver=driver)
        ride.sudo().action_complete(
            by_driver=driver, final_amount=ride.estimated_amount, measurement=None
        )
        ride.sudo().action_settle(by_driver=driver, amount_collected=ride.final_amount)

        # Antidater pour que l'historique s'étale sur deux semaines plutôt que de s'empiler à
        # la seconde du seed. create_date est une colonne technique : SQL direct, seul cas où
        # ce script contourne l'ORM, et seulement pour des horodatages (jamais `state`).
        env.cr.execute(
            """
            UPDATE babana_ride
               SET create_date = %s, write_date = %s,
                   requested_at = %s, proposed_at = %s, assigned_at = %s,
                   started_at = %s, completed_at = %s, settled_at = %s
             WHERE id = %s
            """,
            (when, when, when, when, when,
             when + timedelta(minutes=2), when + timedelta(minutes=17),
             when + timedelta(minutes=18), ride.id),
        )
        env.cr.execute(
            "UPDATE babana_cash_movement SET create_date = %s WHERE ride_id = %s",
            (when + timedelta(minutes=18), ride.id),
        )
        seen_markers.add(marker)
        made += 1
        info("+ course %s : %s -> %s, %d FCFA (%s)", ride.reference, from_name, to_name,
             round(ride.final_amount), driver.employee_id.name)

    Param.set_param("babana.seed_history_markers", json.dumps(sorted(seen_markers)))
    return made


def _breakdown_dict(b):
    return {
        "base_fare": b.base_fare,
        "distance_fare": b.distance_fare,
        "surge_amount": b.surge_amount,
        "discount_amount": b.discount_amount,
        "floor_amount": b.floor_amount,
        "rounding_amount": b.rounding_amount,
        "minimum_fare_applied": b.minimum_fare_applied,
        "total": b.total,
    }


# --------------------------------------------------------------------------------------------
# Point d'entrée
# --------------------------------------------------------------------------------------------

def main():
    info("== seed babana : début ==")
    ensure_currency()
    zones_by_name = ensure_zones()
    client = ensure_client()
    ensure_supervisor()
    drivers = ensure_fleet()
    n_hist = make_history(client, drivers, zones_by_name)

    env["ir.config_parameter"].sudo().set_param(
        "babana.seed_done", datetime.now().isoformat(timespec="seconds")
    )
    env.cr.commit()

    n_online = env["babana.driver"].sudo().search_count(
        [("state", "=", "approved"), ("is_online", "=", True)]
    )
    n_rides = env["babana.ride"].sudo().search_count([("state", "=", "settled")])
    info("== seed babana : OK ==")
    info("   zones=%d  chauffeurs en ligne=%d  courses réglées=%d  (+%d cette exécution)",
         len(ZONES), n_online, n_rides, n_hist)
    info("   étape suivante pour la carte en direct :  make seed-drivers")


try:
    main()
except Exception:  # noqa: BLE001
    import traceback
    sys.stdout.write("\n== seed babana : ÉCHEC ==\n")
    traceback.print_exc(file=sys.stdout)
    sys.stdout.flush()
    env.cr.rollback()
    os._exit(1)

os._exit(0)
