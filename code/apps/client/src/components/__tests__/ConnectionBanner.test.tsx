import React from 'react';
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
