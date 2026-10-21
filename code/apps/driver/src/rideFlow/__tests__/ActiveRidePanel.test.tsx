import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { asRideId } from '@babana/navigation';
import { ApiError } from '@babana/api-client';

const mockReverseGeocode = jest.fn<Promise<string | null>, [unknown]>();
const mockFetchRoute = jest.fn();
jest.mock('@babana/maps', () => ({
  reverseGeocode: (p: unknown) => mockReverseGeocode(p),
  fetchRoute: (...args: unknown[]) => mockFetchRoute(...args),
}));

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

// `offlineRunner` réel, branché sur le MÊME `mockRequest` que `apiClient` ci-dessus (même
// topologie qu'en production : `../offline.ts` enrobe `apiClient`) -- `completeRide` (fin de
// course, L6-16) passe par lui, `startRide` reste un appel direct. Voir
// SettlementScreen.test.tsx pour le raisonnement complet sur ce patron de test.
jest.mock('../../offline', () => ({
  offlineRunner: require('@babana/api-client').createOfflineActionRunner({
    httpClient: { request: (...args: unknown[]) => mockRequest(...args) },
    queueStorage: require('@babana/api-client').createInMemoryOfflineQueue(),
  }),
}));

const mockGetPosition = jest.fn().mockResolvedValue({ latitude: 4.05, longitude: 9.7 });
jest.mock('../../location', () => ({
  getCurrentPosition: () => mockGetPosition(),
}));

let realtimeListener: ((message: unknown) => void) | null = null;
let connectionListener: ((state: string) => void) | null = null;
let mockConnectionState: 'offline' | 'connecting' | 'connected' = 'connected';
const mockSend = jest.fn();
jest.mock('../../realtime', () => ({
  onRealtimeMessage: (listener: (message: unknown) => void) => {
    realtimeListener = listener;
    return () => {
      realtimeListener = null;
    };
  },
  onRealtimeConnectionStateChange: (listener: (state: string) => void) => {
    connectionListener = listener;
    return () => {
      connectionListener = null;
    };
  },
  realtimeClient: {
    getState: () => mockConnectionState,
    send: (...args: unknown[]) => mockSend(...args),
  },
}));

// EmergencyButton (L8-04) a ses propres tests -- ici on vérifie seulement qu'il est monté sur ce
// panneau, avec un `getPosition` qui rappelle le GPS (src/location).
jest.mock('../../components/EmergencyButton', () => {
  const { Text: RNText, Pressable } = jest.requireActual('react-native');
  return {
    EmergencyButton: ({ getPosition }: { getPosition: () => Promise<unknown> }) => (
      <Pressable testID="emergency-button" onPress={() => getPosition()}>
        <RNText>Urgence</RNText>
      </Pressable>
    ),
  };
});

import { ActiveRidePanel, type RideMapState } from '../ActiveRidePanel';

const RIDE_ID = asRideId('ride-1');
const ORIGIN = { latitude: 4.05, longitude: 9.7 };
const DESTINATION = { latitude: 4.061, longitude: 9.71 };
const PARAMS = {
  rideId: RIDE_ID,
  origin: ORIGIN,
  destination: DESTINATION,
  amount: 1500,
  distanceMeters: 3200,
  clientPhoneNumber: '+237691234567',
};
// distanceMeters ne sert plus à `complete` : la fin de course ne porte que la décision (J24,
// amoa/questions/L6-13.md).

const SETTINGS = { arrivalRadiusMeters: 150, routeRetryCooldownMs: 15_000 };
// ~0,0045° de latitude ≈ 500 m du client ; 0,0003° ≈ 33 m.
const FAR = { latitude: 4.0545, longitude: 9.7 };
const NEAR = { latitude: 4.0503, longitude: 9.7 };

const APPROACH_ROUTE = {
  points: [FAR, ORIGIN],
  distanceMeters: 500,
  durationSeconds: 120,
};
const TRANSIT_ROUTE = {
  points: [ORIGIN, DESTINATION],
  distanceMeters: 1800,
  durationSeconds: 420,
};

