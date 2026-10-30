import { createRealtimeClient, type WebSocketLike } from '../../src/realtime/connection';
import { createInMemoryActionQueue } from '../../src/realtime/queue';

const OPEN = 1;
const CLOSED = 3;

class FakeSocket implements WebSocketLike {
  readyState = OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000) {
    this.readyState = CLOSED;
    this.onclose?.({ code });
  }

  /** Simule l'ouverture réelle du socket -- appelée par le test, pas automatiquement : le vrai
   * réseau n'ouvre pas instantanément non plus. */
  simulateOpen() {
    this.onopen?.();
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose(code: number) {
    this.readyState = CLOSED;
    this.onclose?.({ code });
  }
}

function baseConfig(overrides: Partial<Parameters<typeof createRealtimeClient>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const createWebSocket = jest.fn(() => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });

  return {
    sockets,
    createWebSocket,
    config: {
      url: 'wss://realtime.test',
      createWebSocket,
      getAccessToken: jest.fn().mockResolvedValue('token-1'),
      queueStorage: createInMemoryActionQueue(),
      wait: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    },
  };
}

describe('createRealtimeClient -- connexion et resynchronisation (L6-04, L3-11)', () => {
  it('envoie session.resync dès l\'ouverture, avant de rejouer la file', async () => {
    const { sockets, config } = baseConfig();
    const client = createRealtimeClient(config);

    await client.connect();
    sockets[0].simulateOpen();
    await Promise.resolve(); // laisse replayQueue() (async) démarrer

    const firstSent = JSON.parse(sockets[0].sent[0]);
    expect(firstSent.type).toBe('session.resync');
  });

  it('porte le jeton en paramètre de requête à la connexion (D23, forme du jeton)', async () => {
    const { createWebSocket, config } = baseConfig();
    const client = createRealtimeClient(config);

    await client.connect();

    expect(createWebSocket).toHaveBeenCalledWith('wss://realtime.test?token=token-1');
  });

  it('expose l\'état de connexion aux écrans (spécification, L6-16)', async () => {
    const states: string[] = [];
    const { sockets, config } = baseConfig({ onConnectionStateChange: (s) => states.push(s) });
    const client = createRealtimeClient(config);

    await client.connect();
    sockets[0].simulateOpen();

    expect(states).toEqual(['connecting', 'connected']);
    expect(client.getState()).toBe('connected');
  });

  it('un message entrant valide est transmis à onMessage', async () => {
    const onMessage = jest.fn();
    const { sockets, config } = baseConfig({ onMessage });
    const client = createRealtimeClient(config);
    await client.connect();
    sockets[0].simulateOpen();

    sockets[0].simulateMessage({
      type: 'ride.assigned',
      id: '11111111-1111-4111-8111-111111111111',
      emittedAt: '2026-01-01T00:00:00Z',
      payload: {
        rideId: '22222222-2222-4222-8222-222222222222',
        driverId: '33333333-3333-4333-8333-333333333333',
        firstName: 'Paul',
        photoUrl: null,
        motorcycleClass: 'standard',
        licensePlate: 'LT-1234-BC',
        phoneNumber: '+237691234567',
      },
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'ride.assigned' }));
  });
});

