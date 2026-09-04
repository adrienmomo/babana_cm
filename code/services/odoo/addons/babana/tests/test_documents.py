# Tests des documents chauffeur (L1-05) : stockage S3/MinIO privé, URL signée, MIME réel.
from __future__ import annotations

import json
import os
import time
from unittest import mock

import requests

from odoo.exceptions import ValidationError
from odoo.tests.common import HttpCase, TransactionCase, tagged

from ..services import storage

_A_JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"\x00" * 32
_A_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
_A_PDF = b"%PDF-1.4\n" + b"\x00" * 32


def _mock_google_base_url() -> str:
    return os.environ.get("GOOGLE_MOCK_IDENTITY_URL", "http://mock-google-identity:4000")


def _first_allowed_audience() -> str:
    raw = os.environ.get("GOOGLE_OAUTH_CLIENT_IDS", "")
    first = raw.split(",")[0].strip()
    assert first, "GOOGLE_OAUTH_CLIENT_IDS doit être configurée pour exécuter ces tests"
    return first


def _mint_google_token(**overrides) -> str:
    payload = dict(overrides)
    if "aud" not in payload:
        payload["aud"] = _first_allowed_audience()
    response = requests.post(f"{_mock_google_base_url()}/token", json=payload, timeout=5)
    response.raise_for_status()
    return response.json()["id_token"]


# --- Critères 1 et 2 : stockage privé, URL signée à durée limitée -------------------------------
# Tests unitaires directs sur services/storage.py, contre le vrai MinIO de la stack de
# développement (D19) -- pas de mock ici, S3/MinIO est déjà le simulateur.


@tagged("post_install", "-at_install")
class TestStoragePrivateAccess(TransactionCase):
    @classmethod
    def _request_handler(cls, s, r, **kw):
        # Le garde-fou du framework de test Odoo bloque toute requête HTTP externe non prévue
        # (BlockedRequest). MinIO (S3_ENDPOINT) est un conteneur distinct, délibérément
        # joignable pour prouver ces critères contre le vrai stockage simulé (D19) -- même
        # mécanisme que test_auth.py pour mock-google-identity.
        if r.url.startswith(os.environ["S3_ENDPOINT"]):
            from odoo.tests.common import _super_send

            return _super_send(s, r, **kw)
        return super()._request_handler(s, r, **kw)

    def setUp(self):
        super().setUp()
        # D64 (amoa/01-architecture.md §9 octies) : generate_signed_url() signe désormais pour
        # S3_PUBLIC_ENDPOINT, jamais S3_ENDPOINT -- exactement le point de la correction. Depuis
        # CE conteneur (Odoo, où ce test s'exécute), S3_PUBLIC_ENDPOINT (http://localhost:9000 en
        # développement) ne route vers rien : c'est le loopback du conteneur odoo, pas celui de
        # minio. Reproduire ici la même erreur que celle trouvée le 16 septembre reviendrait à
        # revérifier une propriété du mauvais côté de la frontière (§9 octies) -- le critère que
        # ce test-ci NE prouve PAS. Ce qu'il prouve : le MÉCANISME de signature/expiration
        # (SigV4, ExpiresIn), indépendant de l'hôte visé -- posé ici sur S3_ENDPOINT (joignable
        # depuis ce conteneur) pour la durée de cette classe seulement. La joignabilité du VRAI
        # point d'entrée public, elle, est prouvée depuis l'EXTÉRIEUR de tout conteneur --
        # critère 6, test/storage/public-entrypoint.test.ts.
        patcher = mock.patch.dict(os.environ, {"S3_PUBLIC_ENDPOINT": os.environ["S3_ENDPOINT"]})
        patcher.start()
        self.addCleanup(patcher.stop)

    def _upload_test_object(self) -> str:
        key = storage.build_storage_key(999999, "id_card", "piece.jpg")
        storage.upload(key, _A_JPEG, "image/jpeg")
        return key

    def test_object_is_not_accessible_without_a_signed_url(self):
        key = self._upload_test_object()
        direct_url = f"{os.environ['S3_ENDPOINT']}/{os.environ['S3_BUCKET']}/{key}"

        response = requests.get(direct_url, timeout=5)

        self.assertIn(response.status_code, (401, 403))

    def test_signed_url_grants_access_to_the_object(self):
        key = self._upload_test_object()

        url = storage.generate_signed_url(key, ttl_seconds=60)
        response = requests.get(url, timeout=5)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, _A_JPEG)

    def test_signed_url_expires(self):
        # Testé en laissant le temps réel s'écouler, pas en simulant l'horloge du processus de
        # test : la signature est vérifiée par MinIO, un conteneur séparé dont l'horloge n'a
        # aucune raison de suivre un gel de temps local (freezegun) fait côté Odoo.
        key = self._upload_test_object()
        url = storage.generate_signed_url(key, ttl_seconds=1)

        time.sleep(1.5)
        response = requests.get(url, timeout=5)

        self.assertIn(response.status_code, (401, 403))