const renderedRoots: ReactTestRenderer[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  realtimeListener = null;
  connectionListener = null;
  mockConnectionState = 'connected';
  mockReverseGeocode.mockResolvedValue(null);
  mockRequest.mockResolvedValue({});
  // Itinéraire vers le client (départ = position du chauffeur) ou vers la destination (départ = client).
  mockFetchRoute.mockImplementation(async (_from: unknown, to: unknown) => (to === ORIGIN ? APPROACH_ROUTE : TRANSIT_ROUTE));
});

afterEach(async () => {
  await act(async () => {
    for (const root of renderedRoots.splice(0)) root.unmount();
  });
  jest.useRealTimers();
});

function makeCallbacks() {
  return {
    onSettle: jest.fn(),
    onEnded: jest.fn(),
    mapStates: [] as RideMapState[],
    onMapState: jest.fn(),
  };
}

async function renderActiveRide(
  initial: { position?: { latitude: number; longitude: number } | null; params?: typeof PARAMS } = {}
) {
  const callbacks = makeCallbacks();
  callbacks.onMapState.mockImplementation((state: RideMapState) => callbacks.mapStates.push(state));
  const props = {
    ride: initial.params ?? PARAMS,
    settings: SETTINGS,
    onMapState: callbacks.onMapState,
    onSettle: callbacks.onSettle,
    onEnded: callbacks.onEnded,
  };
  const position = initial.position === undefined ? NEAR : initial.position;
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<ActiveRidePanel {...props} position={position} />);
  });
  renderedRoots.push(root);
  const rerender = async (nextPosition: { latitude: number; longitude: number } | null) => {
    await act(async () => {
      root.update(<ActiveRidePanel {...props} position={nextPosition} />);
    });
  };
  return { root, callbacks, rerender };
}

const press = (root: ReactTestRenderer, testID: string) =>
  act(async () => {
    root.root.findByProps({ testID }).props.onPress();
  });
const has = (root: ReactTestRenderer, testID: string) => root.root.findAllByProps({ testID }).length > 0;

/** Approche -> « Sur place » -> « Commencer la course » : le chemin que le chauffeur parcourt. */
async function reachTransit(root: ReactTestRenderer) {
  await press(root, 'active-ride-arrived');
  await press(root, 'active-ride-start');
}

function texts(root: ReactTestRenderer): string {
  return root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children)).join(' ');
}

function emit(message: Record<string, unknown>) {
  realtimeListener?.({ id: 'm', emittedAt: new Date().toISOString(), ...message });
}

