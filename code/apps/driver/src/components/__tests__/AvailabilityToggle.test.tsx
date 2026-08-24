import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ApiError } from '@babana/api-client';

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

import { AvailabilityToggle } from '../AvailabilityToggle';

function texts(root: ReactTestRenderer): string {
  return root.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

async function renderToggle(props: Partial<{ inCourse: boolean; onNavigateToRemittance: () => void }> = {}): Promise<ReactTestRenderer> {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(
      <AvailabilityToggle inCourse={props.inCourse ?? false} onNavigateToRemittance={props.onNavigateToRemittance ?? jest.fn()} />
    );
  });
  return root;
}

async function press(root: ReactTestRenderer) {
  await act(async () => {
    root.root.findByProps({ testID: 'availability-toggle' }).props.onPress();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AvailabilityToggle (L6-11, D7)', () => {
  it('bascule en ligne avec succès -- l’état affiché reflète la réponse du serveur, pas une supposition locale', async () => {
    mockRequest.mockResolvedValue({ online: true });
    const root = await renderToggle();

    expect(texts(root)).toContain('Hors ligne');
    await press(root);

    expect(mockRequest).toHaveBeenCalledWith('setAvailability', { body: { online: true } });
    expect(texts(root)).toContain('En ligne');
  });

  it('critère 1 -- chaque motif de refus affiche un message distinct', async () => {
    const cases: Array<[string, string]> = [
      ['DRIVER_NOT_APPROVED', 'Votre dossier chauffeur est en cours de validation.'],
      ['MOTORCYCLE_NOT_ASSIGNED', "Aucune moto ne vous a encore été attribuée. Contactez l'assistance."],
      ['INSURANCE_EXPIRED', "L'assurance de votre moto a expiré. Contactez l'assistance."],
      ['LICENSE_EXPIRED', "Votre permis de conduire a expiré. Contactez l'assistance."],
      ['DRIVER_HAS_ACTIVE_RIDE', 'Impossible de vous mettre hors ligne pendant une course.'],
    ];

    for (const [code, expectedMessage] of cases) {
      mockRequest.mockRejectedValueOnce(new ApiError(code as never, 'x', 403));
      const root = await renderToggle();
      await press(root);
      expect(texts(root)).toContain(expectedMessage);
    }
  });

  it('critère 2 -- le motif « plafond » propose l’accès à la déclaration de remise (L5-07)', async () => {
    mockRequest.mockRejectedValue(new ApiError('CASH_LIMIT_REACHED', 'x', 403));
    const onNavigateToRemittance = jest.fn();
    const root = await renderToggle({ onNavigateToRemittance });

    await press(root);

    expect(texts(root)).toContain("Votre plafond d'encaisse est atteint. Faites une remise pour continuer.");
    const remittanceButton = root.root.findByProps({ testID: 'availability-go-to-remittance' });
    expect(remittanceButton).toBeTruthy();

    await act(async () => {
      remittanceButton.props.onPress();
    });
    expect(onNavigateToRemittance).toHaveBeenCalledTimes(1);
  });

  it('un motif autre que le plafond ne propose jamais le bouton de remise', async () => {
    mockRequest.mockRejectedValue(new ApiError('DRIVER_NOT_APPROVED', 'x', 403));
    const root = await renderToggle();

    await press(root);

    expect(root.root.findAllByProps({ testID: 'availability-go-to-remittance' })).toHaveLength(0);
  });

  it('critère 3 -- l’interrupteur est désactivé en course, avec explication', async () => {
    const root = await renderToggle({ inCourse: true });

    expect(root.root.findByProps({ testID: 'availability-toggle' }).props.disabled).toBe(true);
    expect(texts(root)).toContain('Vous ne pouvez pas repasser hors ligne pendant une course.');

    await press(root);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('une panne réseau (pas une ApiError) affiche un message générique de réessai, jamais un motif inventé', async () => {
    mockRequest.mockRejectedValue(new Error('fetch failed'));
    const root = await renderToggle();

    await press(root);

    expect(texts(root)).toContain('La mise à jour a échoué. Réessayez.');
  });
});
