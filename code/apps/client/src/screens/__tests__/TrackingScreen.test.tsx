import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { asDriverId, asRideId } from '@babana/navigation';

// Capture les props de la carte : c'est ce qu'elle reçoit (tracé, repères) que ces tests vérifient.
const mockMapProps = jest.fn();
jest.mock('@babana/maps', () => {
  const { View } = jest.requireActual('react-native');
  return {
    MapView: (props: unknown) => {
      mockMapProps(props);
      return <View testID="mock-map" />;
    },
  };
});

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

jest.mock('../../location', () => ({
  getCurrentPosition: jest.fn().mockResolvedValue({ status: 'success', position: { latitude: 4.05, longitude: 9.7 } }),
}));

jest.mock('../../incidentQueue', () => {
  const { PendingIncidentQueue, createInMemoryPendingIncidentQueue } = jest.requireActual('@babana/api-client');
  return { pendingIncidentQueue: new PendingIncidentQueue(createInMemoryPendingIncidentQueue()) };
});

let realtimeListener: ((message: unknown) => void) | null = null;
let connectionStateListener: ((state: string) => void) | null = null;
const mockSend = jest.fn();
const mockEnsureConnected = jest.fn();
let mockConnectionState: 'offline' | 'connecting' | 'connected' = 'connected';
jest.mock('../../realtime', () => ({
  ensureRealtimeConnected: () => mockEnsureConnected(),
  onRealtimeMessage: (listener: (message: unknown) => void) => {
    realtimeListener = listener;
    return () => {
      realtimeListener = null;
    };
  },
  onRealtimeConnectionStateChange: (listener: (state: string) => void) => {
    connectionStateListener = listener;
    return () => {
      connectionStateListener = null;
    };
  },
  realtimeClient: {
    send: (...args: unknown[]) => mockSend(...args),
    getState: () => mockConnectionState,
  },
}));

import { TrackingScreen } from '../TrackingScreen';

const RIDE_ID = asRideId('ride-1');
const DRIVER_ID = asDriverId('driver-1');
const ORIGIN = { position: { latitude: 4.05, longitude: 9.7 }, label: 'vers Akwa' };
const DESTINATION = { position: { latitude: 4.06, longitude: 9.71 }, label: 'vers Bonapriso' };
const DRIVER = {
  driverId: DRIVER_ID,
  firstName: 'Paul',
  photoUrl: null,
  motorcycleClass: 'standard' as const,
  licensePlate: 'LT-1234-AB',
  phoneNumber: '+237691234567',
};

function fakeNavigation() {
  return { navigate: jest.fn(), replace: jest.fn(), reset: jest.fn() };
}

const renderedRoots: ReactTestRenderer[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of renderedRoots.splice(0)) root.unmount();
  });
  jest.useRealTimers();
});

async function renderTracking(
  overrides: { origin?: typeof ORIGIN; destination?: typeof DESTINATION; driver?: typeof DRIVER } = {},
  navigation = fakeNavigation()
): Promise<{ root: ReactTestRenderer; navigation: ReturnType<typeof fakeNavigation> }> {
  const route = {
    key: 'Tracking',
    name: 'Tracking' as const,
    params: {
      rideId: RIDE_ID,
      origin: overrides.origin ?? ORIGIN,
      destination: overrides.destination ?? DESTINATION,
      driver: overrides.driver ?? DRIVER,
    },
  };
  let root!: ReactTestRenderer;
  await act(async () => {
    // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran
    root = create(<TrackingScreen navigation={navigation} route={route} />);
  });
  renderedRoots.push(root);
  return { root, navigation };
}

