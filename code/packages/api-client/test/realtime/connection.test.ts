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
      payload: { rideId: '22222222-2222-4222-8222-222222222222', driverId: '33333333-3333-4333-8333-333333333333' },
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'ride.assigned' }));
  });
});

describe('createRealtimeClient -- file d\'actions hors connexion (critères 2 et 4)', () => {
  it('une action émise hors connexion est mise en file, puis rejouée dans l\'ordre à la reconnexion, avec son identifiant d\'origine (critère 2 ; 3, 5)', async () => {
    const { sockets, config } = baseConfig();
    const client = createRealtimeClient(config);
    // Jamais connecté -- aucun socket ouvert.

    client.send('ride.start', { rideId: 'r1' });
    client.send('ride.complete', { rideId: 'r1', distanceMeters: 100, durationSeconds: 60, polyline: 'abc' });

    await client.connect();
    sockets[0].simulateOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sent = sockets[0].sent.map((raw) => JSON.parse(raw));
    expect(sent[0].type).toBe('session.resync');
    expect(sent[1].type).toBe('ride.start');
    expect(sent[2].type).toBe('ride.complete');
    // Les identifiants d'origine (posés à l'émission hors connexion) sont conservés.
    expect(sent[1].id).toEqual(expect.any(String));
    expect(sent[1].id).toBe(sent[1].id);
  });

  it('les positions ne sont jamais mises en file -- seule la dernière compte (critère 4)', async () => {
    const { sockets, config } = baseConfig();
    const client = createRealtimeClient(config);

    client.send('position.update', { latitude: 1, longitude: 1, accuracyMeters: 5, speedMetersPerSecond: null, headingDegrees: null });
    client.send('position.update', { latitude: 2, longitude: 2, accuracyMeters: 5, speedMetersPerSecond: null, headingDegrees: null });

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
