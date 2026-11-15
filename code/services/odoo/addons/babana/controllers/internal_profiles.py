# Canal interne Odoo -> temps réel pour les profils chauffeur affichés par nearby.drivers
# (L3-16). Même authentification, même politique de repli que controllers/internal.py -- un seul
# mécanisme de secret partagé (_common.authenticated_internal_call), jamais un second à inventer.
# Symétrique du canal de configuration décrit par L3-15 (jamais construit), en forme : une donnée
# PAR ENREGISTREMENT plutôt qu'un paramètre global.
#
# Le sens de la dépendance ne s'inverse pas (D27) : ce contrôleur est lu par le service temps
# réel, jamais l'inverse -- rien ici ne pousse quoi que ce soit vers Redis.
from __future__ import annotations

from odoo import SUPERUSER_ID, http
from odoo.http import request

from . import _common
from ..services import storage

# Durée de vie de l'URL signée de la photo de profil (15 novembre). Le service temps réel relit les
# profils toutes les 30 s (DRIVER_PROFILE_CACHE_TTL_SECONDS) ; une heure laisse au client le temps
# de charger l'image même après une coupure, sans en faire une adresse durable.
PHOTO_URL_TTL_SECONDS_PARAM = "babana.driver_photo_url_ttl_seconds"
PHOTO_URL_TTL_SECONDS_DEFAULT = 3600

# readonly implicite (pas de readonly=False) : cette route ne lit que.
_ROUTE = {"type": "http", "auth": "none", "methods": ["POST"], "csrf": False}


class InternalDriverProfilesController(http.Controller):
    @http.route("/api/internal/drivers/profiles", **_ROUTE)
    def driver_profiles(self, **_kwargs):
        try:
            _common.authenticated_internal_call()
            payload, status = self._driver_profiles()
            return _common.json_response(payload, status)
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except Exception:
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _driver_profiles(self):
        # Par lot, jamais un chauffeur à la fois (spécification -- le service temps réel
        # n'appelle ceci qu'une fois par requête nearby, voir redis/driver-profiles.ts côté
        # temps réel, critère 3).
        body = _common.parse_json_body() or {}
        driver_ids = body.get("driverIds")
        if not isinstance(driver_ids, list) or not driver_ids:
            return {"profiles": {}}, 200

        env = request.env(user=SUPERUSER_ID)
        drivers = env["babana.driver"].sudo().search([("public_id", "in", driver_ids)])

        # Un identifiant demandé mais introuvable (dossier supprimé, faux identifiant) n'a
        # simplement pas d'entrée dans la réponse -- jamais une entrée à null ici : c'est le
        # service temps réel (nearby/projection.ts) qui traduit une absence en champs à `null`
        # (D30), pas ce contrôleur.
        return {"profiles": {driver.public_id: self._project(driver) for driver in drivers}}, 200

    @staticmethod
    def _photo_url(driver):
        env = driver.env
        photo = env["babana.driver.document"].sudo().search(
            [
                ("driver_id", "=", driver.id),
                ("document_type", "=", "profile_photo"),
                ("verification_status", "=", "verified"),
            ],
            order="create_date desc, id desc",
            limit=1,
        )
        if not photo:
            return None
        ttl = int(
            env["ir.config_parameter"].sudo().get_param(PHOTO_URL_TTL_SECONDS_PARAM, PHOTO_URL_TTL_SECONDS_DEFAULT)
        )
        try:
            return storage.generate_signed_url(photo.storage_key, ttl_seconds=ttl)
        except Exception:  # noqa: BLE001 -- un stockage indisponible dégrade l'affichage, jamais l'affectation (D30)
            return None

    @staticmethod
    def _project(driver) -> dict:
        """Liste blanche champ par champ (critère 4) : jamais driver.read(), jamais un champ
        ajouté ici sans décision explicite -- même discipline que
        services/realtime/src/nearby/projection.ts côté temps réel (L3-05/L3-16). Si la seule
        protection contre une fuite (numéro de téléphone...) était la projection côté temps
        réel, elle tomberait le jour où quelqu'un y ajouterait un champ "pratique".

        `licensePlate` ajouté le 25 août (D41, amoa/questions/REPONSES-2026-08-25.md §2) --
        décision explicite, pas l'exception que le paragraphe ci-dessus met en garde contre.
        Ce canal est interne (authenticated_internal_call, jamais atteignable depuis le mobile
        ni Caddy) : la frontière C2b qui compte reste `nearby/projection.ts`, qui n'expose
        toujours PAS ce champ à `nearby.drivers` -- seul `ride.assigned`
        (`proposal/lifecycle.ts::accept`) le lit, une fois le chauffeur choisi et affecté."""
        first_name = None
        last_name = None
        if driver.employee_id and driver.employee_id.name:
            # Prénom et nom (15 novembre, réponse du maître d'ouvrage : le client voit le nom
            # complet de son chauffeur). Aucun champ prénom/nom séparé sur hr.employee : premier mot
            # du nom complet, puis le reste.
            parts = driver.employee_id.name.split()
            first_name = parts[0] if parts else None
            last_name = " ".join(parts[1:]) or None

        # L4-09 : en dessous de babana.rating_min_count avis, la moyenne n'est pas significative --
        # `None`, que l'app affiche « nouveau », plutôt qu'une note qui condamnerait un chauffeur
        # sur deux avis (D10, D30).
        enough = driver.rating_count >= driver.env["babana.rating"]._min_count()
        rating = round(driver.rating_avg, 1) if enough else None

        motorcycle_class = driver.motorcycle_id.vehicle_class if driver.motorcycle_id else None
        license_plate = driver.motorcycle_id.license_plate if driver.motorcycle_id else None
        # D42 (2 septembre, amoa/questions/REPONSES-2026-09-02.md §1) : le numéro du chauffeur,
        # pour que le client puisse l'appeler à l'affectation. Même discipline que license_plate
        # (décision explicite, pas le champ "pratique" que le paragraphe ci-dessus met en garde
        # contre) -- hr.employee.mobile_phone, pas encore garanti renseigné (L1-06, validation du
        # dossier, hors de ce lot).
        phone_number = driver.employee_id.mobile_phone if driver.employee_id else None

        return {
            "firstName": first_name,
            "lastName": last_name,
            # La dernière photo de profil VALIDÉE au back-office (15 novembre), en URL signée à
            # durée limitée -- jamais une adresse durable. Aucune photo validée : `None`, l'app
            # affiche l'avatar générique.
            "photoUrl": InternalDriverProfilesController._photo_url(driver),
            "rating": rating,
            "motorcycleClass": motorcycle_class,
            "licensePlate": license_plate,
            "phoneNumber": phone_number or None,
        }