# --- Critère 5 : la date d'expiration du permis est obligatoire (modèle) ------------------------


@tagged("post_install", "-at_install")
class TestDriverDocumentModel(TransactionCase):
    def _make_driver(self):
        employee = self.env["hr.employee"].create({"name": "Chauffeur de test"})
        return self.env["babana.driver"].create({"employee_id": employee.id})

    def test_license_without_expiry_is_rejected(self):
        driver = self._make_driver()
        with self.assertRaises(ValidationError):
            self.env["babana.driver.document"].create(
                {
                    "driver_id": driver.id,
                    "document_type": "license",
                    "storage_key": "irrelevant",
                }
            )

    def test_id_card_without_expiry_is_allowed(self):
        driver = self._make_driver()
        document = self.env["babana.driver.document"].create(
            {"driver_id": driver.id, "document_type": "id_card", "storage_key": "irrelevant"}
        )
        self.assertFalse(document.expires_on)

    # --- L6-15 : vérification / rejet côté back-office -----------------------------------------

    def test_action_verify_sets_status_and_clears_reason(self):
        driver = self._make_driver()
        document = self.env["babana.driver.document"].create(
            {
                "driver_id": driver.id,
                "document_type": "id_card",
                "storage_key": "irrelevant",
                "verification_status": "rejected",
                "rejection_reason": "Photo floue",
            }
        )
        document.action_verify()
        self.assertEqual(document.verification_status, "verified")
        self.assertFalse(document.rejection_reason)

    def test_action_reject_requires_a_reason(self):
        driver = self._make_driver()
        document = self.env["babana.driver.document"].create(
            {"driver_id": driver.id, "document_type": "id_card", "storage_key": "irrelevant"}
        )
        with self.assertRaises(ValidationError):
            document.action_reject(reason="   ")

    def test_action_reject_records_reason_and_status(self):
        driver = self._make_driver()
        document = self.env["babana.driver.document"].create(
            {"driver_id": driver.id, "document_type": "id_card", "storage_key": "irrelevant"}
        )
        document.action_reject(reason="Pièce d'identité expirée")
        self.assertEqual(document.verification_status, "rejected")
        self.assertEqual(document.rejection_reason, "Pièce d'identité expirée")

    def test_direct_write_to_rejected_without_reason_is_forbidden(self):
        driver = self._make_driver()
        document = self.env["babana.driver.document"].create(
            {"driver_id": driver.id, "document_type": "id_card", "storage_key": "irrelevant"}
        )
        with self.assertRaises(ValidationError):
            document.write({"verification_status": "rejected"})


# --- Contrôleur : téléversement et URL signée, critères 3, 4 et 5 côté API ----------------------


