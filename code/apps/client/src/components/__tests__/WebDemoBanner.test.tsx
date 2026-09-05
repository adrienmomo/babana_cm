import React from 'react';
import { act, create } from 'react-test-renderer';

/**
 * Remplace `react-native` en entier, plutôt que de muter `Platform.OS` sur le double du
 * préréglage jest (`@react-native/jest-preset`) : constaté en écrivant ce test, `Platform.OS =
 * 'web'` sur ce double fait toujours tourner le RESTE de l'environnement de test en mode natif --
 * une partie de `View` y suppose alors `window.dispatchEvent` disponible et plante. `View`/`Text`
 * n'ont ici besoin d'être rien de plus que des éléments hôtes traversables par
 * `findAllByProps`/`findByProps` (react-test-renderer ne rend jamais de vrai DOM ni de vraie vue
 * native, ici comme dans le reste du paquet -- même discipline que
 * `packages/maps/__mocks__/react-native-maps.tsx`).
 */
let mockPlatformOS: 'ios' | 'android' | 'web' = 'ios';

jest.mock('react-native', () => {
  const react = require('react');
  return {
    Platform: { get OS() { return mockPlatformOS; } },
    StyleSheet: { create: (styles: unknown) => styles },
    View: ({ children, ...props }: { children?: unknown }) => react.createElement('rn-view', props, children),
    Text: ({ children, ...props }: { children?: unknown }) => react.createElement('rn-text', props, children),
  };
});

import { WebDemoBanner } from '../WebDemoBanner';

describe('WebDemoBanner (L6-18, dégradations signalées)', () => {
  afterEach(() => {
    mockPlatformOS = 'ios';
  });

  it('ne rend rien sur mobile (natif)', () => {
    mockPlatformOS = 'ios';
    let root!: ReturnType<typeof create>;
    act(() => {
      root = create(<WebDemoBanner />);
    });

    expect(root.root.findAllByProps({ testID: 'web-demo-banner' })).toHaveLength(0);
  });

  it('signale les dégradations sur le web -- notifications, arrière-plan, navigation, session', () => {
    mockPlatformOS = 'web';
    let root!: ReturnType<typeof create>;
    act(() => {
      root = create(<WebDemoBanner />);
    });

    const label = root.root.findByProps({ testID: 'web-demo-banner-label' });
    const text = String(label.props.children);

    expect(text).toMatch(/notifications/i);
    expect(text).toMatch(/arrière-plan/i);
    expect(text).toMatch(/navigation/i);
    expect(text).toMatch(/déconnecte/i);
  });
});
