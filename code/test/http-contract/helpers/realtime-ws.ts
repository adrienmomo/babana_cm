// Client WebSocket minimal contre le vrai service temps réel (C-01, critère 6). La commande d'une
// course part au chauffeur disponible le plus proche : un chauffeur qui n'est jamais réellement
// passé en ligne n'est pas dans le vivier -- même raison que
// services/odoo/addons/babana/tests/_realtime_ws.py côté Python, transposé ici en
// TypeScript avec le WebSocket natif de Node (déjà utilisé par test/auth/token-handshake.test.ts,
// aucune dépendance ajoutée -- CLAUDE.md, "pas de dépendance nouvelle sans nécessité").
import { randomUUID } from 'node:crypto';

const REALTIME_WS_ROOT = process.env.REALTIME_WS_ROOT ?? 'ws://localhost:3000';

function envelope(type: string, payload: unknown) {
  return { type, id: randomUUID(), emittedAt: new Date().toISOString(), payload };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connect(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${REALTIME_WS_ROOT}/rt/ws?token=${token}`);
    const timeout = setTimeout(() => reject(new Error('connexion WebSocket : délai dépassé')), 10_000);
    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('connexion WebSocket refusée'));
    });
  });
}

function send(socket: WebSocket, type: string, payload: unknown): void {
  socket.send(JSON.stringify(envelope(type, payload)));
}

interface Position {
  latitude: number;
  longitude: number;
}

/** Fait réellement passer un chauffeur en ligne et émettre une position, par le chemin réel
 * (WebSocket, L3-01/L3-02/L3-04) -- jamais une écriture Redis directe, qui contournerait tout ce
 * que ce câblage est censé prouver. */
export async function bringDriverOnline(driverToken: string, position: Position): Promise<void> {
  const socket = await connect(driverToken);
  try {
    send(socket, 'availability.set', { online: true });
    send(socket, 'position.update', {
      ...position,
      accuracyMeters: 10,
      speedMetersPerSecond: 0,
      headingDegrees: 0,
    });
    // Ni l'un ni l'autre message ne produit de réponse -- laisser le temps au serveur de les
    // traiter avant de fermer la connexion (même délai que le client Python équivalent).
    await sleep(1000);
  } finally {
    socket.close();
  }
}