@tagged("post_install", "-at_install")
class TestDriverDocumentsController(HttpCase):
    @classmethod
    def _request_handler(cls, s, r, **kw):
        if r.url.startswith(_mock_google_base_url()):
            from odoo.tests.common import _super_send

            return _super_send(s, r, **kw)
        return super()._request_handler(s, r, **kw)

    def _sign_in_as_driver(self, sub) -> str:
        token = _mint_google_token(sub=sub, email=f"{sub}@example.invalid")
        response = self.url_open(
            "/api/v1/auth/google",
            data=json.dumps({"idToken": token, "role": "driver"}).encode(),
            headers={"Content-Type": "application/json"},
        )
        return response.json()["accessToken"]

    def _upload(self, access_token, *, document_type, content_type, data, expires_on=None,
                filename="piece.jpg"):
        form = {"documentType": document_type, "contentType": content_type}
        if expires_on:
            form["expiresOn"] = expires_on
        return self.url_open(
            "/api/v1/driver/documents",
            data=form,
            files={"file": (filename, data, content_type)},
            headers={"Authorization": f"Bearer {access_token}"},
        )

    def test_upload_and_fetch_signed_url_round_trip(self):
        token = self._sign_in_as_driver("sub-doc-owner")

        response = self._upload(
            token, document_type="id_card", content_type="image/jpeg", data=_A_JPEG
        )
        self.assertEqual(response.status_code, 201)
        document_id = response.json()["id"]

        url_response = self.url_open(
            f"/api/v1/driver/documents/{document_id}/url",
            headers={"Authorization": f"Bearer {token}"},
        )
        self.assertEqual(url_response.status_code, 200)
        self.assertTrue(url_response.json()["url"])

    def test_signed_url_access_is_journalized_over_a_real_http_call(self):
        # D68 (01-architecture.md §9 decies) : trouvé en construisant le signal de panne du
        # journal d'audit -- _URL_ROUTE portait `readonly=True` alors que `_signed_url` écrit
        # une entrée d'audit (L8-09, critère 1, le seul événement sans transition). Sur une
        # vraie requête HTTP, l'écriture échouait silencieusement (`ReadOnlySqlTransaction`,
        # absorbée par le savepoint de `_babana_record`, critère 3) -- le test de critère 1
        # existant (test_audit_log.py::test_driver_document_access_produces_an_entry) n'exerçait
        # que le chemin back-office (`action_preview`), jamais cette route. Ce test-ci passe
        # PAR LA VRAIE ROUTE, comme un chauffeur réel, plutôt que par un appel Python direct.
        token = self._sign_in_as_driver("sub-doc-audit")
        response = self._upload(
            token, document_type="id_card", content_type="image/jpeg", data=_A_JPEG
        )
        document_id = response.json()["id"]

        url_response = self.url_open(
            f"/api/v1/driver/documents/{document_id}/url",
            headers={"Authorization": f"Bearer {token}"},
        )
        self.assertEqual(url_response.status_code, 200)

        entries = self.env["babana.audit.log"].sudo().search(
            [
                ("model_name", "=", "babana.driver.document"),
                ("res_id", "=", document_id),
                ("event", "=", "driver_document.access"),
            ]
        )
        self.assertTrue(
            entries,
            "l'accès à l'URL signée, par la vraie route HTTP, doit produire une entrée de "
            "journal -- pas seulement le chemin back-office",
        )
        health = self.env["babana.audit.log.health"].create({})
        self.assertFalse(
            health.has_failure,
            "cette route ne doit plus échouer à journaliser depuis que readonly=False (D68)",
        )

    # --- Critère 3 : un chauffeur ne peut pas obtenir l'URL du document d'un autre -------------

    def test_driver_cannot_get_url_for_another_drivers_document(self):
        # D54 : le lookup passe par l'appelant -- le document d'un autre chauffeur ne lui est
        # pas visible du tout : DOCUMENT_NOT_FOUND (404), pas DOCUMENT_NOT_OWNED (403). On ne
        # confirme pas qu'il existe.
        owner_token = self._sign_in_as_driver("sub-doc-owner-2")
        upload_response = self._upload(
            owner_token, document_type="id_card", content_type="image/jpeg", data=_A_JPEG
        )
        document_id = upload_response.json()["id"]

        other_token = self._sign_in_as_driver("sub-doc-stranger")
        response = self.url_open(
            f"/api/v1/driver/documents/{document_id}/url",
            headers={"Authorization": f"Bearer {other_token}"},
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error"]["code"], "DOCUMENT_NOT_FOUND")

    # --- Critère 4 : un fichier dont le MIME réel ne correspond pas au type déclaré échoue -----

    def test_declared_mime_type_not_matching_real_content_is_rejected(self):
        token = self._sign_in_as_driver("sub-doc-mime-mismatch")

        response = self._upload(
            token,
            document_type="id_card",
            content_type="image/jpeg",
            data=_A_PDF,  # contenu réellement un PDF, déclaré comme JPEG
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "DOCUMENT_TYPE_MISMATCH")

    # --- Critère 5 : la date d'expiration du permis est obligatoire (API) ----------------------

    def test_license_upload_without_expires_on_is_a_validation_error(self):
        token = self._sign_in_as_driver("sub-doc-license-no-expiry")

        response = self._upload(
            token, document_type="license", content_type="image/png", data=_A_PNG
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "VALIDATION_ERROR")

    def test_license_upload_with_expires_on_succeeds(self):
        token = self._sign_in_as_driver("sub-doc-license-with-expiry")

        response = self._upload(
            token,
            document_type="license",
            content_type="image/png",
            data=_A_PNG,
            expires_on="2027-01-01",
        )

        self.assertEqual(response.status_code, 201)

    # --- L6-15, critères 3 et 5 : GET /driver/documents renvoie l'état de chaque document ------

    def test_list_documents_returns_status_per_type(self):
        token = self._sign_in_as_driver("sub-doc-list")
        self._upload(token, document_type="id_card", content_type="image/jpeg", data=_A_JPEG)
        self._upload(
            token, document_type="license", content_type="image/png", data=_A_PNG,
            expires_on="2030-01-01",
        )

        response = self.url_open(
            "/api/v1/driver/documents", headers={"Authorization": f"Bearer {token}"}
        )
        self.assertEqual(response.status_code, 200)
        by_type = {d["documentType"]: d for d in response.json()["documents"]}
        self.assertEqual(set(by_type), {"id_card", "license"})
        self.assertEqual(by_type["id_card"]["verificationStatus"], "pending")
        self.assertIsNone(by_type["id_card"]["rejectionReason"])
        self.assertEqual(by_type["license"]["expiresOn"], "2030-01-01")
        self.assertTrue(by_type["license"]["uploadedAt"].endswith("Z"))

    def test_list_documents_shows_only_the_latest_per_type(self):
        # Un document renvoyé après rejet ajoute une ligne (l'upload crée toujours) : la liste
        # ne doit en montrer qu'une par type, la plus récente (L6-15).
        token = self._sign_in_as_driver("sub-doc-list-latest")
        self._upload(token, document_type="id_card", content_type="image/jpeg", data=_A_JPEG)
        self._upload(token, document_type="id_card", content_type="image/png", data=_A_PNG)

        documents = self.url_open(
            "/api/v1/driver/documents", headers={"Authorization": f"Bearer {token}"}
        ).json()["documents"]
        id_cards = [d for d in documents if d["documentType"] == "id_card"]
        self.assertEqual(len(id_cards), 1, "un seul état par type -- le plus récent")

    def test_list_documents_requires_a_driver_account(self):
        token = _mint_google_token(sub="sub-doc-list-client", email="c@example.invalid")
        access_token = self.url_open(
            "/api/v1/auth/google",
            data=json.dumps({"idToken": token, "role": "client"}).encode(),
            headers={"Content-Type": "application/json"},
        ).json()["accessToken"]

        response = self.url_open(
            "/api/v1/driver/documents", headers={"Authorization": f"Bearer {access_token}"}
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "UNAUTHORIZED")


# --- L6-15, critère 3 : le motif de rejet remonte tel quel dans la projection JSON -------------


@tagged("post_install", "-at_install")
class TestDriverDocumentProjection(TransactionCase):
    def test_rejected_document_projection_carries_its_reason(self):
        from ..controllers.documents import DriverDocumentsController

        employee = self.env["hr.employee"].create({"name": "Chauffeur projection"})
        driver = self.env["babana.driver"].create({"employee_id": employee.id})
        document = self.env["babana.driver.document"].create(
            {"driver_id": driver.id, "document_type": "id_card", "storage_key": "irrelevant"}
        )
        document.action_reject(reason="Pièce illisible")

        projected = DriverDocumentsController._project_document(document)
        self.assertEqual(projected["verificationStatus"], "rejected")
        self.assertEqual(projected["rejectionReason"], "Pièce illisible")

        document.action_verify()
        self.assertIsNone(DriverDocumentsController._project_document(document)["rejectionReason"])
