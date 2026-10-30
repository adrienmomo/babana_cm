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
  pickupNote: 'Devant la pharmacie du rond-point' as string | null,
};
// distanceMeters ne sert plus à `complete` : la fin de course ne porte que la décision (J24,
// amoa/questions/L6-13.md).

const GRACE_SECONDS = 300;
const SETTINGS = { arrivalRadiusMeters: 150, routeRetryCooldownMs: 15_000, routeDeviationMeters: 80, routeRefreshMs: 120_000 };
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
  // « Sur place » est écrit par Odoo (POST /rides/{id}/arrived) : l'heure d'arrivée et le délai de
  // grâce viennent de sa réponse. Les autres appels répondent un corps vide.
  mockRequest.mockImplementation(async (name: string) =>
    name === 'driverArrived' ? { arrivedAt: new Date(Date.now()).toISOString(), noShowGraceSeconds: GRACE_SECONDS } : {}
  );
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

// Sur place / Commencer / Terminer se confirment d'un glissement (SwipeButton, `onConfirm`) ; les
// autres boutons restent des appuis (`onPress`).
const SWIPES = new Set(['active-ride-arrived', 'active-ride-start', 'active-ride-finish']);
const press = (root: ReactTestRenderer, testID: string) =>
  act(async () => {
    const node = root.root.findByProps({ testID });
    if (SWIPES.has(testID)) node.props.onConfirm();
    else node.props.onPress();
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
    const { root } = await renderActiveRide();
    await press(root, 'active-ride-arrived');
    mockRequest.mockRejectedValueOnce(new ApiError('RIDE_INVALID_TRANSITION', 'transition invalide', 409));
    await press(root, 'active-ride-start');
    expect(root.root.findByProps({ testID: 'active-ride-error' })).toBeTruthy();
    expect(texts(root)).not.toContain('Course en cours');
    // Le chauffeur peut réessayer : « Commencer » reste là.
    expect(has(root, 'active-ride-start')).toBe(true);
  });

  it('critère 4 -- la fin de course exige un glissement complet (ni appui, ni maintien), puis complete + règlement', async () => {
    const { root, callbacks } = await renderActiveRide();
    await reachTransit(root);

    const finish = root.root.findByProps({ testID: 'active-ride-finish' });
    // Aucun appui ni maintien ne termine : seul le glissement confirmé (`onConfirm`) le fait.
    expect(finish.props.onPress).toBeUndefined();
    expect(finish.props.onLongPress).toBeUndefined();

    await press(root, 'active-ride-finish');
    // La fin de course ne porte que la décision (J24) : corps vide, aucun relevé de trajet.
    expect(mockRequest).toHaveBeenCalledWith(
      'completeRide',
      expect.objectContaining({ pathParams: { id: RIDE_ID }, body: {} })
    );
    expect(callbacks.onSettle).toHaveBeenCalledWith({ rideId: RIDE_ID, amount: 1500 });
  });

  it('Sur place et Commencer se confirment aussi d’un glissement, pas d’un appui', async () => {
    const { root } = await renderActiveRide();
    expect(root.root.findByProps({ testID: 'active-ride-arrived' }).props.onPress).toBeUndefined();
    await press(root, 'active-ride-arrived');
    expect(root.root.findByProps({ testID: 'active-ride-start' }).props.onPress).toBeUndefined();
  });

  it('L6-16 -- hors connexion, la fin de course est mise en attente puis confirmée automatiquement au retour du réseau', async () => {
    const { root, callbacks } = await renderActiveRide();
    await reachTransit(root);

    // La rejection ne vise que le prochain appel (completeRide), pas celui de startRide déjà
    // consommé ci-dessus (mockRequest.mockResolvedValue({}) par défaut, beforeEach).
    mockRequest.mockRejectedValueOnce(new Error('network down'));
    await press(root, 'active-ride-finish');
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
    await press(root, 'active-ride-finish');
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

  it('« Sur place » est écrit par Odoo (POST /arrived), puis laisse la place à « Commencer la course »', async () => {
    const { root } = await renderActiveRide();
    expect(has(root, 'active-ride-start')).toBe(false);

    await press(root, 'active-ride-arrived');

    expect(mockRequest).toHaveBeenCalledWith('driverArrived', { pathParams: { id: RIDE_ID }, body: {} });
    expect(has(root, 'active-ride-arrived')).toBe(false);
    expect(has(root, 'active-ride-start')).toBe(true);
    expect(texts(root)).toContain('Sur place');
    // « Sur place » ne démarre rien : la course commence seulement au glissement suivant.
    expect(mockRequest).not.toHaveBeenCalledWith('startRide', expect.anything());
  });

  it('réseau absent : « Sur place » n’est pas enregistré, le chauffeur le voit et peut réessayer', async () => {
    const { root } = await renderActiveRide();
    mockRequest.mockRejectedValueOnce(new Error('network down'));

    await press(root, 'active-ride-arrived');

    expect(has(root, 'active-ride-start')).toBe(false);
    expect(has(root, 'active-ride-arrived')).toBe(true);
    expect(texts(root)).toContain('Hors connexion');
  });

  it('un « Sur place » venu d’un autre appareil du chauffeur (driver.arrived) est repris', async () => {
    const { root } = await renderActiveRide();
    await act(async () => {
      emit({ type: 'driver.arrived', payload: { rideId: RIDE_ID, arrivedAt: new Date(Date.now()).toISOString(), noShowGraceSeconds: GRACE_SECONDS } });
    });
    expect(has(root, 'active-ride-start')).toBe(true);
  });
});

