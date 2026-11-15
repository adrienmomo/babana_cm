import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Décision du 14 novembre : l'écran du Client ne s'éteint pas tant qu'un écran carte a le focus.
const mockSetScreenAwake = jest.fn();
jest.mock('../screenWake', () => ({ setScreenAwake: (on: boolean) => mockSetScreenAwake(on) }));

import { holdScreenAwake, useKeepScreenAwake, type FocusSource } from '../keepAwake';

beforeEach(() => mockSetScreenAwake.mockClear());

function fakeFocus(focused: boolean) {
  const listeners: Record<string, Set<() => void>> = { focus: new Set(), blur: new Set() };
  const source: FocusSource & { fire: (event: 'focus' | 'blur') => void } = {
    isFocused: () => focused,
    addListener: (event, callback) => {
      listeners[event]!.add(callback);
      return () => listeners[event]!.delete(callback);
    },
    fire: (event) => listeners[event]!.forEach((callback) => callback()),
  };
  return source;
}

function MapScreen({ navigation }: { navigation: FocusSource }) {
  useKeepScreenAwake(navigation);
  return null;
}

test('un écran carte qui a le focus garde l’écran allumé ; il s’éteint à sa fermeture', async () => {
  const navigation = fakeFocus(true);
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<MapScreen navigation={navigation} />);
  });
  expect(mockSetScreenAwake).toHaveBeenLastCalledWith(true);

  await act(async () => root.unmount());
  expect(mockSetScreenAwake).toHaveBeenLastCalledWith(false);
});

test('écran recouvert par un écran sans carte (profil, historique) : l’écran peut s’éteindre, et se rallume au retour', async () => {
  const navigation = fakeFocus(true);
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<MapScreen navigation={navigation} />);
  });
  act(() => navigation.fire('blur'));
  expect(mockSetScreenAwake).toHaveBeenLastCalledWith(false);
  act(() => navigation.fire('focus'));
  expect(mockSetScreenAwake).toHaveBeenLastCalledWith(true);
  await act(async () => root.unmount());
});

test('écran monté sans le focus : rien n’est demandé', async () => {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<MapScreen navigation={fakeFocus(false)} />);
  });
  expect(mockSetScreenAwake).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test('compté : passer d’un écran carte à l’autre ne laisse jamais l’écran s’éteindre entre les deux', () => {
  const releaseHome = holdScreenAwake();
  const releaseTracking = holdScreenAwake(); // le suivant prend le focus avant que l'autre ne le rende
  releaseHome();
  releaseHome(); // relâcher deux fois ne décompte qu'une fois
  expect(mockSetScreenAwake.mock.calls).toEqual([[true]]);
  releaseTracking();
  expect(mockSetScreenAwake.mock.calls).toEqual([[true], [false]]);
});
