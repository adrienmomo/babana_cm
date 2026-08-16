# Client Redis minimal, pour les fixtures de test uniquement (L3-17) -- même raisonnement que
# _realtime_ws.py : aucun client Redis dans l'image Odoo (invariant 1, services/odoo n'a et ne
# doit avoir aucune dépendance Redis), et ajouter une bibliothèque pour un unique besoin de test
# irait contre CLAUDE.md ("pas de dépendance nouvelle sans nécessité"). Une seule commande RESP
# (`SET`) suffit : le protocole tient en quelques lignes, pas besoin d'un client complet.
#
# Sert UNIQUEMENT à seeder `babana:driver:profile:<id>` (redis/driver-profiles.ts) -- champ-pont
# documenté (amoa/questions/L3-05.md, code/docs/bridge-fields.md) : "setDriverProfile n'est
# appelé ce soir que par les tests, qui seedent directement le cache" (même principe déjà en
# vigueur côté TypeScript, test/nearby.test.ts). Rien d'autre : ni la réservation, ni le pool, ni
# l'engagement ne doivent jamais être manipulés directement par un test -- eux passent réellement
# par le service temps réel (_realtime_ws.py), pour prouver le câblage plutôt que le contourner.
from __future__ import annotations

import json
import os
import socket


def _redis_host_port() -> tuple[str, int]:
    url = os.environ.get("REDIS_URL", "redis://redis:6379")
    without_scheme = url.split("://", 1)[-1]
    host, _, port = without_scheme.partition(":")
    return host, int(port or 6379)


def _resp_command(*parts: str) -> bytes:
    encoded = [p.encode() for p in parts]
    out = f"*{len(encoded)}\r\n".encode()
    for part in encoded:
        out += f"${len(part)}\r\n".encode() + part + b"\r\n"
    return out


def redis_set(key: str, value: str, timeout: float = 5.0) -> None:
    host, port = _redis_host_port()
    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.sendall(_resp_command("SET", key, value))
        reply = sock.recv(4096)
        if not reply.startswith(b"+OK"):
            raise RuntimeError(f"SET a échoué : {reply!r}")


def seed_driver_profile(
    driver_public_id: str,
    *,
    first_name: str = "Chauffeur",
    photo_url: str | None = None,
    rating: float = 4.5,
    motorcycle_class: str = "standard",
) -> None:
    """Seede le profil chauffeur en cache (L3-05/L3-16, champ-pont) -- sans lui, `nearby.drivers`
    omet TOUJOURS ce chauffeur (jamais une valeur inventée, amoa/questions/L3-05.md), et la
    précondition C-03 (L3-17, critère 8) ne peut alors jamais être satisfaite pour aucun chauffeur
    réel tant que L3-16 (canal de profil Odoo -> temps réel) n'existe pas."""
    profile = {
        "firstName": first_name,
        "photoUrl": photo_url,
        "rating": rating,
        "motorcycleClass": motorcycle_class,
    }
    redis_set(f"babana:driver:profile:{driver_public_id}", json.dumps(profile))
