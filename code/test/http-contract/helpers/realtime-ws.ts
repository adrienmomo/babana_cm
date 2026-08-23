// Client WebSocket minimal contre le vrai service temps réel (C-01, critère 6). Précondition
// C-03 (L3-17) : select-driver refuse un chauffeur qui n'est jamais réellement passé en ligne,
// ou qu'un client n'a jamais vu dans sa propre liste nearby.drivers -- même mécanisme, même
// raison que services/odoo/addons/babana/tests/_realtime_ws.py côté Python, transposé ici en
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

/** S'abonne à nearby.drivers en tant que client jusqu'à voir apparaître le chauffeur visé --
 * c'est cette réception qui pose la précondition C-03 côté serveur, pas un raccourci de test qui
 * la contournerait. Un lecteur ne suppose jamais que la trame suivante est celle qu'il attend
 * (C-02, règle du 24 août) : on filtre par type, jamais un `once('message')` nu -- l'accusé de
 * réception de nearby.subscribe (23 août) précède toujours nearby.drivers. */
export async function makeDriverVisibleToClient(
  clientToken: string,
  driverPublicId: string,
  position: Position,
  options: { radiusMeters?: number; attempts?: number; retryDelayMs?: number } = {}
): Promise<void> {
  const radiusMeters = options.radiusMeters ?? 5_000;
  const attempts = options.attempts ?? 8;
  const retryDelayMs = options.retryDelayMs ?? 2_000;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const socket = await connect(clientToken);
    let seen = false;
    try {
      send(socket, 'nearby.subscribe', { position, radiusMeters });
      seen = await new Promise<boolean>((resolve) => {
        const deadline = setTimeout(() => resolve(false), retryDelayMs);
        socket.addEventListener('message', (event) => {
          let message: { type?: string; payload?: { drivers?: Array<{ driverId?: string }> } };
          try {
            message = JSON.parse(String((event as MessageEvent).data));
          } catch {
            return;
          }
          if (message.type !== 'nearby.drivers') return;
          clearTimeout(deadline);
          resolve((message.payload?.drivers ?? []).some((d) => d.driverId === driverPublicId));
        });
      });
    } finally {
      socket.close();
    }
    if (seen) return;
    if (attempt < attempts - 1) await sleep(retryDelayMs);
  }
  throw new Error(
    `chauffeur ${driverPublicId} jamais apparu dans nearby.drivers après ${attempts} tentatives -- ` +
      'vérifier qu\'il est bien en ligne, positionné, et dans le rayon interrogé'
  );
}
