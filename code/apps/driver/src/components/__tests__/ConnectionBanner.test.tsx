import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

let mockState: 'offline' | 'connecting' | 'connected' = 'connected';
let mockListener: ((state: 'offline' | 'connecting' | 'connected') => void) | null = null;

jest.mock('../../realtime', () => ({
  realtimeClient: { getState: () => mockState },
  onRealtimeConnectionStateChange: (l: (state: 'offline' | 'connecting' | 'connected') => void) => {
    mockListener = l;
    return () => {
      mockListener = null;
    };
  },
}));

import { ConnectionBanner } from '../ConnectionBanner';

function label(root: ReactTestRenderer): string {
  return JSON.stringify(root.root.findByProps({ testID: 'connection-banner-label' }).props.children);
}

describe('ConnectionBanner (L6-16, critère 1)', () => {
  afterEach(() => {
    mockListener = null;
  });

  test('connecté : aucun bandeau visible, mais un état porté (accessibilité)', async () => {
    mockState = 'connected';
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<ConnectionBanner />);
    });
    expect(label(root)).toMatch(/Connecté/);
  });

  test('dégradé (connecting) : bandeau visible, mentionne les actions en attente', async () => {
    mockState = 'connecting';
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<ConnectionBanner />);
    });
    expect(label(root)).toMatch(/dégradée/);
    expect(label(root)).toMatch(/attente/);
  });

  test('hors ligne : bandeau visible, distinct du dégradé', async () => {
    mockState = 'offline';
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<ConnectionBanner />);
    });
    expect(label(root)).toMatch(/Hors ligne/);
  });

  test('les trois états sont distincts (jamais deux confondus)', async () => {
    let root!: ReactTestRenderer;
    mockState = 'connected';
    await act(async () => {
      root = create(<ConnectionBanner />);
    });
    const connectedLabel = label(root);

    await act(async () => {
      mockListener?.('connecting');
    });
    const connectingLabel = label(root);

    await act(async () => {
      mockListener?.('offline');
    });
    const offlineLabel = label(root);

    const labels = new Set([connectedLabel, connectingLabel, offlineLabel]);
    expect(labels.size).toBe(3);
  });

  test("réagit à un changement d'état sans redémonter (bandeau qui apparaît en direct)", async () => {
    mockState = 'connected';
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<ConnectionBanner />);
    });
    expect(root.root.findAllByType(Text).length).toBeGreaterThan(0);

    await act(async () => {
      mockListener?.('offline');
    });

    expect(label(root)).toMatch(/Hors ligne/);
  });
});
