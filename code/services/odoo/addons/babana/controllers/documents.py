# Documents chauffeur (L1-05, É2) : téléversement (permis, pièce d'identité) et accès signé à
# durée limitée. Le fichier ne transite jamais par PostgreSQL -- écrit sur S3/MinIO
# (services/storage.py), seule la clé d'objet est enregistrée sur babana.driver.document.
#
# GET /api/v1/driver/documents (liste des documents du chauffeur courant avec leur état) est
# ajouté par L6-15 : c'est ce que l'écran d'attente de dossier lit pour dire précisément où il
# en est. Même chemin que l'upload, méthode distincte.
from __future__ import annotations

import logging

from odoo import http
from odoo.http import request

from . import _common
from ..services import storage

_logger = logging.getLogger(__name__)

# readonly=False explicite : auth='none' est en lecture seule par défaut depuis Odoo 18
# (code/docs/odoo-pitfalls.md) -- toute route qui écrit doit le déclarer, ne pas compter sur le
# comportement par défaut.
#
# _URL_ROUTE porte désormais readonly=False, trouvé en construisant D68 (01-architecture.md
# §9 decies) : L8-09 (_signed_url ci-dessous) a ajouté une écriture -- l'entrée d'audit de
# l'accès -- APRÈS que cette route ait été déclarée readonly=True (elle ne lisait alors vraiment
# que la base). Cette écriture échouait donc silencieusement à chaque appel réel
# (`ReadOnlySqlTransaction`), absorbée par le savepoint de `_babana_record` (critère 3) sans
# qu'aucun test ne l'ait remarqué -- le test de critère 1 existant exerçait le même point
# d'écriture par le chemin back-office (`action_preview`), jamais par cette route HTTP réelle.
# Exactement le silence que D68 existe pour rendre visible, ici trouvé pendant la construction du
# signal plutôt que le jour d'un litige. Voir test_documents.py::
# test_signed_url_access_is_journalized_over_a_real_http_call.
_UPLOAD_ROUTE = {"type": "http", "auth": "none", "methods": ["POST"], "csrf": False,
                  "readonly": False}
_URL_ROUTE = {"type": "http", "auth": "none", "methods": ["GET"], "csrf": False,
              "readonly": False}
_LIST_ROUTE = {"type": "http", "auth": "none", "methods": ["GET"], "csrf": False,
               "readonly": True}

_DOCUMENT_TYPES = {"license", "id_card"}


