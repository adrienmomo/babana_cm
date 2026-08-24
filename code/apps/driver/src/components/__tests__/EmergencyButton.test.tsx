import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { PendingIncidentQueue, createInMemoryPendingIncidentQueue, ApiError } from '@babana/api-client';

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

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

describe('EmergencyButton, app Chauffeur (L8-04)', () => {
  let mockGetPosition: jest.Mock;

  beforeEach(async () => {
    mockRequest.mockReset();
    mockGetPosition = jest.fn().mockResolvedValue(POSITION);
    for (const trigger of await mockQueue.list()) {
      await mockQueue.remove(trigger.idempotencyKey);
    }
  });

  test('un appui long envoie la position injectée au serveur', async () => {
    mockRequest.mockResolvedValue({ id: 'incident-1', status: 'open', position: POSITION, triggeredAt: '2026-08-24T21:00:00.000Z' });
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<EmergencyButton rideId="ride-1" getPosition={mockGetPosition} />);
    });

    await longPress(root);

    expect(mockGetPosition).toHaveBeenCalled();
    expect(mockRequest).toHaveBeenCalledWith(
      'triggerIncident',
      expect.objectContaining({
        pathParams: { id: 'ride-1' },
        body: expect.objectContaining({ latitude: POSITION.latitude, longitude: POSITION.longitude }),
      })
    );
  });

  test('critère 6 : un échec réseau met le déclenchement en file plutôt que de le perdre', async () => {
    mockRequest.mockRejectedValue(new TypeError('network down'));
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<EmergencyButton rideId="ride-1" getPosition={mockGetPosition} />);
    });

    await longPress(root);

    expect(await mockQueue.list()).toHaveLength(1);
  });

  test('une erreur métier retire le déclenchement de la file, affiche le message traduit', async () => {
    mockRequest.mockRejectedValue(new ApiError('RIDE_NOT_ACTIVE', 'technical', 409));
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<EmergencyButton rideId="ride-1" getPosition={mockGetPosition} />);
    });

    await longPress(root);

    expect(await mockQueue.list()).toHaveLength(0);
    expect(root.root.findByProps({ testID: 'emergency-error' }).props.children).toBeTruthy();
  });

  test('sans position disponible (getPosition résout null), aucun appel réseau n\'est tenté', async () => {
    mockGetPosition.mockResolvedValue(null);
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<EmergencyButton rideId="ride-1" getPosition={mockGetPosition} />);
    });

    await longPress(root);

    expect(mockRequest).not.toHaveBeenCalled();
  });
});
