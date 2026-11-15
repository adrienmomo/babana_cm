# Selfie de contrôle du chauffeur (15 novembre) : l'état (faut-il en prendre un) et le dépôt. Le
# dépôt suit `documents.py` : type MIME réel vérifié par signature, fichier sur le stockage S3,
# une ligne en base -- une écriture par selfie pris, une décision humaine (invariant 1).
from __future__ import annotations

import logging

from odoo import http
from odoo.http import request

from . import _common
from ..models.babana_driver_selfie import SELFIE_MIME_TYPES
from ..services import storage

_logger = logging.getLogger(__name__)

_POST_ROUTE = {"type": "http", "auth": "none", "methods": ["POST"], "csrf": False, "readonly": False}
_GET_ROUTE = {"type": "http", "auth": "none", "methods": ["GET"], "csrf": False, "readonly": True}


def _status_payload(env, driver) -> dict:
    Selfie = env["babana.driver.selfie"]
    status = Selfie._status_for(driver)
    return {
        "due": status["due"],
        "lastState": status["lastState"],
        "rejectionReason": status["rejectionReason"],
        "dueAt": _common.iso_datetime(status["dueAt"]) if status["dueAt"] else None,
        "intervalHours": Selfie._interval_hours(),
    }


class DriverSelfieController(http.Controller):
    def _run(self, endpoint, handler):
        try:
            return handler()
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except Exception:
            _logger.exception("erreur interne dans %s", endpoint)
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _driver(self):
        env, user = _common.authenticated_user()
        driver = user._babana_driver()
        if not driver:
            raise _common.AuthenticationFailed("UNAUTHORIZED")
        return env, driver

    @http.route("/api/v1/drivers/me/selfie", **_GET_ROUTE)
    def selfie_status(self, **_kwargs):
        return self._run("GET /api/v1/drivers/me/selfie", self._selfie_status)

    def _selfie_status(self):
        env, driver = self._driver()
        return _common.json_response(_status_payload(env, driver.sudo()), 200)

    @http.route("/api/v1/drivers/me/selfie", **_POST_ROUTE)
    def upload_selfie(self, **_kwargs):
        return self._run("POST /api/v1/drivers/me/selfie", self._upload_selfie)

    def _upload_selfie(self):
        env, driver = self._driver()
        uploaded = request.httprequest.files.get("file")
        if uploaded is None or not uploaded.filename:
            return _common.error_response("VALIDATION_ERROR", "file manquant", 400)
        data = uploaded.read()
        if len(data) > storage.default_max_upload_bytes(env):
            return _common.error_response("VALIDATION_ERROR", "fichier trop volumineux", 400)
        declared = request.httprequest.form.get("contentType")
        real = storage.sniff_mime_type(data)
        if real is None or real != declared:
            return _common.error_response(
                "DOCUMENT_TYPE_MISMATCH", "le type MIME réel du fichier ne correspond pas au type déclaré", 400
            )
        if real not in SELFIE_MIME_TYPES:
            return _common.error_response("VALIDATION_ERROR", "un selfie est une image JPEG ou PNG", 400)

        key = storage.build_storage_key(driver.id, "selfie", uploaded.filename)
        storage.upload(key, data, real)
        env["babana.driver.selfie"].sudo().create({"driver_id": driver.id, "storage_key": key, "mime_type": real})
        return _common.json_response(_status_payload(env, driver.sudo()), 201)
