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
        if driver.employee_id and driver.employee_id.name:
            # Seul le prénom est affiché (C2b) -- aucun champ prénom/nom séparé sur hr.employee
            # dans ce lot (L1-06 ne rattache qu'un nom complet) : premier mot du nom complet,
            # choix d'implémentation non spécifié, à corriger le jour où un prénom dédié existe.
            first_name = driver.employee_id.name.split(" ")[0]

        # rating_avg/rating_count sont un champ-pont (L1-03, [PONT -- remplacé par L4-09]) :
        # toujours 0.0/0 tant que babana.rating n'existe pas. Servir 0.0 comme une vraie note
        # inventerait une donnée qui n'existe pas encore -- `None` avoue l'absence (D30), au lieu
        # d'attendre une seconde correction quand L4-09 arrivera.
        rating = driver.rating_avg if driver.rating_count > 0 else None

        motorcycle_class = driver.motorcycle_id.vehicle_class if driver.motorcycle_id else None
        license_plate = driver.motorcycle_id.license_plate if driver.motorcycle_id else None

        return {
            "firstName": first_name,
            # Aucun document de type "photo de profil" dans ce lot (L1-05 ne connaît que permis
            # et pièce d'identité, jamais servis en URL publique -- 01-architecture.md §9) :
            # absence réelle, pas un oubli.
            "photoUrl": None,
            "rating": rating,
            "motorcycleClass": motorcycle_class,
            "licensePlate": license_plate,
        }