describe('ActiveRidePanel (L6-13)', () => {
  it("il n'y a plus de bouton Google Maps : l'itinéraire est sur la carte de l'app", async () => {
    const { root } = await renderActiveRide();
    expect(has(root, 'active-ride-navigate')).toBe(false);
    expect(texts(root)).not.toContain('Google Maps');
  });

  it('invariant 1 -- le passage en course est une décision (bouton), jamais déduit : au montage on reste en approche', async () => {
    const { root } = await renderActiveRide();
    expect(texts(root)).toContain('En route vers le client');
    expect(mockRequest).not.toHaveBeenCalled();
    // Même à proximité du client, « Commencer » n'apparaît qu'après « Sur place ».
    expect(has(root, 'active-ride-start')).toBe(false);
  });

  it('"Commencer la course" appelle POST /rides/{id}/start et bascule en trajet', async () => {
    const { root } = await renderActiveRide();
    await reachTransit(root);
    expect(mockRequest).toHaveBeenCalledWith('startRide', { pathParams: { id: RIDE_ID }, body: {} });
    expect(texts(root)).toContain('Course en cours');
  });

  it('un échec de démarrage affiche un message compréhensible, sans basculer en trajet', async () => {
    mockRequest.mockRejectedValueOnce(new ApiError('RIDE_INVALID_TRANSITION', 'transition invalide', 409));
    const { root } = await renderActiveRide();
    await press(root, 'active-ride-arrived');
    await press(root, 'active-ride-start');
    expect(root.root.findByProps({ testID: 'active-ride-error' })).toBeTruthy();
    expect(texts(root)).not.toContain('Course en cours');
    // Le chauffeur peut réessayer : « Commencer » reste là.
    expect(has(root, 'active-ride-start')).toBe(true);
  });

  it('critère 4 -- la fin de course exige un maintien prolongé (pas un simple appui), puis complete + règlement', async () => {
    const { root, callbacks } = await renderActiveRide();
    await reachTransit(root);

    const finish = root.root.findByProps({ testID: 'active-ride-finish' });
    // Un simple appui ne termine rien -- il n'y a pas de onPress qui complète.
    expect(finish.props.onPress).toBeUndefined();
    expect(finish.props.delayLongPress).toBeGreaterThanOrEqual(600);

    await act(async () => {
      finish.props.onLongPress();
    });
    // La fin de course ne porte que la décision (J24) : corps vide, aucun relevé de trajet.
    expect(mockRequest).toHaveBeenCalledWith(
      'completeRide',
      expect.objectContaining({ pathParams: { id: RIDE_ID }, body: {} })
    );
    expect(callbacks.onSettle).toHaveBeenCalledWith({ rideId: RIDE_ID, amount: 1500 });
  });

  it('L6-16 -- hors connexion, la fin de course est mise en attente puis confirmée automatiquement au retour du réseau', async () => {
    const { root, callbacks } = await renderActiveRide();
    await reachTransit(root);

    // La rejection ne vise que le prochain appel (completeRide), pas celui de startRide déjà
    // consommé ci-dessus (mockRequest.mockResolvedValue({}) par défaut, beforeEach).
    mockRequest.mockRejectedValueOnce(new Error('network down'));
    await act(async () => {
      root.root.findByProps({ testID: 'active-ride-finish' }).props.onLongPress();
    });
    expect(root.root.findByProps({ testID: 'active-ride-finish-queued' })).toBeTruthy();
    expect(has(root, 'active-ride-finish')).toBe(false);
    expect(callbacks.onSettle).not.toHaveBeenCalled();

    // Rejeu automatique (reconnexion) : ni bouton ni nouvelle action du panneau, juste flush() --
    // exactement ce que `../offline.ts` réel appelle depuis `onRealtimeConnectionStateChange`.
    mockRequest.mockResolvedValueOnce({});
    const { offlineRunner } = require('../../offline');
    await act(async () => {
      await offlineRunner.flush();
    });

    expect(callbacks.onSettle).toHaveBeenCalledWith({ rideId: RIDE_ID, amount: 1500 });
  });

  it('L6-16 -- « Réessayer maintenant » réutilise la même clé d’idempotence, sans double fin de course', async () => {
    const { root, callbacks } = await renderActiveRide();
    await reachTransit(root);
    mockRequest.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce({});
    await act(async () => {
      root.root.findByProps({ testID: 'active-ride-finish' }).props.onLongPress();
    });
    await press(root, 'active-ride-finish-retry');

    const completeCalls = mockRequest.mock.calls.filter((c) => c[0] === 'completeRide');
    expect(completeCalls).toHaveLength(2);
    expect(completeCalls[0][1].idempotencyKey).toBe(completeCalls[1][1].idempotencyKey);
    expect(callbacks.onSettle).toHaveBeenCalledTimes(1);
  });

  it('D42 -- le bouton d’appel du client est là quand le numéro est connu, absent sinon', async () => {
    const { root } = await renderActiveRide();
    expect(has(root, 'call-client-button')).toBe(true);
    const { root: withoutNumber } = await renderActiveRide({ params: { ...PARAMS, clientPhoneNumber: null as never } });
    expect(has(withoutNumber, 'call-client-button')).toBe(false);
  });

  it('le bouton d’urgence est monté et rappelle le GPS à l’instant', async () => {
    const { root } = await renderActiveRide();
    await press(root, 'emergency-button');
    expect(mockGetPosition).toHaveBeenCalled();
  });

  it('ride.started reçu du serveur bascule en trajet (démarrage déclenché ailleurs / reprise)', async () => {
    const { root } = await renderActiveRide();
    await act(async () => {
      emit({ type: 'ride.started', payload: { rideId: RIDE_ID } });
    });
    expect(texts(root)).toContain('Course en cours');
  });

  it('ride.completed reçu du serveur conclut avec le montant du serveur', async () => {
    const { callbacks } = await renderActiveRide();
    await act(async () => {
      emit({
        type: 'ride.completed',
        payload: { rideId: RIDE_ID, distanceMeters: 3300, durationSeconds: 700, measured: true, amount: 1450, breakdown: {} },
      });
    });
    expect(callbacks.onSettle).toHaveBeenCalledWith({ rideId: RIDE_ID, amount: 1450 });
  });

  it('ride.cancelled affiche un message puis rend la main à l’accueil, sans action requise', async () => {
    const { callbacks, root } = await renderActiveRide();
    await act(async () => {
      emit({ type: 'ride.cancelled', payload: { rideId: RIDE_ID, cancelledBy: 'client' } });
    });
    expect(texts(root)).toContain('Le client a annulé la course.');
    expect(callbacks.onEnded).not.toHaveBeenCalled();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
    });
    expect(callbacks.onEnded).toHaveBeenCalledTimes(1);
  });

  it('un message pour une autre course est ignoré', async () => {
    const { root, callbacks } = await renderActiveRide();
    await act(async () => {
      emit({ type: 'ride.started', payload: { rideId: 'autre' } });
      emit({ type: 'ride.completed', payload: { rideId: 'autre', distanceMeters: 1, durationSeconds: 1, measured: true, amount: 1, breakdown: {} } });
    });
    expect(texts(root)).toContain('En route vers le client');
    expect(callbacks.onSettle).not.toHaveBeenCalled();
  });

  it('session.synced in_progress fait reprendre en trajet après un redémarrage de l’app', async () => {
    const { root } = await renderActiveRide();
    await act(async () => {
      emit({ type: 'session.synced', payload: { activeRideId: RIDE_ID, activeRideState: 'in_progress', activeProposal: null, rideStateKnown: true, serverTime: new Date().toISOString() } });
    });
    expect(texts(root)).toContain('Course en cours');
  });
});

