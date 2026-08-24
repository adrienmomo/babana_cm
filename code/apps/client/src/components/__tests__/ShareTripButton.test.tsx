import React from 'react';
import { Share } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ApiError } from '@babana/api-client';

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

import { ShareTripButton } from '../ShareTripButton';

const URL = 'https://babana.cm/s/fixture-tok';

describe('ShareTripButton (L8-03)', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('un appui crée le partage puis ouvre le sélecteur natif avec le lien', async () => {
    mockRequest.mockResolvedValueOnce({ token: 'fixture-tok', url: URL, expiresAt: null });
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<ShareTripButton rideId="ride-1" />);
    });

    await act(async () => {
      await root.root.findByProps({ testID: 'share-trip-button' }).props.onPress();
    });

    expect(mockRequest).toHaveBeenCalledWith('createRideShare', { pathParams: { id: 'ride-1' } });
    expect(Share.share).toHaveBeenCalledWith({ message: URL });
    expect(root.root.findByProps({ testID: 'share-link' }).props.children).toBe(URL);
  });

  test('le sélecteur natif indisponible (export web) n\'empêche pas d\'afficher le lien', async () => {
    mockRequest.mockResolvedValueOnce({ token: 't', url: URL, expiresAt: null });
    (Share.share as jest.Mock).mockRejectedValueOnce(new Error('Share is not implemented'));
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<ShareTripButton rideId="ride-1" />);
    });

    await act(async () => {
      await root.root.findByProps({ testID: 'share-trip-button' }).props.onPress();
    });

    expect(root.root.findByProps({ testID: 'share-link' }).props.children).toBe(URL);
  });

  test('critère 4 : arrêter le partage révoque immédiatement', async () => {
    mockRequest.mockResolvedValueOnce({ token: 't', url: URL, expiresAt: null });
    mockRequest.mockResolvedValueOnce({ revoked: true });
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<ShareTripButton rideId="ride-1" />);
    });
    await act(async () => {
      await root.root.findByProps({ testID: 'share-trip-button' }).props.onPress();
    });

    await act(async () => {
      await root.root.findByProps({ testID: 'share-stop-button' }).props.onPress();
    });

    expect(mockRequest).toHaveBeenCalledWith('revokeRideShare', { pathParams: { id: 'ride-1' } });
    expect(root.root.findAllByProps({ testID: 'share-link' })).toHaveLength(0);
    expect(root.root.findByProps({ testID: 'share-trip-button' })).toBeTruthy();
  });

  test('une erreur métier à la création affiche le message traduit, jamais le code brut', async () => {
    mockRequest.mockRejectedValueOnce(new ApiError('RIDE_NOT_ACTIVE', 'technical', 409));
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<ShareTripButton rideId="ride-1" />);
    });

    await act(async () => {
      await root.root.findByProps({ testID: 'share-trip-button' }).props.onPress();
    });

    const message = root.root.findByProps({ testID: 'share-error' }).props.children;
    expect(message).not.toMatch(/RIDE_NOT_ACTIVE/);
    expect(typeof message).toBe('string');
    expect(message.length).toBeGreaterThan(0);
  });
});
