# Client WebSocket minimal, pour les fixtures de test uniquement (L3-17). Aucune bibliothèque
# WebSocket n'est disponible dans l'image Odoo (`requests` seul est installé, services/odoo/
# Dockerfile) -- plutôt que d'ajouter une dépendance pour un unique besoin de test (CLAUDE.md,
# "pas de dépendance nouvelle sans nécessité"), ce module implémente la poignée de main RFC 6455
# et le cadrage de trame minimal (texte, non fragmenté, payload court) dont ces fixtures ont
# besoin -- rien de plus : pas de ping/pong, pas de fragmentation, pas de fermeture propre.
#
# Depuis L3-17, `select-driver` réserve réellement via le service temps réel (D26) : un chauffeur
# qui n'est jamais passé en ligne, ou un client qui n'a jamais vu ce chauffeur dans sa liste des 5
# (précondition C-03, critère 8), ne peut plus être sélectionné par une simple création RPC de
# `babana.driver` -- il faut le faire *réellement* passer en ligne et émettre une position, comme
# l'application le ferait.
from __future__ import annotations

import base64
import json
import os
import socket
import struct
import time
import uuid
from urllib.parse import urlparse


def _realtime_ws_url() -> str:
    base = os.environ.get("REALTIME_INTERNAL_URL", "http://realtime:3000")
    return base.replace("http://", "ws://").replace("https://", "wss://") + "/rt/ws"


def _connect(token: str, timeout: float = 5.0) -> socket.socket:
    parsed = urlparse(f"{_realtime_ws_url()}?token={token}")
    host, port = parsed.hostname, parsed.port or 80
    sock = socket.create_connection((host, port), timeout=timeout)
    key = base64.b64encode(os.urandom(16)).decode()
    path = parsed.path + (f"?{parsed.query}" if parsed.query else "")
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    )
    sock.sendall(request.encode())
    response = sock.recv(4096)
    status_line = response.split(b"\r\n", 1)[0]
    if b" 101 " not in status_line:
        raise RuntimeError(f"poignée de main WebSocket échouée : {status_line!r}")
    return sock


def _send_message(sock: socket.socket, message_type: str, payload: dict) -> None:
    envelope = {
        "type": message_type,
        "id": str(uuid.uuid4()),
        "emittedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "payload": payload,
    }
    data = json.dumps(envelope).encode()
    mask = os.urandom(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    length = len(data)
    if length < 126:
        header = struct.pack("!BB", 0x81, 0x80 | length)
    elif length < 65536:
        header = struct.pack("!BBH", 0x81, 0x80 | 126, length)
    else:
        raise ValueError("message de test trop volumineux pour ce client WebSocket minimal")
    sock.sendall(header + mask + masked)


def _read_message(sock: socket.socket, timeout: float = 5.0) -> dict | None:
    """Lit UNE trame texte non fragmentée, jamais masquée côté serveur (RFC 6455) -- suffisant
    pour les messages courts (`nearby.drivers`) que ces fixtures ont besoin de lire. `None` si
    rien n'arrive avant `timeout`."""
    sock.settimeout(timeout)
    try:
        header = sock.recv(2)
    except (socket.timeout, TimeoutError):
        return None
    if len(header) < 2:
        return None
    length = header[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", sock.recv(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", sock.recv(8))[0]
    payload = b""
    while len(payload) < length:
        chunk = sock.recv(length - len(payload))
        if not chunk:
            break
        payload += chunk
    try:
        return json.loads(payload.decode())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def bring_driver_online(driver_token: str, latitude: float, longitude: float) -> None:
    """Fait réellement passer un chauffeur en ligne et émettre une position, par le chemin réel
    (WebSocket, L3-01/L3-02/L3-04) -- pas une écriture Redis directe, qui contournerait tout ce
    que ce câblage est censé prouver."""
    sock = _connect(driver_token)
    try:
        _send_message(sock, "availability.set", {"online": True})
        _send_message(
            sock,
            "position.update",
            {
                "latitude": latitude,
                "longitude": longitude,
                "accuracyMeters": 10.0,
                "speedMetersPerSecond": 0.0,
                "headingDegrees": 0.0,
            },
        )
        # Ni l'un ni l'autre message ne produit de réponse -- laisser le temps au serveur de les
        # traiter avant de fermer la connexion (sinon un socket fermé trop tôt peut couper
        # l'écriture Redis en cours côté serveur). Généreux : dispatch() n'est pas attendu par le
        # gestionnaire 'message' du serveur (ws/connection.ts), les deux messages peuvent donc
        # être traités dans un ordre légèrement différent de leur envoi.
        time.sleep(1.0)
    finally:
        sock.close()


def make_driver_visible_to_client(
    client_token: str,
    driver_public_id: str,
    position: dict,
    *,
    radius_meters: float = 5_000,
    attempts: int = 8,
    retry_delay: float = 2.0,
) -> None:
    """S'abonne à `nearby.drivers` en tant que client et attend que le chauffeur visé apparaisse
    dans la liste reçue -- c'est cette réception qui pose la précondition C-03 côté serveur
    (`nearby/last-sent.ts`), pas un raccourci de test qui la contournerait.

    Ré-abonnement actif plutôt qu'une seule attente passive : un nouvel abonnement du même client
    déclenche toujours une diffusion IMMÉDIATE (`nearby/handler.ts::subscribe`, critère 5 de
    L3-05 -- un second abonnement remplace le premier), donc une nouvelle vérification à chaque
    tentative plutôt que de dépendre du minuteur de diffusion périodique en arrière-plan, dont le
    délai peut suffire à faire échouer une seule attente passive sous charge (`npm test` complet,
    beaucoup de connexions WebSocket concurrentes). Bornée à `attempts` : la limitation de débit
    de L3-05 (critère 6, C2b) autorise au plus `NEARBY_RATE_LIMIT_MAX_SUBSCRIPTIONS` abonnements
    par fenêtre glissante -- 8 tentatives espacées de 2 s restent largement en dessous du défaut
    (10 par 60 s)."""
    for attempt in range(attempts):
        sock = _connect(client_token)
        try:
            _send_message(
                sock,
                "nearby.subscribe",
                {"position": position, "radiusMeters": radius_meters},
            )
            message = _read_message(sock, timeout=retry_delay)
            if message and message.get("type") == "nearby.drivers":
                drivers = message.get("payload", {}).get("drivers", [])
                if any(d.get("driverId") == driver_public_id for d in drivers):
                    return
        finally:
            sock.close()
        if attempt < attempts - 1:
            time.sleep(retry_delay)
    raise AssertionError(
        f"chauffeur {driver_public_id} jamais apparu dans nearby.drivers après {attempts} "
        "tentatives -- vérifier qu'il est bien en ligne, positionné, et dans le rayon interrogé"
    )