function texts(root: ReactTestRenderer): string {
  return root.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

function emitTrackAck(broadcastIntervalMs = 10_000) {
  realtimeListener?.({
    type: 'ride.track.ack',
    id: 'ack-1',
    emittedAt: new Date().toISOString(),
    payload: { broadcastIntervalMs },
  });
}

function emitPosition(overrides: Partial<{ rideId: string; latitude: number; longitude: number; etaSeconds: number }> = {}) {
  realtimeListener?.({
    type: 'driver.position',
    id: 'm1',
    emittedAt: new Date().toISOString(),
    payload: {
      rideId: overrides.rideId ?? RIDE_ID,
      position: { latitude: overrides.latitude ?? 4.051, longitude: overrides.longitude ?? 9.701 },
      etaSeconds: overrides.etaSeconds ?? 300,
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  realtimeListener = null;
  connectionStateListener = null;
  mockConnectionState = 'connected';
});

const lastMapProps = () => mockMapProps.mock.calls[mockMapProps.mock.calls.length - 1]?.[0] as
  | { route?: { points: unknown[] }; markers: Array<{ id: string }> }
  | undefined;

function emitRoute(phase: 'approach' | 'transit', points: Array<{ latitude: number; longitude: number }>, rideId: string = RIDE_ID) {
  realtimeListener?.({
    type: 'ride.route',
    id: `route-${phase}`,
    emittedAt: new Date().toISOString(),
    payload: { rideId, phase, points, distanceMeters: 1800, durationSeconds: 420 },
  });
}

const APPROACH_POINTS = [
  { latitude: 4.049, longitude: 9.699 },
  { latitude: 4.0495, longitude: 9.6995 },
  { latitude: 4.05, longitude: 9.7 },
];
const TRANSIT_POINTS = [
  { latitude: 4.05, longitude: 9.7 },
  { latitude: 4.055, longitude: 9.705 },
  { latitude: 4.06, longitude: 9.71 },
];

describe('TrackingScreen (L6-09)', () => {
  it("s'abonne à ride.track au montage", async () => {
    await renderTracking();

    expect(mockEnsureConnected).toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith('ride.track', { rideId: RIDE_ID });
  });

  it('critère 1 : immatriculation et gamme sont visibles pendant l’approche', async () => {
    const { root } = await renderTracking();

    expect(texts(root)).toContain('LT-1234-AB');
    expect(texts(root)).toContain('Standard');
    expect(texts(root)).toContain('Paul');
  });

  it("l'ETA de driver.position est affiché pendant l'approche", async () => {
    const { root } = await renderTracking();

    await act(async () => {
      emitPosition({ etaSeconds: 300 });
    });

    expect(root.root.findByProps({ testID: 'tracking-eta' })).toBeTruthy();
    expect(texts(root)).toContain('≈ 5 min');
  });

  it("l'ETA disparaît une fois la course démarrée -- il ne cible que le point de prise en charge, jamais la destination", async () => {
    const { root } = await renderTracking();

    await act(async () => {
      emitPosition({ etaSeconds: 300 });
    });
    expect(root.root.findByProps({ testID: 'tracking-eta' })).toBeTruthy();

    await act(async () => {
      realtimeListener?.({ type: 'ride.started', id: 'm2', emittedAt: new Date().toISOString(), payload: { rideId: RIDE_ID } });
    });

    expect(root.root.findAllByProps({ testID: 'tracking-eta' })).toHaveLength(0);
    expect(texts(root)).toContain('Course en cours');
  });

  // 24 octobre : une fois la course commencée, l'épingle de prise en charge recouvrait le
  // chauffeur (il est exactement là). Elle n'a plus de sens : elle disparaît.
  it('une fois la course commencée, l’épingle de prise en charge n’est plus dessinée -- elle masquait le chauffeur', async () => {
    await renderTracking();
    await act(async () => {
      emitPosition({ etaSeconds: 0 });
    });
    expect(lastMapProps()!.markers.map((m) => m.id)).toContain('pickup');

    await act(async () => {
      realtimeListener?.({ type: 'ride.started', id: 'm2', emittedAt: new Date().toISOString(), payload: { rideId: RIDE_ID } });
    });

    const ids = lastMapProps()!.markers.map((m) => m.id);
    expect(ids).not.toContain('pickup');
    expect(ids).toEqual(expect.arrayContaining(['dropoff', 'driver']));
  });

  it('ride.completed remplace la pile vers le résumé, avec exactement ce que le serveur a écrit', async () => {
    const { navigation } = await renderTracking();

    const breakdown = {
      baseFare: 200,
      distanceFare: 1000,
      surgeAmount: 0,
      discountAmount: 0,
      floorAmount: 0,
      roundingAmount: 0,
      minimumFareApplied: false,
    };
    await act(async () => {
      realtimeListener?.({
        type: 'ride.completed',
        id: 'm3',
        emittedAt: new Date().toISOString(),
        payload: { rideId: RIDE_ID, distanceMeters: 4200, durationSeconds: 780, measured: true, amount: 1200, breakdown },
      });
    });

    expect(navigation.replace).toHaveBeenCalledWith('RideSummary', {
      rideId: RIDE_ID,
      distanceMeters: 4200,
      durationSeconds: 780,
      amount: 1200,
      breakdown,
    });
  });

  it('ride.completed non mesurée (J24) : distance et durée à null sont transmises telles quelles au résumé', async () => {
    const { navigation } = await renderTracking();
    const breakdown = {
      baseFare: 200,
      distanceFare: 1000,
      surgeAmount: 0,
      discountAmount: 0,
      floorAmount: 0,
      roundingAmount: 0,
      minimumFareApplied: false,
    };
    await act(async () => {
      realtimeListener?.({
        type: 'ride.completed',
        id: 'm3-null',
        emittedAt: new Date().toISOString(),
        payload: { rideId: RIDE_ID, distanceMeters: null, durationSeconds: null, measured: false, amount: 1200, breakdown },
      });
    });

    expect(navigation.replace).toHaveBeenCalledWith('RideSummary', {
      rideId: RIDE_ID,
      distanceMeters: null,
      durationSeconds: null,
      amount: 1200,
      breakdown,
    });
  });

  it('un message pour une autre course est ignoré', async () => {
    const { root, navigation } = await renderTracking();

    await act(async () => {
      emitPosition({ rideId: 'another-ride' });
    });

    expect(root.root.findByProps({ testID: 'tracking-map' })).toBeTruthy();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('critère 3 : la perte de connexion est signalée explicitement, jamais une position figée qu’on croirait à jour', async () => {
    const { root } = await renderTracking();

    await act(async () => {
      emitPosition();
    });
    expect(root.root.findAllByProps({ testID: 'tracking-connection-banner' })).toHaveLength(0);

    await act(async () => {
      connectionStateListener?.('offline');
    });

    expect(root.root.findByProps({ testID: 'tracking-connection-banner' })).toBeTruthy();
    expect(texts(root)).toContain('Connexion perdue');
  });

  // L3-20 (30 août) -- le risque explicitement nommé par l'écart : `connectionState` reste
  // `connected` pendant qu'un flux applicatif (ici driver.position) s'est tu, sans fermeture ni
  // erreur. Distinct du test "critère 3" ci-dessus, qui couvre la connexion réellement tombée.
  it('L3-20 -- un silence prolongé de driver.position sur une connexion par ailleurs vivante est signalé distinctement, et déclenche un réabonnement', async () => {
    jest.useFakeTimers();
    const { root } = await renderTracking();
    await act(async () => {
      // D50 : la surveillance ne démarre qu'à l'accusé, qui porte la cadence (10 s ici).
      emitTrackAck(10_000);
      emitPosition();
    });
    expect(root.root.findAllByProps({ testID: 'tracking-connection-banner' })).toHaveLength(0);
    mockSend.mockClear();

    // Silence au-delà du seuil (3 x la cadence annoncée = 30 s) -- connectionStateListener ne
    // bouge jamais dans ce test : la connexion reste `connected` tout du long, exactement le
    // scénario du 30 août.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });

    // Jamais le bandeau "Connexion perdue" -- la connexion, elle, va bien.
    expect(root.root.findAllByProps({ testID: 'tracking-connection-banner' })).toHaveLength(0);
    expect(root.root.findByProps({ testID: 'tracking-stale-banner' })).toBeTruthy();
    expect(texts(root)).toMatch(/non mise à jour depuis/);
    // Réabonnement automatique, sur la connexion existante -- pas une reconnexion.
    expect(mockSend).toHaveBeenCalledWith('ride.track', { rideId: RIDE_ID });
  });

  it('L3-20 -- la reprise de driver.position efface le bandeau de silence', async () => {
    jest.useFakeTimers();
    const { root } = await renderTracking();
    await act(async () => {
      emitTrackAck(10_000);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(root.root.findByProps({ testID: 'tracking-stale-banner' })).toBeTruthy();

    await act(async () => {
      emitPosition();
    });

    expect(root.root.findAllByProps({ testID: 'tracking-stale-banner' })).toHaveLength(0);
  });

  it('D50 -- le seuil de silence suit la cadence annoncée par ride.track.ack, pas une constante locale', async () => {
    jest.useFakeTimers();
    const { root } = await renderTracking();
    await act(async () => {
      // Le serveur annonce 4 s -> silence anormal au-delà de 12 s (et non 30 s).
      emitTrackAck(4000);
      emitPosition();
    });

    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(root.root.findAllByProps({ testID: 'tracking-stale-banner' })).toHaveLength(0);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(4_000);
    });
    expect(root.root.findByProps({ testID: 'tracking-stale-banner' })).toBeTruthy();
  });

  it('une reconnexion réémet ride.track', async () => {
    await renderTracking();
    mockSend.mockClear();

    await act(async () => {
      connectionStateListener?.('connected');
    });

    expect(mockSend).toHaveBeenCalledWith('ride.track', { rideId: RIDE_ID });
  });

  // L8-03/L8-04 (24 août) : partage de trajet et bouton d'urgence, tous deux atteignables en un
  // geste depuis cet écran -- ni l'un ni l'autre n'est plus absent (précédent commentaire).
  it('le partage de trajet et le bouton d’urgence sont tous deux atteignables depuis l’écran de suivi', async () => {
    const { root } = await renderTracking();

    expect(root.root.findAllByProps({ testID: 'share-trip-button' }).length).toBeGreaterThan(0);
    expect(root.root.findAllByProps({ testID: 'emergency-button' }).length).toBeGreaterThan(0);
  });

  it('le bouton d’urgence reste atteignable pendant l’approche comme pendant la course', async () => {
    const { root } = await renderTracking();
    expect(root.root.findAllByProps({ testID: 'emergency-button' }).length).toBeGreaterThan(0);

    await act(async () => {
      realtimeListener?.({ type: 'ride.started', id: 'm2', emittedAt: new Date().toISOString(), payload: { rideId: RIDE_ID } });
    });

    expect(root.root.findAllByProps({ testID: 'emergency-button' }).length).toBeGreaterThan(0);
  });
});

describe('itinéraire du chauffeur et « Sur place » (déroulé sur la carte du chauffeur, miroir chez le client)', () => {
  it("le tracé calculé par le chauffeur s'affiche à l'identique sur la carte, avant même la première position", async () => {
    const { root } = await renderTracking();
    expect(lastMapProps()?.route).toBeUndefined();

    await act(async () => {
      emitRoute('approach', APPROACH_POINTS);
    });

    expect(root.root.findAllByProps({ testID: 'mock-map' }).length).toBeGreaterThan(0);
    expect(lastMapProps()?.route).toEqual({ points: APPROACH_POINTS });
  });

  it('un tracé pour une autre course est ignoré', async () => {
    await renderTracking();
    await act(async () => {
      emitRoute('approach', APPROACH_POINTS, 'autre-course');
    });
    expect(lastMapProps()?.route).toBeUndefined();
  });

  it('le démarrage de la course remplace le tracé de l’approche par celui du trajet', async () => {
    await renderTracking();
    await act(async () => {
      emitRoute('approach', APPROACH_POINTS);
      emitPosition();
    });
    expect(lastMapProps()?.route).toEqual({ points: APPROACH_POINTS });

    await act(async () => {
      realtimeListener?.({ type: 'ride.started', id: 'm2', emittedAt: new Date().toISOString(), payload: { rideId: RIDE_ID } });
    });
    // Le chemin vers le client n'a plus rien à faire sur la carte du trajet.
    expect(lastMapProps()?.route).toBeUndefined();

    await act(async () => {
      emitRoute('transit', TRANSIT_POINTS);
    });
    expect(lastMapProps()?.route).toEqual({ points: TRANSIT_POINTS });
  });

  it('un tracé du trajet arrivé avant ride.started n’est pas effacé par lui (les deux messages ne sont pas ordonnés)', async () => {
    await renderTracking();
    await act(async () => {
      emitPosition();
      emitRoute('transit', TRANSIT_POINTS);
      realtimeListener?.({ type: 'ride.started', id: 'm2', emittedAt: new Date().toISOString(), payload: { rideId: RIDE_ID } });
    });
    expect(lastMapProps()?.route).toEqual({ points: TRANSIT_POINTS });
  });

  it('un tracé rejoué à la reconnexion remplace le précédent sans doublon', async () => {
    await renderTracking();
    await act(async () => {
      emitRoute('approach', APPROACH_POINTS);
      emitRoute('approach', APPROACH_POINTS.slice(1));
    });
    expect(lastMapProps()?.route).toEqual({ points: APPROACH_POINTS.slice(1) });
  });

  it('« Sur place » : le client est prévenu que son chauffeur est arrivé', async () => {
    const { root } = await renderTracking();
    expect(root.root.findAllByProps({ testID: 'tracking-arrived' })).toHaveLength(0);
    expect(texts(root)).toContain('Votre chauffeur arrive');

    await act(async () => {
      realtimeListener?.({ type: 'driver.arrived', id: 'm3', emittedAt: new Date().toISOString(), payload: { rideId: RIDE_ID, arrivedAt: new Date().toISOString(), noShowGraceSeconds: 300 } });
    });

    expect(root.root.findByProps({ testID: 'tracking-arrived' })).toBeTruthy();
    expect(texts(root)).toContain('Votre chauffeur est arrivé');
    expect(texts(root)).not.toContain('Votre chauffeur arrive"');
  });

  it('« Sur place » pour une autre course est ignoré, et disparaît quand la course démarre', async () => {
    const { root } = await renderTracking();
    await act(async () => {
      realtimeListener?.({ type: 'driver.arrived', id: 'm3', emittedAt: new Date().toISOString(), payload: { rideId: 'autre', arrivedAt: new Date().toISOString(), noShowGraceSeconds: 300 } });
    });
    expect(root.root.findAllByProps({ testID: 'tracking-arrived' })).toHaveLength(0);

    await act(async () => {
      realtimeListener?.({ type: 'driver.arrived', id: 'm4', emittedAt: new Date().toISOString(), payload: { rideId: RIDE_ID, arrivedAt: new Date().toISOString(), noShowGraceSeconds: 300 } });
      realtimeListener?.({ type: 'ride.started', id: 'm5', emittedAt: new Date().toISOString(), payload: { rideId: RIDE_ID } });
    });
    expect(root.root.findAllByProps({ testID: 'tracking-arrived' })).toHaveLength(0);
    expect(texts(root)).toContain('Course en cours');
  });
});

describe('messages rapides avec le chauffeur', () => {
  const has = (root: ReactTestRenderer, testID: string) => root.root.findAllByProps({ testID }).length > 0;

  it('le client voit ses propres messages, et en toucher un l’envoie', async () => {
    const { root } = await renderTracking();
    expect(has(root, 'quick-message-client_coming')).toBe(true);
    expect(has(root, 'quick-message-driver_outside')).toBe(false);

    await act(async () => {
      root.root.findByProps({ testID: 'quick-message-client_coming' }).props.onPress();
    });
    expect(mockSend).toHaveBeenCalledWith('chat.send', { rideId: RIDE_ID, code: 'client_coming' });
  });

  it('hors connexion, les messages sont désactivés (jamais mis en file)', async () => {
    mockConnectionState = 'offline';
    const { root } = await renderTracking();
    expect(root.root.findByProps({ testID: 'quick-message-client_coming' }).props.disabled).toBe(true);
  });

  it('un message du chauffeur s’affiche en bulle, jusqu’à ce que le client la ferme', async () => {
    const { root } = await renderTracking();
    await act(async () => {
      realtimeListener?.({ type: 'chat.message', id: 'c1', emittedAt: new Date().toISOString(), payload: { rideId: RIDE_ID, code: 'driver_outside', from: 'driver' } });
    });
    expect(has(root, 'tracking-incoming-message')).toBe(true);
    expect(texts(root)).toContain('Je suis devant');

    await act(async () => {
      root.root.findByProps({ testID: 'tracking-incoming-message-dismiss' }).props.onPress();
    });
    expect(has(root, 'tracking-incoming-message')).toBe(false);
  });

  it('un message pour une autre course, ou venant du client lui-même, est ignoré', async () => {
    const { root } = await renderTracking();
    await act(async () => {
      realtimeListener?.({ type: 'chat.message', id: 'c2', emittedAt: new Date().toISOString(), payload: { rideId: 'autre', code: 'driver_outside', from: 'driver' } });
      realtimeListener?.({ type: 'chat.message', id: 'c3', emittedAt: new Date().toISOString(), payload: { rideId: RIDE_ID, code: 'client_coming', from: 'client' } });
    });
    expect(has(root, 'tracking-incoming-message')).toBe(false);
  });

  it('les messages disparaissent une fois la course commencée (ils servent à se retrouver)', async () => {
    const { root } = await renderTracking();
    await act(async () => {
      realtimeListener?.({ type: 'ride.started', id: 'm9', emittedAt: new Date().toISOString(), payload: { rideId: RIDE_ID } });
    });
    expect(has(root, 'quick-message-client_coming')).toBe(false);
  });
});

describe('attente : le client voit depuis quand son chauffeur l’attend', () => {
  function emitArrived(arrivedAt = new Date().toISOString(), noShowGraceSeconds = 300) {
    realtimeListener?.({ type: 'driver.arrived', id: 'a1', emittedAt: new Date().toISOString(), payload: { rideId: RIDE_ID, arrivedAt, noShowGraceSeconds } });
  }

  it('compteur depuis l’heure d’arrivée d’Odoo, et le temps restant avant que le chauffeur puisse annuler', async () => {
    jest.useFakeTimers();
    try {
      const { root } = await renderTracking();
      await act(async () => {
        emitArrived();
      });
      expect(texts(root)).toContain('0:00');
      expect(texts(root)).toContain('5:00');

      await act(async () => {
        jest.advanceTimersByTime(65_000);
      });
      expect(texts(root)).toContain('1:05');
      expect(texts(root)).toContain('3:55');
    } finally {
      jest.useRealTimers();
    }
  });

  it('horloge du téléphone décalée : l’attente se mesure entre deux heures du serveur', async () => {
    // Horloge figée : aucune milliseconde ne s'écoule entre le message et l'affichage.
    jest.useFakeTimers();
    try {
      const { root } = await renderTracking();
      const serverArrival = Date.parse('2030-01-01T10:00:00Z');
      await act(async () => {
        realtimeListener?.({
          type: 'driver.arrived',
          id: 'late',
          emittedAt: new Date(serverArrival + 30_000).toISOString(),
          payload: { rideId: RIDE_ID, arrivedAt: new Date(serverArrival).toISOString(), noShowGraceSeconds: 300 },
        });
      });
      expect(texts(root)).toContain('0:30');
      expect(texts(root)).toContain('4:30');
    } finally {
      jest.useRealTimers();
    }
  });

  it('délai écoulé : le client est prévenu que le chauffeur peut annuler', async () => {
    const { root } = await renderTracking();
    const serverArrival = Date.parse('2030-01-01T10:00:00Z');
    await act(async () => {
      realtimeListener?.({
        type: 'driver.arrived',
        id: 'late2',
        emittedAt: new Date(serverArrival + 301_000).toISOString(),
        payload: { rideId: RIDE_ID, arrivedAt: new Date(serverArrival).toISOString(), noShowGraceSeconds: 300 },
      });
    });
    expect(root.root.findByProps({ testID: 'tracking-no-show-warning' })).toBeTruthy();
  });
});
