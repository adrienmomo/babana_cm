import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { LatLng, PlaceResult } from '@babana/maps';
import type { http } from '@babana/contracts';
import type { LocationResult } from '../../location.types';

let capturedOnRegionChange: ((point: LatLng) => void) | null = null;
let capturedMarkers: { id: string; kind: string; label?: string }[] = [];
const mockReverseGeocode = jest.fn<Promise<string | null>, [LatLng]>();
const mockSearchPlace = jest.fn<Promise<PlaceResult[]>, [string]>();

jest.mock('@babana/maps', () => {
  const { View } = jest.requireActual('react-native');
  return {
    MapView: (props: { onRegionChange?: (point: LatLng) => void; markers?: { id: string; kind: string; label?: string }[] }) => {
      capturedOnRegionChange = props.onRegionChange ?? null;
      capturedMarkers = props.markers ?? [];
      return <View testID="mock-map" />;
    },
    reverseGeocode: (point: LatLng) => mockReverseGeocode(point),
    searchPlace: (query: string) => mockSearchPlace(query),
    MAP_MARKER_COLORS: { pickup: '#3E7BFA', dropoff: '#E5484D', driver: '#1A9E5C', client: '#3E7BFA', reticle: '#6B7280' },
  };
});

const mockGetCurrentPosition = jest.fn<Promise<LocationResult>, []>();
jest.mock('../../location', () => ({
  getCurrentPosition: () => mockGetCurrentPosition(),
}));

let realtimeListener: ((message: unknown) => void) | null = null;
let connectionStateListener: ((state: string) => void) | null = null;
const mockSend = jest.fn();
const mockEnsureConnected = jest.fn();
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
  realtimeClient: { send: (...args: unknown[]) => mockSend(...args) },
}));

import { HomeScreen } from '../HomeScreen';

const DOUALA = { latitude: 4.0511, longitude: 9.7679 };
const ELSEWHERE = { latitude: 4.07, longitude: 9.72 };
const CLIENT_GPS = { latitude: 4.06, longitude: 9.71 };

function driver(overrides: Partial<http.NearbyDriver> = {}): http.NearbyDriver {
  return {
    position: { latitude: 4.061, longitude: 9.711 },
    distanceMeters: 350,
    ...overrides,
  };
}

function emitNearbyDrivers(drivers: http.NearbyDriver[]) {
  realtimeListener?.({ type: 'nearby.drivers', id: 'm1', emittedAt: new Date().toISOString(), payload: { drivers } });
}

function emitSubscribeAck(
  payload: { accepted: true; broadcastIntervalMs?: number } | { accepted: false; retryAfterMs: number }
) {
  const resolved = payload.accepted ? { accepted: true as const, broadcastIntervalMs: payload.broadcastIntervalMs ?? 5000 } : payload;
  realtimeListener?.({ type: 'nearby.subscribe.ack', id: 'ack-1', emittedAt: new Date().toISOString(), payload: resolved });
}

function fakeNavigation() {
  return { navigate: jest.fn() };
}

// Démontés dans afterEach ci-dessous -- sans ça, l'effet de L3-20 (StreamLivenessWatchdog,
// HomeScreen.tsx) reste actif indéfiniment après la fin de chaque test (aucun unmount() ne
// déclenche son nettoyage), et son minuteur réel de vérification finit par se déclencher pendant
// un test suivant, hors de tout act() -- constaté en écrivant cette tâche : le processus de test
// plantait (`window.dispatchEvent is not a function`) une fois la suite assez longue pour
// dépasser NEARBY_BROADCAST_EXPECTED_INTERVAL_MS.
const renderedRoots: ReactTestRenderer[] = [];

async function renderHome(navigation = fakeNavigation()): Promise<ReactTestRenderer> {
  const route = { key: 'Home', name: 'Home' as const, params: undefined };
  let root!: ReactTestRenderer;
  await act(async () => {
    // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran (seul navigate() est utilisé)
    root = create(<HomeScreen navigation={navigation} route={route} />);
  });
  renderedRoots.push(root);
  return root;
}