class DriverDocumentsController(http.Controller):
    @http.route("/api/v1/driver/documents", **_UPLOAD_ROUTE)
    def upload(self, **_kwargs):
        try:
            return self._upload()
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except Exception:
            _logger.exception("erreur interne dans POST /api/v1/driver/documents")
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    @http.route("/api/v1/driver/documents", **_LIST_ROUTE)
    def list_documents(self, **_kwargs):
        try:
            return self._list_documents()
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except Exception:
            _logger.exception("erreur interne dans GET /api/v1/driver/documents")
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _list_documents(self):
        _env, user = _common.authenticated_user()
        driver = user._babana_driver()
        if not driver:
            return _common.error_response(
                "UNAUTHORIZED", "ce compte n'est pas un compte chauffeur", 401
            )

        # Le plus récent par type seulement (L6-15) : renvoyer un permis rejeté PUIS un permis
        # renvoyé (deux lignes en base, l'upload crée toujours) afficherait deux états pour un
        # même document. L'ancien reste en base pour l'audit ; l'app ne voit que le courant.
        #
        # D54 : lecture au nom de l'utilisateur -- c'est la règle `babana.driver.document`
        # (driver_id.user_id = moi, sans condition d'état depuis D55) qui garantit qu'un
        # chauffeur ne lit que SES documents, y compris pendant que son dossier est `pending`
        # (c'est justement l'écran qui attend cette validation).
        latest_by_type = {}
        for document in driver.with_user(user).document_ids.sorted("create_date", reverse=True):
            latest_by_type.setdefault(document.document_type, document)

        return _common.json_response(
            {"documents": [self._project_document(d) for d in latest_by_type.values()]},
            200,
        )

    @staticmethod
    def _project_document(document):
        return {
            "id": document.id,
            "documentType": document.document_type,
            "verificationStatus": document.verification_status,
            # Motif présent seulement quand rejeté (L6-15, critère 3) -- `null` sinon, jamais une
            # chaîne vide qui se présenterait comme un motif.
            "rejectionReason": document.rejection_reason or None
            if document.verification_status == "rejected"
            else None,
            "expiresOn": document.expires_on.isoformat() if document.expires_on else None,
            "uploadedAt": _common.iso_datetime(document.create_date),
        }

    def _upload(self):
        env, user = _common.authenticated_user()
        driver = user._babana_driver()
        if not driver:
            return _common.error_response(
                "UNAUTHORIZED", "ce compte n'est pas un compte chauffeur", 401
            )

        document_type = request.httprequest.form.get("documentType")
        if document_type not in _DOCUMENT_TYPES:
            return _common.error_response(
                "VALIDATION_ERROR", "documentType doit valoir 'license' ou 'id_card'", 400
            )

        expires_on = request.httprequest.form.get("expiresOn") or None
        if document_type == "license" and not expires_on:
            # Doublé par la contrainte du modèle (critère 5) -- rejeté ici en amont pour
            # renvoyer VALIDATION_ERROR (corps invalide) plutôt qu'INTERNAL_ERROR si jamais la
            # contrainte remontait telle quelle.
            return _common.error_response(
                "VALIDATION_ERROR", "expiresOn est requis pour un permis", 400
            )

        uploaded = request.httprequest.files.get("file")
        if uploaded is None or not uploaded.filename:
            return _common.error_response("VALIDATION_ERROR", "file manquant", 400)
        data = uploaded.read()

        max_bytes = storage.default_max_upload_bytes(env)
        if len(data) > max_bytes:
            return _common.error_response(
                "VALIDATION_ERROR", "fichier trop volumineux", 400
            )

        declared_content_type = request.httprequest.form.get("contentType")
        real_mime_type = storage.sniff_mime_type(data)
        if real_mime_type is None or real_mime_type != declared_content_type:
            # Critère d'acceptation 4 : le type MIME réel, pas seulement l'extension -- rejeté
            # avant toute écriture, ni sur S3 ni sur babana.driver.document.
            return _common.error_response(
                "DOCUMENT_TYPE_MISMATCH",
                "le type MIME réel du fichier ne correspond pas au type déclaré",
                400,
            )

        key = storage.build_storage_key(driver.id, document_type, uploaded.filename)
        storage.upload(key, data, real_mime_type)

        document = env["babana.driver.document"].sudo().create(
            {
                "driver_id": driver.id,
                "document_type": document_type,
                "storage_key": key,
                "mime_type": real_mime_type,
                "expires_on": expires_on,
            }
        )
        return _common.json_response(
            {
                "id": document.id,
                "documentType": document.document_type,
                "verificationStatus": document.verification_status,
            },
            201,
        )

    @http.route("/api/v1/driver/documents/<int:document_id>/url", **_URL_ROUTE)
    def signed_url(self, document_id, **_kwargs):
        try:
            return self._signed_url(document_id)
        except _common.AuthenticationFailed as exc:
            return _common.error_response(exc.code, "authentification requise", exc.status)
        except Exception:
            _logger.exception(
                "erreur interne dans GET /api/v1/driver/documents/%s/url", document_id
            )
            return _common.error_response("INTERNAL_ERROR", "erreur interne", 500)

    def _signed_url(self, document_id):
        env, user = _common.authenticated_user()
        # D54 (amoa/questions/REPONSES-2026-09-08.md §2) : le lookup passe par l'utilisateur.
        # `exists()` seul ne suffirait pas -- il ignore les règles d'enregistrement. C'est
        # `search` au nom de l'appelant qui décide : le document d'un autre chauffeur (et rien
        # du tout pour un client) revient VIDE -> DOCUMENT_NOT_FOUND 404, jamais
        # DOCUMENT_NOT_OWNED 403 (on ne confirme pas qu'il existe). Un gestionnaire, lui, voit
        # tous les documents (droit d'accès `group_babana_manager`, aucune règle portail ne le
        # restreint) : c'est ce chemin que la validation de dossier L9-01 emprunte pour
        # l'aperçu des pièces.
        document = env["babana.driver.document"].with_user(user).search(
            [("id", "=", document_id)], limit=1
        )
        if not document:
            return _common.error_response("DOCUMENT_NOT_FOUND", "document inconnu", 404)

        driver = user._babana_driver()
        is_owner = bool(driver) and document.sudo().driver_id == driver
        is_manager = user.sudo().has_group("babana.group_babana_manager")
        if not is_owner and not is_manager:
            # Défense en profondeur (critère d'acceptation 3) : inatteignable maintenant que le
            # lookup filtre -- seul le propriétaire ou un gestionnaire voit encore la ligne.
            return _common.error_response(
                "DOCUMENT_NOT_OWNED", "ce document n'appartient pas à l'appelant", 403
            )

        ttl_seconds = storage.default_url_ttl_seconds(env)
        url = storage.generate_signed_url(document.sudo().storage_key, ttl_seconds=ttl_seconds)

        # L8-09 : "chaque accès à un document chauffeur" -- le seul événement obligatoire de la
        # spécification qui ne passe par aucune transition (babana_ride_state.py). Journalisé
        # après la décision d'autorisation, jamais avant : un DOCUMENT_NOT_FOUND ou
        # DOCUMENT_NOT_OWNED n'accède à rien, il n'y a rien à tracer.
        env["babana.audit.log"]._babana_record(
            event="driver_document.access",
            model_name="babana.driver.document",
            res_id=document.sudo().id,
            record_reference=document.sudo().document_type,
            actor=user,
            after={"driver_id": document.sudo().driver_id.id, "ttl_seconds": ttl_seconds},
            accessed_via="signed_url",
            is_owner=is_owner,
            is_manager=is_manager,
        )
        return _common.json_response({"url": url, "expiresIn": ttl_seconds}, 200)
