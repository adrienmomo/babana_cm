import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { asRideId } from '@babana/navigation';
import { ApiError } from '@babana/api-client';

const mockReverseGeocode = jest.fn<Promise<string | null>, [unknown]>();
const mockOpenNavigation = jest.fn();
jest.mock('@babana/maps', () => ({
  reverseGeocode: (p: unknown) => mockReverseGeocode(p),
  openNavigation: (...args: unknown[]) => mockOpenNavigation(...args),
}));

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

const mockGetPosition = jest.fn().mockResolvedValue({ latitude: 4.05, longitude: 9.7 });
jest.mock('../../location', () => ({
  getCurrentPosition: () => mockGetPosition(),
}));

let realtimeListener: ((message: unknown) => void) | null = null;
jest.mock('../../realtime', () => ({
  onRealtimeMessage: (listener: (message: unknown) => void) => {
    realtimeListener = listener;
    return () => {
      realtimeListener = null;
    };
  },
}));

const mockReplaceWithSettlement = jest.fn();
jest.mock('../../navigation/transitions', () => ({
  replaceWithSettlement: (...args: unknown[]) => mockReplaceWithSettlement(...args),
}));

// EmergencyButton (L8-04) a ses propres tests -- ici on vérifie seulement qu'il est monté sur cet
// écran, avec un `getPosition` qui rappelle le GPS (src/location.ts).
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

import { ActiveRideScreen } from '../ActiveRideScreen';

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
// distanceMeters reste dans les params de navigation (Proposal -> ActiveRide), mais n'est plus
// transmis à `complete` : la fin de course ne porte que la décision (J24, amoa/questions/L6-13.md).

function fakeNavigation() {
  return { reset: jest.fn(), navigate: jest.fn(), goBack: jest.fn() };
}

const renderedRoots: ReactTestRenderer[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  realtimeListener = null;
  mockReverseGeocode.mockResolvedValue(null);
  mockRequest.mockResolvedValue({});
});

afterEach(async () => {
  await act(async () => {
    for (const root of renderedRoots.splice(0)) root.unmount();
  });
  jest.useRealTimers();
});

async function renderActiveRide(params = PARAMS, navigation = fakeNavigation()) {
  const route = { key: 'ActiveRide', name: 'ActiveRide' as const, params };
  let root!: ReactTestRenderer;
  await act(async () => {
    // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran
    root = create(<ActiveRideScreen navigation={navigation} route={route} />);
  });
  renderedRoots.push(root);
  return { root, navigation };
}

function texts(root: ReactTestRenderer): string {
  return root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children)).join(' ');
}

function emit(message: Record<string, unknown>) {
  realtimeListener?.({ id: 'm', emittedAt: new Date().toISOString(), ...message });
}

