import React from 'react';
import { StyleSheet } from 'react-native';
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

describe('ConnectionBanner (L6-16, critère 1, app Client)', () => {
  afterEach(() => {
    mockListener = null;
  });

  test('connecté : aucun bandeau visible', async () => {
    mockState = 'connected';
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<ConnectionBanner />);
    });
    expect(label(root)).toMatch(/Connecté/);
  });

  test("connecté : le libellé caché n'a jamais une taille de police nulle (Android la refuse et plante l'app)", async () => {
    mockState = 'connected';
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<ConnectionBanner />);
    });
    const style = StyleSheet.flatten(root.root.findByProps({ testID: 'connection-banner-label' }).props.style);
    expect(style.fontSize).toBeGreaterThan(0);
  });

  test('dégradé et hors ligne restent distincts', async () => {
    mockState = 'connecting';
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<ConnectionBanner />);
    });
    const connectingLabel = label(root);

    await act(async () => {
      mockListener?.('offline');
    });
    const offlineLabel = label(root);

    expect(connectingLabel).not.toBe(offlineLabel);
    expect(offlineLabel).toMatch(/Hors ligne/);
  });
});