describe('attente du client après « Sur place »', () => {
  it('le temps d’attente se compte depuis l’heure d’arrivée d’Odoo', async () => {
    const { root } = await renderActiveRide();
    await press(root, 'active-ride-arrived');
    expect(root.root.findByProps({ testID: 'active-ride-waiting' })).toBeTruthy();
    expect(texts(root)).toContain('0:00');

    await act(async () => {
      await jest.advanceTimersByTimeAsync(73_000);
    });
    expect(texts(root)).toContain('1:13');
  });

  it('horloge du téléphone décalée de celle du serveur : le compteur part quand même de 0 et avance', async () => {
    // Le serveur a 2 min d'avance sur le téléphone : son « arrivedAt » est dans le futur local.
    mockRequest.mockImplementation(async (name: string) =>
      name === 'driverArrived' ? { arrivedAt: new Date(Date.now() + 120_000).toISOString(), noShowGraceSeconds: GRACE_SECONDS } : {}
    );
    const { root } = await renderActiveRide();
    await press(root, 'active-ride-arrived');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(texts(root)).toContain('0:10');
  });

  it('« Sur place » reçu en différé (driver.arrived) : l’attente se mesure entre deux heures du serveur', async () => {
    const { root } = await renderActiveRide();
    // Arrivée 30 s avant l'émission du message, d'après le serveur ; l'horloge du téléphone
    // (Date.now) n'entre pas dans ce calcul.
    const serverArrival = Date.parse('2030-01-01T10:00:00Z');
    await act(async () => {
      realtimeListener?.({
        type: 'driver.arrived',
        id: 'late',
        emittedAt: new Date(serverArrival + 30_000).toISOString(),
        payload: { rideId: RIDE_ID, arrivedAt: new Date(serverArrival).toISOString(), noShowGraceSeconds: GRACE_SECONDS },
      });
    });
    expect(texts(root)).toContain('0:30');
  });

  it('« Client absent » n’apparaît qu’une fois le délai de grâce écoulé', async () => {
    const { root } = await renderActiveRide();
    await press(root, 'active-ride-arrived');
    expect(has(root, 'active-ride-no-show')).toBe(false);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(GRACE_SECONDS * 1000 - 2000);
    });
    expect(has(root, 'active-ride-no-show')).toBe(false);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
    });
    expect(has(root, 'active-ride-no-show')).toBe(true);
  });

  it('« Client absent » demande une confirmation, puis annule avec le motif réservé et rend la main', async () => {
    const { root, callbacks } = await renderActiveRide();
    await press(root, 'active-ride-arrived');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(GRACE_SECONDS * 1000 + 1000);
    });

    await press(root, 'active-ride-no-show');
    // Premier appui : rien n'est envoyé, on demande de confirmer.
    expect(mockRequest).not.toHaveBeenCalledWith('cancelRide', expect.anything());
    await press(root, 'active-ride-no-show-confirm');

    expect(mockRequest).toHaveBeenCalledWith('cancelRide', { pathParams: { id: RIDE_ID }, body: { reason: 'client_no_show' } });
    expect(callbacks.onEnded).toHaveBeenCalledTimes(1);
  });

  it('refus du serveur (délai pas encore écoulé chez lui) : le message s’affiche, la course reste', async () => {
    const { root, callbacks } = await renderActiveRide();
    await press(root, 'active-ride-arrived');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(GRACE_SECONDS * 1000 + 1000);
    });
    mockRequest.mockRejectedValueOnce(new ApiError('NO_SHOW_TOO_EARLY', 'trop tôt', 409));

    await press(root, 'active-ride-no-show');
    await press(root, 'active-ride-no-show-confirm');

    expect(callbacks.onEnded).not.toHaveBeenCalled();
    expect(texts(root)).toContain('Le délai d’attente du client n’est pas encore écoulé.'.replace(/’/g, "'"));
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

  it("la distance affichée est ce qui reste à parcourir sur le tracé, pas sa longueur au moment du calcul (« 0.7 km » arrivé, 30 octobre)", async () => {
    const { root, rerender } = await renderActiveRide({ position: FAR });
    expect(texts(root)).toContain('0.5 km');

    // Un peu plus loin que mi-chemin sur le tracé (≈ 280 m restants) : pas d'écart, pas de nouveau calcul d'itinéraire -- l'affichage suit quand même.
    await rerender({ latitude: 4.0525, longitude: 9.7 });

    expect(mockFetchRoute).toHaveBeenCalledTimes(1);
    expect(texts(root)).toContain('0.3 km');
    expect(texts(root)).toContain('1 min');
    expect(texts(root)).not.toContain('0.5 km');
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

describe('adresses du client et de l’arrivée', () => {
  it('affichées dès que le géocodage les connaît', async () => {
    mockReverseGeocode.mockImplementation(async (p: unknown) => (p === ORIGIN ? 'Rue Joffre, Akwa' : 'Bonatene'));
    const { root } = await renderActiveRide();
    expect(texts(root)).toContain('Rue Joffre, Akwa');
    expect(texts(root)).toContain('Bonatene');
  });

  it('sans adresse connue, aucune ligne vide « … » ne s’affiche', async () => {
    const { root } = await renderActiveRide();
    expect(has(root, 'active-ride-origin')).toBe(false);
    expect(has(root, 'active-ride-destination')).toBe(false);
  });
});

describe('itinéraire recalculé quand le chauffeur avance', () => {
  // Le tracé d'approche va de FAR (nord) au client ; ces positions en sont proches ou éloignées.
  const ON_ROUTE = { latitude: 4.052, longitude: 9.7 };
  const OFF_ROUTE = { latitude: 4.052, longitude: 9.702 }; // ~220 m à l'est du tracé

  it('le chauffeur quitte le tracé : nouvel itinéraire depuis sa position, partagé au client', async () => {
    const { rerender } = await renderActiveRide({ position: FAR });
    expect(mockFetchRoute).toHaveBeenCalledTimes(1);
    mockSend.mockClear();

    await rerender(OFF_ROUTE);

    expect(mockFetchRoute).toHaveBeenCalledTimes(2);
    expect(mockFetchRoute).toHaveBeenLastCalledWith(OFF_ROUTE, ORIGIN);
    expect(mockSend).toHaveBeenCalledWith('route.share', expect.objectContaining({ phase: 'approach' }));
  });

  it('sur le tracé : aucun recalcul (forfait de données compté)', async () => {
    const { rerender } = await renderActiveRide({ position: FAR });
    await rerender(ON_ROUTE);
    expect(mockFetchRoute).toHaveBeenCalledTimes(1);
  });

  it('recalcul périodique, même sur le tracé, pour rafraîchir distance et durée', async () => {
    const { rerender } = await renderActiveRide({ position: FAR });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(SETTINGS.routeRefreshMs + 1);
    });
    await rerender(ON_ROUTE);
    expect(mockFetchRoute).toHaveBeenCalledTimes(2);
    expect(mockFetchRoute).toHaveBeenLastCalledWith(ON_ROUTE, ORIGIN);
  });

  it('pendant le trajet aussi : nouvel itinéraire vers la destination depuis la position', async () => {
    const { root, rerender } = await renderActiveRide();
    await reachTransit(root);
    const calls = mockFetchRoute.mock.calls.length;

    const offTransit = { latitude: 4.05, longitude: 9.72 };
    await rerender(offTransit);

    expect(mockFetchRoute).toHaveBeenCalledTimes(calls + 1);
    expect(mockFetchRoute).toHaveBeenLastCalledWith(offTransit, DESTINATION);
  });

  it('sur place (en attente du client) : aucun recalcul', async () => {
    const { root, rerender } = await renderActiveRide({ position: NEAR });
    await press(root, 'active-ride-arrived');
    const calls = mockFetchRoute.mock.calls.length;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(SETTINGS.routeRefreshMs + 1);
    });
    await rerender({ latitude: 4.0506, longitude: 9.7012 });
    expect(mockFetchRoute).toHaveBeenCalledTimes(calls);
  });
});

