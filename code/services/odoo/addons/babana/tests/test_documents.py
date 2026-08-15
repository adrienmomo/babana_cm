# Tests des documents chauffeur (L1-05) : stockage S3/MinIO privé, URL signée, MIME réel.
from __future__ import annotations

import json
import os
import time

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

    # --- Critère 3 : un chauffeur ne peut pas obtenir l'URL du document d'un autre -------------

    def test_driver_cannot_get_url_for_another_drivers_document(self):
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

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "DOCUMENT_NOT_OWNED")

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
