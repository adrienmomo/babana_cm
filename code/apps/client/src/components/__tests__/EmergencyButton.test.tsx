import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { PendingIncidentQueue, createInMemoryPendingIncidentQueue, ApiError } from '@babana/api-client';

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

const mockGetCurrentPosition = jest.fn();
jest.mock('../../location', () => ({
  getCurrentPosition: (...args: unknown[]) => mockGetCurrentPosition(...args),
}));

// File en mémoire réelle (pas un double) -- exerce le vrai comportement de mise en file/retrait
// (@babana/api-client, déjà prouvé isolément) sans toucher AsyncStorage dans ce test de
// composant.
const mockQueue = new PendingIncidentQueue(createInMemoryPendingIncidentQueue());
jest.mock('../../incidentQueue', () => ({
  get pendingIncidentQueue() {
    return mockQueue;
  },
}));

import { EmergencyButton } from '../EmergencyButton';

const POSITION = { latitude: 4.05, longitude: 9.7 };

function findButton(root: ReactTestRenderer) {
  return root.root.findByProps({ testID: 'emergency-button' });
}

async function longPress(root: ReactTestRenderer) {
  const button = findButton(root);
  await act(async () => {
    button.props.onPressIn();
  });
  await act(async () => {
    await button.props.onLongPress();
  });
}

describe('EmergencyButton (L8-04)', () => {
  beforeEach(async () => {
    mockRequest.mockReset();
    mockGetCurrentPosition.mockReset();
    mockGetCurrentPosition.mockResolvedValue({ status: 'success', position: POSITION });
    for (const trigger of await mockQueue.list()) {
      await mockQueue.remove(trigger.idempotencyKey);
    }
  });

  // --- Critère 1 : atteignable en un geste, mais un simple appui bref ne déclenche rien -----

  test('un relâchement avant le délai de maintien ne déclenche aucun appel réseau', async () => {
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<EmergencyButton rideId="ride-1" />);
    });
    const button = findButton(root);

    await act(async () => {
      button.props.onPressIn();
    });
    await act(async () => {
      button.props.onPressOut();
    });

    expect(mockRequest).not.toHaveBeenCalled();
  });

  // --- Critère 2 : la position exacte est enregistrée ----------------------------------------

  test('un appui long envoie la position exacte au serveur', async () => {
    mockRequest.mockResolvedValue({ id: 'incident-1', status: 'open', position: POSITION, triggeredAt: '2026-08-24T21:00:00.000Z' });
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<EmergencyButton rideId="ride-1" />);
    });

    await longPress(root);

    expect(mockRequest).toHaveBeenCalledWith(
      'triggerIncident',
      expect.objectContaining({
        pathParams: { id: 'ride-1' },
        body: expect.objectContaining({ latitude: POSITION.latitude, longitude: POSITION.longitude }),
      })
    );
  });

  test('confirmation affichée une fois l\'alerte réellement envoyée', async () => {
    mockRequest.mockResolvedValue({ id: 'incident-1', status: 'open', position: POSITION, triggeredAt: '2026-08-24T21:00:00.000Z' });
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<EmergencyButton rideId="ride-1" />);
    });

    await longPress(root);

    expect(root.root.findByProps({ testID: 'emergency-button-label' }).props.children).toMatch(/envoyée/);
  });

  // --- Critère 6 : hors connexion, mis en file avec la position d'origine --------------------

  test('un échec réseau met le déclenchement en file plutôt que de le perdre', async () => {
    mockRequest.mockRejectedValue(new TypeError('network down'));
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<EmergencyButton rideId="ride-1" />);
    });

    await longPress(root);

    const pending = await mockQueue.list();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ rideId: 'ride-1', latitude: POSITION.latitude, longitude: POSITION.longitude });
  });

  test('remonter l\'écran rejoue un déclenchement resté en file (redémarrage en pleine coupure)', async () => {
    await mockQueue.enqueue({ rideId: 'ride-1', latitude: 4.05, longitude: 9.7, triggeredAt: '2026-08-24T20:00:00.000Z' });
    mockRequest.mockResolvedValue({ id: 'incident-1', status: 'open', position: POSITION, triggeredAt: '2026-08-24T20:00:00.000Z' });

    await act(async () => {
      create(<EmergencyButton rideId="ride-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockRequest).toHaveBeenCalled();
    expect(await mockQueue.list()).toHaveLength(0);
  });

  // --- Une erreur métier n'est pas rejouée indéfiniment ---------------------------------------

  test('une erreur métier (course non active) retire le déclenchement de la file, affiche le message', async () => {
    mockRequest.mockRejectedValue(new ApiError('RIDE_NOT_ACTIVE', 'technical', 409));
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<EmergencyButton rideId="ride-1" />);
    });

    await longPress(root);

    expect(await mockQueue.list()).toHaveLength(0);
    expect(root.root.findByProps({ testID: 'emergency-error' }).props.children).toBeTruthy();
  });

  // --- Sans position, le bouton n'invente rien -------------------------------------------------

  test('sans position disponible, aucun appel réseau n\'est tenté', async () => {
    mockGetCurrentPosition.mockResolvedValue({ status: 'error', reason: 'permission-denied' });
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<EmergencyButton rideId="ride-1" />);
    });

    await longPress(root);

    expect(mockRequest).not.toHaveBeenCalled();
  });
});