describe('messages rapides avec le client', () => {
  it('« Message » ouvre les messages du chauffeur ; en toucher un l’envoie et referme', async () => {
    const { root } = await renderActiveRide();
    expect(has(root, 'quick-message-driver_outside')).toBe(false);

    await press(root, 'active-ride-messages-toggle');
    expect(has(root, 'quick-message-driver_outside')).toBe(true);
    // Jamais les messages du client.
    expect(has(root, 'quick-message-client_coming')).toBe(false);

    await press(root, 'quick-message-driver_outside');
    expect(mockSend).toHaveBeenCalledWith('chat.send', { rideId: RIDE_ID, code: 'driver_outside' });
    expect(has(root, 'quick-message-driver_outside')).toBe(false);
  });

  it('une fois la course commencée, plus de messages (ils servent à se retrouver)', async () => {
    const { root } = await renderActiveRide();
    await reachTransit(root);
    expect(has(root, 'active-ride-messages-toggle')).toBe(false);
  });

  it('hors connexion : rien n’est envoyé, le chauffeur le voit', async () => {
    mockConnectionState = 'offline';
    const { root } = await renderActiveRide();
    await press(root, 'active-ride-messages-toggle');
    await press(root, 'quick-message-driver_on_my_way');
    expect(mockSend).not.toHaveBeenCalledWith('chat.send', expect.anything());
    expect(texts(root)).toContain('Hors connexion');
  });

  it('un message du client s’affiche en bulle, jusqu’à ce que le chauffeur la ferme', async () => {
    const { root } = await renderActiveRide();
    await act(async () => {
      emit({ type: 'chat.message', payload: { rideId: RIDE_ID, code: 'client_wait_please', from: 'client' } });
    });
    expect(has(root, 'active-ride-incoming-message')).toBe(true);
    expect(texts(root)).toContain('Attendez-moi, s’il vous plaît');

    await press(root, 'active-ride-incoming-message-dismiss');
    expect(has(root, 'active-ride-incoming-message')).toBe(false);
  });

  it('un message pour une autre course, ou venant du chauffeur lui-même, est ignoré', async () => {
    const { root } = await renderActiveRide();
    await act(async () => {
      emit({ type: 'chat.message', payload: { rideId: 'autre', code: 'client_coming', from: 'client' } });
      emit({ type: 'chat.message', payload: { rideId: RIDE_ID, code: 'driver_outside', from: 'driver' } });
    });
    expect(has(root, 'active-ride-incoming-message')).toBe(false);
  });
});

describe('repère du client sur la carte de course', () => {
  it('visible pendant l’approche et sur place -- c’est là qu’il sert', async () => {
    const { root } = await renderActiveRide();
    expect(texts(root)).toContain('Devant la pharmacie du rond-point');
    await press(root, 'active-ride-arrived');
    expect(has(root, 'active-ride-pickup-note')).toBe(true);
  });

  it('retiré une fois la course commencée', async () => {
    const { root } = await renderActiveRide();
    await reachTransit(root);
    expect(has(root, 'active-ride-pickup-note')).toBe(false);
  });

  it('sans repère, aucune ligne vide', async () => {
    const { root } = await renderActiveRide({ params: { ...PARAMS, pickupNote: null } });
    expect(has(root, 'active-ride-pickup-note')).toBe(false);
  });
});