describe('createRealtimeClient -- file d\'actions hors connexion (critères 2 et 4)', () => {
  it('une action métier émise hors connexion est mise en file, puis rejouée à la reconnexion, avec son identifiant d\'origine (critère 2 ; 3, 5)', async () => {
    const { sockets, config } = baseConfig();
    const client = createRealtimeClient(config);
    // Jamais connecté -- aucun socket ouvert.

    // `availability.set` : une vraie décision durable (passer en/hors ligne), pas une déclaration
    // d'intérêt courant -- contrairement à `proposal.accept`/`proposal.reject` (L6-16, "actions
    // interdites hors connexion"), qui ne sont plus mis en file du tout depuis ce soir (voir le
    // test ci-dessous).
    client.send('availability.set', { online: true });

    await client.connect();
    sockets[0].simulateOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sent = sockets[0].sent.map((raw) => JSON.parse(raw));
    expect(sent[0].type).toBe('session.resync');
    expect(sent[1].type).toBe('availability.set');
    // L'identifiant d'origine (posé à l'émission hors connexion) est conservé.
    expect(sent[1].id).toEqual(expect.any(String));
    expect(sent[1].id).toBe(sent[1].id);
  });

  // L3-20 (30 août) -- cause racine du silence de diffusion : `nearby.subscribe`, `ride.track`
  // (et leur pendant `nearby.unsubscribe`) sont des déclarations d'intérêt courant, jamais des
  // actions métier. L'écran appelant les réémet déjà lui-même à chaque `connected`
  // (`onRealtimeConnectionStateChange`) -- les mettre en file les faisait rejouer une SECONDE
  // fois, avec des paramètres capturés au moment de l'émission d'origine, potentiellement
  // périmés au moment du rejeu. Les deux envois arrivaient alors en course côté service, et
  // rien ne garantissait que le plus récent gagne (`amoa/questions/
  // L3-05-nearby-list-goes-silently-empty.md`).
  it('nearby.subscribe, nearby.unsubscribe et ride.track ne sont jamais mis en file hors connexion (L3-20)', async () => {
    const { sockets, config } = baseConfig();
    const client = createRealtimeClient(config);
    // Jamais connecté -- aucun socket ouvert.

    client.send('nearby.subscribe', { position: { latitude: 4.05, longitude: 9.7 }, radiusMeters: 3000, excludeDriverIds: [] });
    client.send('nearby.unsubscribe', {});
    client.send('ride.track', { rideId: 'r1' });
    client.send('availability.set', { online: true }); // témoin : une vraie action métier, elle, doit survivre

    await client.connect();
    sockets[0].simulateOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sentTypes = sockets[0].sent.map((raw) => JSON.parse(raw).type);
    expect(sentTypes).toEqual(['session.resync', 'availability.set']);
  });

  it("proposal.accept et proposal.reject ne sont jamais mis en file hors connexion (L6-16, \"actions interdites hors connexion\")", async () => {
    // Garde défensive (connection.ts, commentaire de NEVER_QUEUED_MESSAGE_TYPES) : l'écran
    // appelant (ProposalScreen.tsx) doit refuser ces actions avant même d'appeler send() --
    // ce test prouve que, même si ce garde-fou applicatif était contourné, le client partagé
    // n'irait pas rejouer une acceptation ou un refus bien plus tard, pour une proposition
    // probablement déjà expirée ou attribuée à quelqu'un d'autre.
    const { sockets, config } = baseConfig();
    const client = createRealtimeClient(config);
    // Jamais connecté -- aucun socket ouvert.

    client.send('proposal.accept', { rideId: 'r1' });
    client.send('proposal.reject', { rideId: 'r2' });
    client.send('availability.set', { online: true }); // témoin : une vraie action métier, elle, doit survivre

    await client.connect();
    sockets[0].simulateOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sentTypes = sockets[0].sent.map((raw) => JSON.parse(raw).type);
    expect(sentTypes).toEqual(['session.resync', 'availability.set']);
  });

  it('route.share et chat.send ne sont jamais mis en file hors connexion (un tracé ou un « sur place » rejoué plus tard serait faux)', async () => {
    const { sockets, config } = baseConfig();
    const client = createRealtimeClient(config);

    const point = { latitude: 4.05, longitude: 9.76 };
    client.send('route.share', { rideId: 'r1', phase: 'approach', points: [point, point], distanceMeters: null, durationSeconds: null });
    client.send('chat.send', { rideId: 'r1', code: 'driver_outside' });
    client.send('availability.set', { online: true }); // témoin

    await client.connect();
    sockets[0].simulateOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sockets[0].sent.map((raw) => JSON.parse(raw).type)).toEqual(['session.resync', 'availability.set']);
  });

  it('les positions ne sont jamais mises en file -- seule la dernière compte (critère 4)', async () => {
    const { sockets, config } = baseConfig();
    const client = createRealtimeClient(config);

    client.send('position.update', { latitude: 1, longitude: 1, accuracyMeters: 5, speedMetersPerSecond: null, headingDegrees: null, precedingSamples: [] });
    client.send('position.update', { latitude: 2, longitude: 2, accuracyMeters: 5, speedMetersPerSecond: null, headingDegrees: null, precedingSamples: [] });

    await client.connect();
    sockets[0].simulateOpen();
    await Promise.resolve();

    const sent = sockets[0].sent.map((raw) => JSON.parse(raw));
    const positions = sent.filter((m) => m.type === 'position.update');
    expect(positions).toHaveLength(1);
    expect(positions[0].payload.latitude).toBe(2); // seule la dernière
  });
});