describe('« Sur place » -- à proximité seulement, puis « Commencer la course »', () => {
  it('absent loin du client, et sans position connue', async () => {
    const far = await renderActiveRide({ position: FAR });
    expect(has(far.root, 'active-ride-arrived')).toBe(false);

    const unknown = await renderActiveRide({ position: null });
    expect(has(unknown.root, 'active-ride-arrived')).toBe(false);
  });

  it('apparaît dès que le chauffeur entre dans le rayon configuré', async () => {
    const { root, rerender } = await renderActiveRide({ position: FAR });
    expect(has(root, 'active-ride-arrived')).toBe(false);

    await rerender(NEAR);
    expect(has(root, 'active-ride-arrived')).toBe(true);
  });

  it('le rayon vient de la configuration, pas du code', async () => {
    const callbacks = makeCallbacks();
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(
        <ActiveRidePanel
          ride={PARAMS}
          position={FAR}
          settings={{ ...SETTINGS, arrivalRadiusMeters: 1000 }}
          onMapState={callbacks.onMapState}
          onSettle={callbacks.onSettle}
          onEnded={callbacks.onEnded}
        />
      );
    });
    renderedRoots.push(root);
    expect(has(root, 'active-ride-arrived')).toBe(true);
  });

  it('« Sur place » prévient le client (ride.arrived), puis laisse la place à « Commencer la course »', async () => {
    const { root } = await renderActiveRide();
    expect(has(root, 'active-ride-start')).toBe(false);

    await press(root, 'active-ride-arrived');

    expect(mockSend).toHaveBeenCalledWith('ride.arrived', { rideId: RIDE_ID });
    expect(has(root, 'active-ride-arrived')).toBe(false);
    expect(has(root, 'active-ride-start')).toBe(true);
    expect(texts(root)).toContain('Sur place');
    // Aucune décision serveur n'est prise par « Sur place » : le départ reste le seul appel HTTP.
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('hors connexion, « Sur place » est refusé avec une explication -- le client n’est pas prévenu dans le vide', async () => {
    mockConnectionState = 'offline';
    const { root } = await renderActiveRide();

    await press(root, 'active-ride-arrived');

    expect(mockSend).not.toHaveBeenCalledWith('ride.arrived', expect.anything());
    expect(has(root, 'active-ride-start')).toBe(false);
    expect(texts(root)).toContain('Hors connexion');
  });
});