describe('ActiveRideScreen (L6-13)', () => {
  it('critère 1 -- le guidage ouvre Google Maps vers le client en approche, vers la destination en trajet', async () => {
    const { root } = await renderActiveRide();

    await act(async () => {
      root.root.findByProps({ testID: 'active-ride-navigate' }).props.onPress();
    });
    expect(mockOpenNavigation).toHaveBeenLastCalledWith(ORIGIN, expect.objectContaining({ label: 'Point de prise en charge' }));

    // Passe en trajet via le bouton "Démarrer".
    await act(async () => {
      root.root.findByProps({ testID: 'active-ride-start' }).props.onPress();
    });
    expect(mockRequest).toHaveBeenCalledWith('startRide', { pathParams: { id: RIDE_ID }, body: {} });

    await act(async () => {
      root.root.findByProps({ testID: 'active-ride-navigate' }).props.onPress();
    });
    expect(mockOpenNavigation).toHaveBeenLastCalledWith(DESTINATION, expect.objectContaining({ label: 'Destination de la course' }));
  });

  it('critère 3 -- après le guidage, l’écran de course est toujours là (état préservé)', async () => {
    const { root } = await renderActiveRide();
    await act(async () => {
      root.root.findByProps({ testID: 'active-ride-start' }).props.onPress();
    });
    expect(texts(root)).toContain('Course en cours');

    await act(async () => {
      root.root.findByProps({ testID: 'active-ride-navigate' }).props.onPress();
    });
    // L'écran n'est pas remonté : la phase trajet est conservée.
    expect(texts(root)).toContain('Course en cours');
    expect(root.root.findAllByProps({ testID: 'active-ride-start' })).toHaveLength(0);
  });

  it('invariant 1 -- le passage en course est une décision (bouton), jamais déduit : au montage on reste en approche', async () => {
    const { root } = await renderActiveRide();
    expect(texts(root)).toContain('En route vers le client');
    expect(mockRequest).not.toHaveBeenCalled();
    expect(root.root.findByProps({ testID: 'active-ride-start' })).toBeTruthy();
  });

  it('"Démarrer la course" appelle POST /rides/{id}/start et bascule en trajet', async () => {
    const { root } = await renderActiveRide();
    await act(async () => {
      root.root.findByProps({ testID: 'active-ride-start' }).props.onPress();
    });
    expect(mockRequest).toHaveBeenCalledWith('startRide', { pathParams: { id: RIDE_ID }, body: {} });
    expect(texts(root)).toContain('Course en cours');
  });

  it('un échec de démarrage affiche un message compréhensible, sans basculer en trajet', async () => {
    mockRequest.mockRejectedValueOnce(new ApiError('RIDE_INVALID_TRANSITION', 'transition invalide', 409));
    const { root } = await renderActiveRide();
    await act(async () => {
      root.root.findByProps({ testID: 'active-ride-start' }).props.onPress();
    });
    expect(root.root.findByProps({ testID: 'active-ride-error' })).toBeTruthy();
    expect(texts(root)).toContain('En route vers le client');
  });

  it('critère 4 -- la fin de course exige un maintien prolongé (pas un simple appui), puis complete + Settlement', async () => {
    const { root } = await renderActiveRide();
    await act(async () => {
      root.root.findByProps({ testID: 'active-ride-start' }).props.onPress();
    });

    const finish = root.root.findByProps({ testID: 'active-ride-finish' });
    // Un simple appui ne termine rien -- il n'y a pas de onPress qui complète.
    expect(finish.props.onPress).toBeUndefined();
    expect(finish.props.delayLongPress).toBeGreaterThanOrEqual(600);

    await act(async () => {
      finish.props.onLongPress();
    });
    // La fin de course ne porte que la décision (J24) : corps vide, aucun relevé de trajet.
    expect(mockRequest).toHaveBeenCalledWith('completeRide', {
      pathParams: { id: RIDE_ID },
      body: {},
    });
    expect(mockReplaceWithSettlement).toHaveBeenCalledWith(expect.anything(), { rideId: RIDE_ID, amount: 1500 });
  });

  it('critère 5 -- aucun bouton d’appel du client (aucun numéro au contrat, écart amoa/questions/L6-13.md)', async () => {
    const { root } = await renderActiveRide();
    expect(root.root.findAllByProps({ testID: 'active-ride-call-client' })).toHaveLength(0);
  });

  it('le bouton d’urgence est monté et rappelle le GPS à l’instant', async () => {
    const { root } = await renderActiveRide();
    await act(async () => {
      root.root.findByProps({ testID: 'emergency-button' }).props.onPress();
    });
    expect(mockGetPosition).toHaveBeenCalled();
  });

  it('ride.started reçu du serveur bascule en trajet (démarrage déclenché ailleurs / reprise)', async () => {
    const { root } = await renderActiveRide();
    await act(async () => {
      emit({ type: 'ride.started', payload: { rideId: RIDE_ID } });
    });
    expect(texts(root)).toContain('Course en cours');
  });

  it('ride.completed reçu du serveur remplace la pile vers Settlement avec le montant du serveur', async () => {
    const { navigation } = await renderActiveRide();
    await act(async () => {
      emit({
        type: 'ride.completed',
        payload: { rideId: RIDE_ID, distanceMeters: 3300, durationSeconds: 700, measured: true, amount: 1450, breakdown: {} },
      });
    });
    expect(mockReplaceWithSettlement).toHaveBeenCalledWith(navigation, { rideId: RIDE_ID, amount: 1450 });
  });

  it('ride.cancelled affiche un message puis revient à l’accueil, sans action requise', async () => {
    const { navigation, root } = await renderActiveRide();
    await act(async () => {
      emit({ type: 'ride.cancelled', payload: { rideId: RIDE_ID, cancelledBy: 'client' } });
    });
    expect(texts(root)).toContain('Le client a annulé la course.');

    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
    });
    expect(navigation.reset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Home' }] });
  });

  it('un message pour une autre course est ignoré', async () => {
    const { root } = await renderActiveRide();
    await act(async () => {
      emit({ type: 'ride.started', payload: { rideId: 'autre' } });
      emit({ type: 'ride.completed', payload: { rideId: 'autre', distanceMeters: 1, durationSeconds: 1, measured: true, amount: 1, breakdown: {} } });
    });
    expect(texts(root)).toContain('En route vers le client');
    expect(mockReplaceWithSettlement).not.toHaveBeenCalled();
  });

  it('session.synced in_progress fait reprendre en trajet après un redémarrage de l’app', async () => {
    const { root } = await renderActiveRide();
    await act(async () => {
      emit({ type: 'session.synced', payload: { activeRideId: RIDE_ID, activeRideState: 'in_progress', serverTime: new Date().toISOString() } });
    });
    expect(texts(root)).toContain('Course en cours');
  });
});