describe('createRealtimeClient -- reconnexion (critère 1 ; L3-01)', () => {
  it('une coupure ordinaire déclenche une reconnexion avec temporisation', async () => {
    const { sockets, config } = baseConfig();
    const client = createRealtimeClient(config);
    await client.connect();
    sockets[0].simulateOpen();

    sockets[0].simulateClose(1006); // coupure anormale, code générique

    await Promise.resolve();
    await Promise.resolve();

    expect(config.wait).toHaveBeenCalled();
    expect(config.createWebSocket).toHaveBeenCalledTimes(2); // reconnexion automatique
  });

  it('un jeton expiré (WS_CLOSE_TOKEN_EXPIRED) prévient l\'appelant et relit un jeton frais à la reconnexion', async () => {
    const onTokenExpired = jest.fn();
    const getAccessToken = jest.fn().mockResolvedValueOnce('token-1').mockResolvedValueOnce('token-2');
    const { sockets, config } = baseConfig({ onTokenExpired, getAccessToken });
    const client = createRealtimeClient(config);
    await client.connect();
    sockets[0].simulateOpen();

    sockets[0].simulateClose(4402); // WS_CLOSE_TOKEN_EXPIRED

    await Promise.resolve();
    await Promise.resolve();

    expect(onTokenExpired).toHaveBeenCalledTimes(1);
    expect(config.createWebSocket).toHaveBeenLastCalledWith('wss://realtime.test?token=token-2');
  });

  it('un jeton invalide (WS_CLOSE_UNAUTHENTICATED) ne déclenche aucune reconnexion automatique', async () => {
    const onUnauthenticated = jest.fn();
    const { sockets, config } = baseConfig({ onUnauthenticated });
    const client = createRealtimeClient(config);
    await client.connect();
    sockets[0].simulateOpen();

    sockets[0].simulateClose(4401); // WS_CLOSE_UNAUTHENTICATED

    await Promise.resolve();
    await Promise.resolve();

    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(config.createWebSocket).toHaveBeenCalledTimes(1); // pas de second appel
    expect(config.wait).not.toHaveBeenCalled();
  });

  it('disconnect() empêche toute reconnexion automatique après une fermeture demandée', async () => {
    const { sockets, config } = baseConfig();
    const client = createRealtimeClient(config);
    await client.connect();
    sockets[0].simulateOpen();

    client.disconnect();
    await Promise.resolve();

    expect(config.createWebSocket).toHaveBeenCalledTimes(1);
    expect(client.getState()).toBe('offline');
  });
});

