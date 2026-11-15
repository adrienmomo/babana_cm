import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { PALETTES, ThemePicker, ThemeProvider, makeStyles, resolveScheme, useTheme, type ThemeMode } from '@babana/ui';

// 15 novembre : thèmes clair, sombre, noir, ou celui du téléphone ; choix gardé sur le téléphone.

const useProbeStyles = makeStyles((c) => ({ label: { color: c.ink, backgroundColor: c.canvas } }));

function Probe() {
  const styles = useProbeStyles();
  const { mode } = useTheme();
  return (
    <Text testID="probe" style={styles.label}>
      {mode}
    </Text>
  );
}

function memoryStorage(initial: string | null) {
  const saved: ThemeMode[] = [];
  return {
    saved,
    storage: {
      get: jest.fn(async () => initial),
      set: jest.fn(async (mode: ThemeMode) => {
        saved.push(mode);
      }),
    },
  };
}

async function render(storage: ReturnType<typeof memoryStorage>['storage']): Promise<ReactTestRenderer> {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(
      <ThemeProvider storage={storage}>
        <Probe />
        <ThemePicker />
      </ThemeProvider>
    );
  });
  return root;
}

const probeStyle = (root: ReactTestRenderer) => root.root.findByProps({ testID: 'probe' }).props.style as { color: string; backgroundColor: string };

test('« Téléphone » suit le réglage du téléphone ; les trois autres s’imposent', () => {
  expect(resolveScheme('system', 'dark')).toBe('dark');
  expect(resolveScheme('system', 'light')).toBe('light');
  expect(resolveScheme('system', null)).toBe('light');
  expect(resolveScheme('black', 'light')).toBe('black');
  expect(resolveScheme('light', 'dark')).toBe('light');
});

test('le choix gardé sur le téléphone s’applique à l’ouverture', async () => {
  const { storage } = memoryStorage('black');
  const root = await render(storage);
  expect(probeStyle(root).backgroundColor).toBe(PALETTES.black.canvas);
  expect(probeStyle(root).backgroundColor).toBe('#000000');
});

test('choisir « Sombre » repeint l’écran et garde le choix ; une valeur inconnue est ignorée', async () => {
  const { storage, saved } = memoryStorage('n’importe quoi');
  const root = await render(storage);
  expect(probeStyle(root).color).toBe(PALETTES.light.ink);

  await act(async () => {
    root.root.findByProps({ testID: 'theme-picker-dark' }).props.onPress();
  });

  expect(probeStyle(root).color).toBe(PALETTES.dark.ink);
  expect(saved).toEqual(['dark']);
  expect(root.root.findByProps({ testID: 'theme-picker-dark' }).props.accessibilityState).toEqual({ selected: true });
});

test('sans fournisseur (écran isolé, tests) : le thème clair', async () => {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<Probe />);
  });
  expect(probeStyle(root).backgroundColor).toBe(PALETTES.light.canvas);
});