function texts(root: ReactTestRenderer): string {
  return root.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

async function designate(root: ReactTestRenderer, slotTestID: string, point: LatLng) {
  await act(async () => {
    root.root.findByProps({ testID: slotTestID }).props.onPress();
  });
  await act(async () => {
    await capturedOnRegionChange?.(point);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  capturedOnRegionChange = null;
  realtimeListener = null;
  connectionStateListener = null;
  mockGetCurrentPosition.mockResolvedValue({ status: 'error', reason: 'position-unavailable' });
  mockReverseGeocode.mockResolvedValue(null);
  mockSearchPlace.mockResolvedValue([]);
});

afterEach(() => {
  // Déclenche le nettoyage des effets (dont StreamLivenessWatchdog.stop(), L3-20) avant le test
  // suivant -- voir le commentaire sur renderedRoots ci-dessus.
  act(() => {
    while (renderedRoots.length > 0) renderedRoots.pop()!.unmount();
  });
  jest.useRealTimers();
});

describe('HomeScreen (L6-06)', () => {
  it('le libellé ne garde que le premier segment de l’adresse : « vers Carrefour Tiff », sans la ville', async () => {
    mockReverseGeocode.mockResolvedValueOnce('Carrefour Tiff, Douala, Cameroun');
    const root = await renderHome(fakeNavigation());

    await designate(root, 'departure-slot', DOUALA);

    expect(texts(root)).toContain('vers Carrefour Tiff');
    expect(texts(root)).not.toContain('Carrefour Tiff, Douala');
  });

  it('critère 2 : la désignation sur carte seule (sans jamais toucher la recherche) suffit à activer "Suivant"', async () => {
    mockReverseGeocode.mockResolvedValueOnce('Akwa, Douala').mockResolvedValueOnce('Bonapriso, Douala');
    const navigation = fakeNavigation();
    const root = await renderHome(navigation);

    await designate(root, 'departure-slot', DOUALA);
    await designate(root, 'arrival-slot', ELSEWHERE);

    // "vers " préfixe le libellé du géocodage inverse (doute L6-06 §1) : une approximation, pas
    // un fait -- jamais appliqué au résultat d'une recherche textuelle délibérée (ligne 166 plus
    // bas, `handlePlaceSelected`, qui ne passe jamais par `labelFor`).
    expect(texts(root)).toContain('vers Akwa');
    expect(texts(root)).toContain('vers Bonapriso');
    expect(mockSearchPlace).not.toHaveBeenCalled();

    const next = root.root.findByProps({ testID: 'next-button' });
    expect(next.props.disabled).toBe(false);

    await act(async () => {
      root.root.findByProps({ testID: 'next-button' }).props.onPress();
    });
    expect(navigation.navigate).toHaveBeenCalledWith('Quote', {
      origin: { position: DOUALA, label: 'vers Akwa' },
      destination: { position: ELSEWHERE, label: 'vers Bonapriso' },
    });
  });

  // 24 octobre : le point en cours de désignation était dessiné deux fois au même endroit -- son
  // épingle sur la carte ET le réticule 📍 par-dessus. Le réticule le représente seul désormais,
  // dans la couleur de son rôle (palette de @babana/maps) ; l'autre point garde son épingle.
  it('le point en cours de désignation n’est dessiné que par le réticule, à la couleur de son rôle', async () => {
    const root = await renderHome();
    await designate(root, 'departure-slot', DOUALA);
    await designate(root, 'arrival-slot', ELSEWHERE);

    // L'arrivée est en cours de désignation : pas d'épingle d'arrivée, réticule rouge.
    expect(capturedMarkers.map((m) => m.kind)).toContain('pickup');
    expect(capturedMarkers.map((m) => m.kind)).not.toContain('dropoff');
    expect(StyleSheet.flatten(root.root.findByProps({ testID: 'reticle-pin' }).props.style).backgroundColor).toBe('#E5484D');

    // Retour au départ : le réticule devient bleu ; la carte est encore centrée sur l'arrivée,
    // dont l'épingle reste masquée sous lui tant que la carte ne bouge pas (voir le test suivant).
    await act(async () => {
      root.root.findByProps({ testID: 'departure-slot' }).props.onPress();
    });
    expect(capturedMarkers.map((m) => m.kind)).not.toContain('dropoff');
    await act(async () => {
      await capturedOnRegionChange?.(DOUALA);
    });
    expect(capturedMarkers.map((m) => m.kind)).toContain('dropoff');
    expect(capturedMarkers.map((m) => m.kind)).not.toContain('pickup');
    expect(StyleSheet.flatten(root.root.findByProps({ testID: 'reticle-pin' }).props.style).backgroundColor).toBe('#3E7BFA');
  });

  it('à l’ouverture, la carte est centrée sur le départ GPS et le réticule (arrivée) le recouvre : son épingle n’est pas dessinée dessous', async () => {
    mockGetCurrentPosition.mockResolvedValue({ status: 'success', position: CLIENT_GPS });
    mockReverseGeocode.mockResolvedValue('Bonamoussadi, Douala');
    const root = await renderHome();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(StyleSheet.flatten(root.root.findByProps({ testID: 'reticle-pin' }).props.style).backgroundColor).toBe('#E5484D');
    expect(capturedMarkers.map((m) => m.kind)).not.toContain('pickup');

    // Dès que la carte quitte le départ (désignation de l'arrivée), son épingle réapparaît.
    await act(async () => {
      await capturedOnRegionChange?.(ELSEWHERE);
    });
    expect(capturedMarkers.map((m) => m.kind)).toContain('pickup');
  });

  it('« Suivant » reste désactivé tant que le départ et l’arrivée ne sont pas tous deux désignés', async () => {
    const root = await renderHome();

    expect(root.root.findByProps({ testID: 'next-button' }).props.disabled).toBe(true);

    await designate(root, 'departure-slot', DOUALA);

    expect(root.root.findByProps({ testID: 'next-button' }).props.disabled).toBe(true);
  });

  it('critère 1 : la recherche textuelle désigne aussi un point (second moyen, complémentaire)', async () => {
    mockSearchPlace.mockResolvedValue([{ label: 'Bonanjo, Douala', position: { latitude: 4.05, longitude: 9.69 } }]);
    const root = await renderHome();

    await act(async () => {
      root.root.findByProps({ accessibilityLabel: 'Rechercher le point de départ' }).props.onChangeText('Bonanjo');
    });
    // PlacePicker débounce la recherche (400 ms) -- attente réelle, ce composant n'expose pas
    // d'injection de temporisation à HomeScreen.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    });

    expect(mockSearchPlace).toHaveBeenCalledWith('Bonanjo');
    expect(texts(root)).toContain('Bonanjo, Douala');
  });

  it('critère 3 : les chauffeurs se mettent à jour en direct, sans rechargement de l’écran', async () => {
    const root = await renderHome();
    expect(mockEnsureConnected).toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith('nearby.subscribe', expect.objectContaining({ position: DOUALA }));

    await act(async () => {
      emitNearbyDrivers([driver({ position: { latitude: 4.061, longitude: 9.711 } })]);
    });
    expect(texts(root)).toContain('1 en ligne');

    await act(async () => {
      emitNearbyDrivers([driver({ position: { latitude: 4.061, longitude: 9.712 } }), driver({ position: { latitude: 4.061, longitude: 9.713 } })]);
    });
    expect(texts(root)).toContain('Motos disponibles');
    expect(texts(root)).toContain('2 en ligne');
  });

  // 25 octobre (maquette produit) : « Moto disponible » à gauche, pastille verte « N en ligne » à
  // droite -- plus la phrase « N chauffeur(s) disponible(s) à proximité ».
  it('le compte des motos proches : libellé à gauche, pastille verte « N en ligne » à droite', async () => {
    const root = await renderHome();
    await act(async () => {
      emitNearbyDrivers([driver()]);
    });

    const row = root.root.findByProps({ testID: 'nearby-count' });
    const rowTexts = row.findAllByType(Text).map((n) => JSON.stringify(n.props.children)).join(' ');
    expect(rowTexts).toContain('Moto disponible');
    expect(rowTexts).toContain('1 en ligne');
    expect(root.root.findAllByProps({ testID: 'nearby-online-dot' }).length).toBeGreaterThan(0);
    expect(texts(root)).not.toContain('à proximité');
  });

  it("les chauffeurs proches sont anonymes : des points sur la carte, ni nom ni carte à choisir", async () => {
    const root = await renderHome();

    await act(async () => {
      emitNearbyDrivers([driver({ position: { latitude: 4.061, longitude: 9.714 } }), driver({ position: { latitude: 4.061, longitude: 9.715 } })]);
    });

    const driverMarkers = capturedMarkers.filter((marker) => marker.kind === 'driver');
    expect(driverMarkers).toHaveLength(2);
    expect(driverMarkers.every((marker) => marker.label === undefined)).toBe(true);
    expect(new Set(driverMarkers.map((marker) => marker.id)).size).toBe(2); // un identifiant de marqueur distinct par point
    expect(root.root.findAll((node) => typeof node.props.testID === 'string' && node.props.testID.startsWith('driver-card'))).toHaveLength(0);
  });

  // L3-20 (30 août) -- cause racine du silence de diffusion : la connexion reste `connected`
  // pendant que la diffusion périodique elle-même s'est tue, sans fermeture ni erreur. Ces deux
  // tests exercent StreamLivenessWatchdog depuis l'écran, avec de vrais minuteurs fictifs (pas
  // d'injection `now`/`wait` côté HomeScreen -- jest.useFakeTimers() pilote les vrais setInterval
  // /setTimeout du module).
  // 24 octobre : plus aucun bandeau de silence ni bouton « Réessayer » sur l'accueil (demande
  // produit). Le réabonnement automatique (L3-20) reste : c'est lui qui répare, sans rien afficher.
  it('L3-20 -- un silence de diffusion prolongé déclenche un réabonnement silencieux, sans jamais vider la liste déjà connue', async () => {
    jest.useFakeTimers();
    const root = await renderHome();
    await act(async () => {
      // D50 : la surveillance de silence ne démarre qu'à l'accusé, qui porte la cadence (5 s ici).
      emitSubscribeAck({ accepted: true, broadcastIntervalMs: 5000 });
      emitNearbyDrivers([driver({ position: { latitude: 4.061, longitude: 9.716 } })]);
    });
    expect(texts(root)).toContain('1 en ligne');
    mockSend.mockClear();

    // Aucun nearby.drivers pendant 3 x la cadence annoncée (5 s) : exactement le silence du
    // 30 août -- la diffusion périodique n'atteint plus la connexion, sans fermeture ni erreur.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000);
    });

    expect(texts(root)).not.toMatch(/non mise à jour/);
    expect(root.root.findAllByProps({ testID: 'nearby-stale' })).toHaveLength(0);
    // Le dernier chauffeur connu reste affiché.
    expect(texts(root)).toContain('1 en ligne');
    // Réabonnement automatique, sur la connexion existante -- pas une reconnexion.
    expect(mockSend).toHaveBeenCalledWith('nearby.subscribe', expect.objectContaining({ position: DOUALA }));
  });

  it('D50 -- le seuil de silence suit la cadence annoncée par le serveur, pas une constante locale', async () => {
    jest.useFakeTimers();
    await renderHome();
    await act(async () => {
      // Le serveur annonce une cadence de 8 s -> silence anormal seulement au-delà de 24 s.
      emitSubscribeAck({ accepted: true, broadcastIntervalMs: 8000 });
      emitNearbyDrivers([driver({ position: { latitude: 4.061, longitude: 9.718 } })]);
    });
    mockSend.mockClear();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000);
    });
    expect(mockSend).not.toHaveBeenCalledWith('nearby.subscribe', expect.anything());

    await act(async () => {
      await jest.advanceTimersByTimeAsync(12_000);
    });
    expect(mockSend).toHaveBeenCalledWith('nearby.subscribe', expect.anything());
  });

  it("une reconnexion (coupure réseau puis retour) réémet l'abonnement -- la liste ne se fige jamais", async () => {
    await renderHome();
    mockSend.mockClear();

    await act(async () => {
      connectionStateListener?.('connected');
    });

    expect(mockSend).toHaveBeenCalledWith('nearby.subscribe', expect.objectContaining({ position: DOUALA }));
  });

  it("aucun chauffeur à proximité : rien n'est affiché -- ni message, ni bouton « Réessayer »", async () => {
    const root = await renderHome();

    await act(async () => {
      emitNearbyDrivers([]);
    });

    expect(texts(root)).not.toContain('Aucun chauffeur');
    expect(root.root.findAllByProps({ testID: 'retry-nearby' })).toHaveLength(0);
    expect(root.root.findAllByProps({ testID: 'nearby-count' })).toHaveLength(0);
  });

  it('le départ est pré-rempli avec la position courante quand la permission est accordée', async () => {
    mockGetCurrentPosition.mockResolvedValue({ status: 'success', position: CLIENT_GPS });
    mockReverseGeocode.mockResolvedValue('Bonamoussadi, Douala');

    const root = await renderHome();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(texts(root)).toContain('vers Bonamoussadi');
  });

  // Doute L6-06 §2 (amoa/questions/REPONSES-2026-08-23.md §2) : les trois causes d'échec de
  // localisation ne produisent plus le même message générique, et le départ reste désignable à
  // la main dans les trois cas (D22, comportement déjà couvert ci-dessous).
  describe.each([
    ['permission-denied', 'Localisation refusée.'],
    ['position-unavailable', 'Position indisponible pour le moment.'],
    ['timeout', 'La localisation prend du temps.'],
  ] as const)('échec de localisation -- %s', (reason, expectedFragment) => {
    it(`affiche un message distinct ("${expectedFragment}") et laisse le départ désignable à la main`, async () => {
      mockGetCurrentPosition.mockResolvedValue({ status: 'error', reason });

      const root = await renderHome();
      await act(async () => {
        await Promise.resolve();
      });

      expect(texts(root)).toContain(expectedFragment);
      expect(texts(root)).toContain('Glissez la carte ou recherchez');
      expect(root.root.findByProps({ testID: 'mock-map' })).toBeTruthy();
    });
  });

  it('« Réessayer » sur l’échec de localisation relance getCurrentPosition et efface le message en cas de succès', async () => {
    mockGetCurrentPosition.mockResolvedValueOnce({ status: 'error', reason: 'timeout' });
    const root = await renderHome();
    await act(async () => {
      await Promise.resolve();
    });
    expect(root.root.findByProps({ testID: 'location-error' })).toBeTruthy();

    mockGetCurrentPosition.mockResolvedValueOnce({ status: 'success', position: CLIENT_GPS });
    mockReverseGeocode.mockResolvedValueOnce('Bonamoussadi, Douala');
    await act(async () => {
      root.root.findByProps({ testID: 'retry-location' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(root.root.findAllByProps({ testID: 'location-error' })).toHaveLength(0);
    expect(texts(root)).toContain('vers Bonamoussadi');
  });

  // 25 octobre (demande produit) : le rappel « c'est le point sur la carte qui fait foi » (doute
  // L6-06 §1) est retiré -- la carte reprend sa place. Le libellé reste préfixé « vers » quand il
  // vient du géocodage inverse : c'est lui qui dit encore que ce n'est qu'une approximation.
  it('le rappel « le point sur la carte fait foi » n’est plus affiché : la carte prend sa place', async () => {
    const root = await renderHome();

    expect(texts(root)).not.toContain('qui fait foi');
  });

  it("un accusé de réception refusé (limitation de débit) affiche un message distinct de « aucun chauffeur à proximité » (doute L6-06 §3)", async () => {
    const root = await renderHome();

    await act(async () => {
      emitSubscribeAck({ accepted: false, retryAfterMs: 4000 });
    });

    expect(texts(root)).toContain('Votre demande n’a pas été prise en compte, nouvelle tentative dans 4 s.');
    expect(texts(root)).not.toContain('Aucun chauffeur disponible pour l’instant.');
    expect(root.root.findByProps({ testID: 'subscribe-refused' })).toBeTruthy();
    expect(root.root.findAllByProps({ testID: 'retry-nearby' })).toHaveLength(0);
  });

  it('un abonnement refusé est réessayé automatiquement au délai annoncé par le serveur -- plus de bouton pour le faire', async () => {
    jest.useFakeTimers();
    await renderHome();
    await act(async () => {
      emitSubscribeAck({ accepted: false, retryAfterMs: 4000 });
    });
    mockSend.mockClear();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_900);
    });
    expect(mockSend).not.toHaveBeenCalledWith('nearby.subscribe', expect.anything());

    await act(async () => {
      await jest.advanceTimersByTimeAsync(200);
    });
    expect(mockSend).toHaveBeenCalledWith('nearby.subscribe', expect.objectContaining({ position: DOUALA }));
  });

  it('une liste de chauffeurs reçue après un refus efface le message de refus', async () => {
    const root = await renderHome();

    await act(async () => {
      emitSubscribeAck({ accepted: false, retryAfterMs: 4000 });
    });
    expect(root.root.findByProps({ testID: 'subscribe-refused' })).toBeTruthy();

    await act(async () => {
      emitNearbyDrivers([driver({ position: { latitude: 4.061, longitude: 9.719 } })]);
    });

    expect(root.root.findAllByProps({ testID: 'subscribe-refused' })).toHaveLength(0);
    expect(texts(root)).toContain('1 en ligne');
  });
});
