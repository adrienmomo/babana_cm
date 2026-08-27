import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { asRideId } from '@babana/navigation';
import { ApiError } from '@babana/api-client';

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

import { RideSummaryScreen } from '../RideSummaryScreen';

const RIDE_ID = asRideId('ride-1');

const BREAKDOWN = {
  baseFare: 200,
  distanceFare: 1000,
  surgeAmount: 300,
  discountAmount: 100,
  floorAmount: 0,
  roundingAmount: 50,
  minimumFareApplied: false,
};

function fakeNavigation() {
  return { navigate: jest.fn(), reset: jest.fn() };
}

const renderedRoots: ReactTestRenderer[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of renderedRoots.splice(0)) root.unmount();
  });
});

async function renderSummary(
  navigation = fakeNavigation(),
  params: { distanceMeters: number | null; durationSeconds: number | null } = {
    distanceMeters: 4200,
    durationSeconds: 780,
  }
): Promise<{ root: ReactTestRenderer; navigation: ReturnType<typeof fakeNavigation> }> {
  const route = {
    key: 'RideSummary',
    name: 'RideSummary' as const,
    params: { rideId: RIDE_ID, amount: 1450, breakdown: BREAKDOWN, ...params },
  };
  let root!: ReactTestRenderer;
  await act(async () => {
    // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran
    root = create(<RideSummaryScreen navigation={navigation} route={route} />);
  });
  renderedRoots.push(root);
  return { root, navigation };
}

function fcfa(amount: number): string {
  return `${amount.toLocaleString('fr-FR')} FCFA`;
}

function texts(root: ReactTestRenderer): string {
  return root.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('RideSummaryScreen (L6-09)', () => {
  it('critère 4 : le résumé contient exactement le détail décomposé reçu, jamais recalculé', async () => {
    const { root } = await renderSummary();

    expect(texts(root)).toContain(fcfa(1450));
    expect(texts(root)).toContain('Prise en charge');
    expect(texts(root)).toContain(fcfa(200));
    expect(texts(root)).toContain('Majoration');
    expect(texts(root)).toContain(fcfa(300));
    expect(texts(root)).toContain('Remise');
    expect(texts(root)).toContain(`-${fcfa(100)}`);
    // Ligne nulle (floorAmount) absente -- même règle que QuoteScreen.
    expect(texts(root)).not.toContain('Ajustement plancher');
    expect(texts(root)).toContain('4.2 km');
    expect(texts(root)).toContain('13 min');
  });

  it('J24 (amoa/questions/L6-13.md) : trajet non relevé -> « Trajet non relevé », jamais un chiffre faux', async () => {
    const { root } = await renderSummary(fakeNavigation(), { distanceMeters: null, durationSeconds: null });
    expect(root.root.findByProps({ testID: 'ride-summary-trip-meta' }).props.children).toBe('Trajet non relevé');
    // Le montant, lui, reste affiché : la décision financière existe toujours (distance de référence).
    expect(texts(root)).toContain(fcfa(1450));
  });

  it("aucune immatriculation ni identité du chauffeur n'est affichée -- décidé explicitement (doute du 26 août)", async () => {
    const { root } = await renderSummary();

    expect(texts(root).toLowerCase()).not.toContain('lt-1234');
    expect(root.root.findAllByProps({ testID: 'tracking-plate' })).toHaveLength(0);
  });

  it('critère 5 : la notation est proposée, sans être bloquante -- Terminer reste disponible sans noter', async () => {
    const { root, navigation } = await renderSummary();

    expect(root.root.findByProps({ testID: 'rating-box' })).toBeTruthy();
    const doneButton = root.root.findByProps({ testID: 'ride-summary-done' });
    expect(doneButton.props.disabled).toBeFalsy();

    await act(async () => {
      doneButton.props.onPress();
    });

    expect(navigation.reset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Home' }] });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('envoie la note choisie via POST /rides/{id}/rate', async () => {
    mockRequest.mockResolvedValue({ rideId: RIDE_ID, rating: 5 });
    const { root } = await renderSummary();

    await act(async () => {
      root.root.findByProps({ testID: 'rating-star-5' }).props.onPress();
    });
    await act(async () => {
      root.root.findByProps({ testID: 'submit-rating' }).props.onPress();
    });

    expect(mockRequest).toHaveBeenCalledWith('rateRide', { pathParams: { id: RIDE_ID }, body: { rating: 5 } });
    expect(root.root.findByProps({ testID: 'rating-thanks' })).toBeTruthy();
  });

  it('un envoi impossible (déjà notée) affiche un message clair, sans bloquer le reste de l’écran', async () => {
    mockRequest.mockRejectedValue(new ApiError('RATING_ALREADY_SUBMITTED', 'Cette course a déjà été notée.', 409));
    const { root } = await renderSummary();

    await act(async () => {
      root.root.findByProps({ testID: 'rating-star-4' }).props.onPress();
    });
    await act(async () => {
      root.root.findByProps({ testID: 'submit-rating' }).props.onPress();
    });

    expect(texts(root)).toContain('Vous avez déjà noté cette course.');
    expect(root.root.findByProps({ testID: 'ride-summary-done' }).props.disabled).toBeFalsy();
  });

  it('« Voir la facture » navigue vers Invoice avec le rideId', async () => {
    const { root, navigation } = await renderSummary();

    await act(async () => {
      root.root.findByProps({ testID: 'view-invoice' }).props.onPress();
    });

    expect(navigation.navigate).toHaveBeenCalledWith('Invoice', { rideId: RIDE_ID });
  });
});