describe('itinéraire -- calculé par le chauffeur, affiché à l’identique chez le client', () => {
  it('dès l’acceptation, l’itinéraire vers le client s’affiche sur la carte et est partagé', async () => {
    const { callbacks } = await renderActiveRide({ position: FAR });

    expect(mockFetchRoute).toHaveBeenCalledWith(FAR, ORIGIN);
    const last = callbacks.mapStates[callbacks.mapStates.length - 1];
    expect(last.stage).toBe('approach');
    expect(last.route).toEqual({ points: APPROACH_ROUTE.points });
    expect(mockSend).toHaveBeenCalledWith('route.share', {
      rideId: RIDE_ID,
      phase: 'approach',
      points: APPROACH_ROUTE.points,
      distanceMeters: 500,
      durationSeconds: 120,
    });
  });

  it('attend la position du chauffeur, puis calcule une seule fois', async () => {
    const { rerender } = await renderActiveRide({ position: null });
    expect(mockFetchRoute).not.toHaveBeenCalled();

    await rerender(FAR);
    expect(mockFetchRoute).toHaveBeenCalledTimes(1);

    await rerender({ latitude: 4.0535, longitude: 9.7 });
    expect(mockFetchRoute).toHaveBeenCalledTimes(1);
  });

  it('« Commencer la course » charge tout seul l’itinéraire vers la destination et le partage', async () => {
    const { root, callbacks } = await renderActiveRide();
    mockSend.mockClear();

    await reachTransit(root);

    expect(mockFetchRoute).toHaveBeenLastCalledWith(NEAR, DESTINATION);
    const last = callbacks.mapStates[callbacks.mapStates.length - 1];
    expect(last.stage).toBe('transit');
    expect(last.route).toEqual({ points: TRANSIT_ROUTE.points });
    expect(mockSend).toHaveBeenCalledWith(
      'route.share',
      expect.objectContaining({ rideId: RIDE_ID, phase: 'transit', points: TRANSIT_ROUTE.points })
    );
  });

  it('le tracé de l’approche quitte la carte quand le trajet commence', async () => {
    const { root, callbacks } = await renderActiveRide();
    mockFetchRoute.mockImplementation(() => new Promise(() => {})); // le trajet tarde

    await reachTransit(root);

    const last = callbacks.mapStates[callbacks.mapStates.length - 1];
    expect(last.stage).toBe('transit');
    expect(last.route).toBeNull();
  });

  it('le chauffeur voit la distance et la durée de l’itinéraire', async () => {
    const { root } = await renderActiveRide({ position: FAR });
    expect(root.root.findByProps({ testID: 'active-ride-summary' })).toBeTruthy();
    expect(texts(root)).toContain('0.5 km'); // format d'affichage existant (format.ts)
    expect(texts(root)).toContain('2 min');
  });

  it('service de routage injoignable : pas de tracé inventé, nouvel essai seulement après le délai', async () => {
    mockFetchRoute.mockResolvedValue(null);
    const { callbacks, rerender } = await renderActiveRide({ position: FAR });
    expect(mockFetchRoute).toHaveBeenCalledTimes(1);
    expect(callbacks.mapStates[callbacks.mapStates.length - 1].route).toBeNull();

    // Position suivante trop tôt : pas de nouvel appel.
    await rerender({ latitude: 4.0535, longitude: 9.7 });
    expect(mockFetchRoute).toHaveBeenCalledTimes(1);

    mockFetchRoute.mockResolvedValue(APPROACH_ROUTE);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(SETTINGS.routeRetryCooldownMs + 1);
    });
    await rerender({ latitude: 4.053, longitude: 9.7 });
    expect(mockFetchRoute).toHaveBeenCalledTimes(2);
    expect(callbacks.mapStates[callbacks.mapStates.length - 1].route).toEqual({ points: APPROACH_ROUTE.points });
  });

  it('hors connexion, le tracé s’affiche chez le chauffeur et est réémis à la reconnexion (jamais mis en file)', async () => {
    mockConnectionState = 'offline';
    const { callbacks } = await renderActiveRide({ position: FAR });
    expect(callbacks.mapStates[callbacks.mapStates.length - 1].route).toEqual({ points: APPROACH_ROUTE.points });
    expect(mockSend).not.toHaveBeenCalledWith('route.share', expect.anything());

    mockConnectionState = 'connected';
    await act(async () => {
      connectionListener?.('connected');
    });
    expect(mockSend).toHaveBeenCalledWith('route.share', expect.objectContaining({ rideId: RIDE_ID, phase: 'approach' }));
  });
});