describe("createRealtimeClient -- horloge du serveur (positions datées sans dépendre de l'heure du téléphone)", () => {
  // Constaté le 30 octobre : deux émulateurs avec 3 h 30 de retard. Toutes les positions du
  // chauffeur étaient rejetées comme trop anciennes par la validation de plausibilité (L3-02) --
  // en ligne, mais jamais dans le pool. L'heure du téléphone ne doit plus compter : seul l'écart
  // avec le serveur, appris des messages qu'il envoie (tous datés par son horloge), sert à dater.
  const SERVER_NOW = Date.parse('2026-10-30T16:30:00.000Z');
  const PHONE_LAG_MS = 3.5 * 60 * 60 * 1000;

  function ack(emittedAtMs: number) {
    return { type: 'ride.track.ack', id: '11111111-1111-4111-8111-111111111111', emittedAt: new Date(emittedAtMs).toISOString(), payload: { broadcastIntervalMs: 10_000 } };
  }

  function lastSent(socket: FakeSocket) {
    return JSON.parse(socket.sent[socket.sent.length - 1]);
  }

  const POSITION = { latitude: 4.05, longitude: 9.7, accuracyMeters: 5, speedMetersPerSecond: null, headingDegrees: null, precedingSamples: [] };

  it('un téléphone en retard de 3 h 30 date ses positions à l’heure du serveur dès le premier message reçu', async () => {
    let phoneNow = SERVER_NOW - PHONE_LAG_MS;
    const { sockets, config } = baseConfig({ now: () => phoneNow });
    const client = createRealtimeClient(config);
    await client.connect();
    sockets[0].simulateOpen();

    sockets[0].simulateMessage(ack(SERVER_NOW));
    phoneNow += 2_000;
    client.send('position.update', POSITION);

    expect(Date.parse(lastSent(sockets[0]).emittedAt)).toBe(SERVER_NOW + 2_000);
    expect(client.serverNow()).toBe(SERVER_NOW + 2_000);
  });

  it('un message serveur rejoué avec sa date d’origine ne recule pas l’estimation (on garde l’écart le plus grand)', async () => {
    const phoneNow = SERVER_NOW - PHONE_LAG_MS;
    const { sockets, config } = baseConfig({ now: () => phoneNow });
    const client = createRealtimeClient(config);
    await client.connect();
    sockets[0].simulateOpen();

    sockets[0].simulateMessage(ack(SERVER_NOW));
    sockets[0].simulateMessage(ack(SERVER_NOW - 60_000)); // proposition rejouée à la resynchronisation

    expect(client.serverNow()).toBe(SERVER_NOW);
  });

  it('sans aucun message du serveur, l’heure du téléphone est utilisée telle quelle', async () => {
    const phoneNow = SERVER_NOW - PHONE_LAG_MS;
    const { config } = baseConfig({ now: () => phoneNow });
    const client = createRealtimeClient(config);
    expect(client.serverNow()).toBe(phoneNow);
  });

  it('une nouvelle connexion réapprend l’écart : un téléphone remis à l’heure entre-temps n’est pas daté dans le futur', async () => {
    let phoneNow = SERVER_NOW - PHONE_LAG_MS;
    const { sockets, config } = baseConfig({ now: () => phoneNow });
    const client = createRealtimeClient(config);
    await client.connect();
    sockets[0].simulateOpen();
    sockets[0].simulateMessage(ack(SERVER_NOW));

    sockets[0].simulateClose(1006);
    await Promise.resolve();
    await Promise.resolve();
    phoneNow = SERVER_NOW + 5_000; // le téléphone s'est remis à l'heure pendant la coupure
    // Avant le premier message de la nouvelle connexion, l'estimation précédente reste la meilleure.
    sockets[1].simulateOpen();
    sockets[1].simulateMessage(ack(SERVER_NOW + 5_000));

    expect(client.serverNow()).toBe(SERVER_NOW + 5_000);
  });

  it('une position mise de côté hors connexion garde sa date : renvoyée plus tard, elle reste reconnaissable comme ancienne', async () => {
    let phoneNow = SERVER_NOW - PHONE_LAG_MS;
    const { sockets, config } = baseConfig({ now: () => phoneNow });
    const client = createRealtimeClient(config);
    await client.connect();
    sockets[0].simulateOpen();
    sockets[0].simulateMessage(ack(SERVER_NOW));

    sockets[0].simulateClose(1006);
    client.send('position.update', POSITION); // hors connexion : retenue, pas envoyée
    phoneNow += 120_000;
    await Promise.resolve();
    await Promise.resolve();
    sockets[1].simulateOpen();

    const replayed = sockets[1].sent.map((raw) => JSON.parse(raw)).find((m) => m.type === 'position.update');
    expect(Date.parse(replayed.emittedAt)).toBe(SERVER_NOW);
  });
});
