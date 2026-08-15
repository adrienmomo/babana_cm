# Stockage des documents chauffeur (L1-05), S3 via boto3 -- compatible MinIO en développement
# (D19), un vrai S3 (ou équivalent) en production, sans branche conditionnelle : seules les
# variables d'environnement S3_* changent (infra/compose.yaml).
#
# Aucun objet n'est public (compartiment babana-documents créé sans accès anonyme par
# infra/minio/bootstrap.sh, L0-01). Toute lecture passe par generate_signed_url() : une URL
# signée à durée limitée, jamais un accès direct à la clé de l'objet.
from __future__ import annotations

import os
import uuid

import boto3
from botocore.client import Config as BotoConfig

DOCUMENT_URL_TTL_SECONDS_PARAM = "babana.document_url_ttl_seconds"
DOCUMENT_URL_TTL_SECONDS_FALLBACK = 300  # « quelques minutes » (amoa/specs/L1-identite.md, L1-05)

DOCUMENT_MAX_UPLOAD_BYTES_PARAM = "babana.document_max_upload_bytes"
DOCUMENT_MAX_UPLOAD_BYTES_FALLBACK = 10 * 1024 * 1024  # 10 Mio, plausible pour un scan de pièce.

# Signatures de fichier (nombre magique), pas l'extension ni un en-tête Content-Type déclaré par
# l'appelant (critère d'acceptation 4 de L1-05) -- suffisant pour le seul usage réel ici, des
# scans de permis et de pièce d'identité (JPEG, PNG, PDF). Pas de dépendance nouvelle pour ça :
# python-magic exigerait libmagic sur l'image du conteneur pour trois signatures fixes.
_MAGIC_SIGNATURES = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"%PDF-", "application/pdf"),
)


def sniff_mime_type(data: bytes) -> str | None:
    for signature, mime_type in _MAGIC_SIGNATURES:
        if data.startswith(signature):
            return mime_type
    return None


def _client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT"],
        aws_access_key_id=os.environ["S3_ACCESS_KEY"],
        aws_secret_access_key=os.environ["S3_SECRET_KEY"],
        config=BotoConfig(signature_version="s3v4"),
        # MinIO ignore la région mais boto3 exige une valeur non vide pour signer la requête.
        region_name="us-east-1",
    )


def _bucket() -> str:
    return os.environ["S3_BUCKET"]


def build_storage_key(driver_id: int, document_type: str, filename: str) -> str:
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
    # uuid4, pas le nom de fichier original : un nom fourni par le client ne doit jamais devenir
    # un chemin d'objet (traversée de chemin, collision, caractères non postés).
    return f"drivers/{driver_id}/{document_type}/{uuid.uuid4().hex}.{extension}"


def upload(key: str, data: bytes, content_type: str) -> None:
    _client().put_object(Bucket=_bucket(), Key=key, Body=data, ContentType=content_type)


def generate_signed_url(key: str, *, ttl_seconds: int) -> str:
    return _client().generate_presigned_url(
        "get_object", Params={"Bucket": _bucket(), "Key": key}, ExpiresIn=ttl_seconds
    )


def default_url_ttl_seconds(env) -> int:
    return int(
        env["ir.config_parameter"]
        .sudo()
        .get_param(DOCUMENT_URL_TTL_SECONDS_PARAM, DOCUMENT_URL_TTL_SECONDS_FALLBACK)
    )


def default_max_upload_bytes(env) -> int:
    return int(
        env["ir.config_parameter"]
        .sudo()
        .get_param(DOCUMENT_MAX_UPLOAD_BYTES_PARAM, DOCUMENT_MAX_UPLOAD_BYTES_FALLBACK)
    )
