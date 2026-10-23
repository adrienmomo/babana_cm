import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { PlaceResult } from '@babana/maps';

const mockSearchPlace = jest.fn<Promise<PlaceResult[]>, [string]>();
jest.mock('@babana/maps', () => ({
  searchPlace: (query: string) => mockSearchPlace(query),
}));

import { PlacePicker } from '../PlacePicker';

function immediateWait(): Promise<void> {
  return Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchPlace.mockResolvedValue([]);
});

async function typeQuery(query: string): Promise<ReactTestRenderer> {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<PlacePicker placeholder="Rechercher" onSelect={jest.fn()} wait={immediateWait} />);
  });
  await act(async () => {
    root.root.findByType(TextInput).props.onChangeText(query);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
  return root;
}

function shownTexts(root: ReactTestRenderer): string {
  return root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children)).join(' ');
}

describe('PlacePicker (L6-06, second moyen de désignation)', () => {
  // Constaté le 22 octobre sur émulateur : Google refusait la recherche (API non activée) et
  // l'écran restait muet, exactement comme pour un lieu inconnu -- rien ne disait à l'utilisateur
  // de désigner le point sur la carte à la place.
  it('une recherche en échec le dit, et renvoie vers la carte -- jamais un silence', async () => {
    mockSearchPlace.mockRejectedValue(new Error('PERMISSION_DENIED'));
    const root = await typeQuery('Akwa');

    expect(root.root.findAllByProps({ testID: 'place-search-error' }).length).toBeGreaterThan(0);
    expect(shownTexts(root)).toContain('Recherche indisponible');
  });

  it('aucun résultat le dit aussi, distinctement d’une panne', async () => {
    mockSearchPlace.mockResolvedValue([]);
    const root = await typeQuery('Zzzz');

    expect(shownTexts(root)).toContain('Aucun lieu trouvé');
    expect(root.root.findAllByProps({ testID: 'place-search-error' })).toHaveLength(0);
  });

  it("n'appelle pas la recherche en dessous du seuil minimal de caractères", async () => {
    const onSelect = jest.fn();
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<PlacePicker placeholder="Rechercher" onSelect={onSelect} wait={immediateWait} />);
    });

    await act(async () => {
      root.root.findByType(TextInput).props.onChangeText('Bo');
      await Promise.resolve();
    });

    expect(mockSearchPlace).not.toHaveBeenCalled();
  });

  it('déclenche la recherche une fois le seuil atteint, après la temporisation', async () => {
    mockSearchPlace.mockResolvedValue([{ label: 'Bonanjo, Douala', position: { latitude: 4.05, longitude: 9.69 } }]);
    const onSelect = jest.fn();
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<PlacePicker placeholder="Rechercher" onSelect={onSelect} wait={immediateWait} />);
    });

    await act(async () => {
      root.root.findByType(TextInput).props.onChangeText('Bonanjo');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockSearchPlace).toHaveBeenCalledWith('Bonanjo');
    expect(root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children)).join(' ')).toContain(
      'Bonanjo, Douala'
    );
  });

  it('une sélection appelle onSelect, vide le champ et referme les résultats', async () => {
    const place = { label: 'Bonanjo, Douala', position: { latitude: 4.05, longitude: 9.69 } };
    mockSearchPlace.mockResolvedValue([place]);
    const onSelect = jest.fn();
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<PlacePicker placeholder="Rechercher" onSelect={onSelect} wait={immediateWait} />);
    });
    await act(async () => {
      root.root.findByType(TextInput).props.onChangeText('Bonanjo');
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      root.root.findByProps({ testID: 'place-result-0' }).props.onPress();
    });

    expect(onSelect).toHaveBeenCalledWith({ label: 'Bonanjo, Douala', position: place.position });
    expect(root.root.findByType(TextInput).props.value).toBe('');
    expect(root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children)).join(' ')).not.toContain(
      'Bonanjo, Douala'
    );
  });

  it("une réponse en retard d'une recherche abandonnée n'écrase pas les résultats de la recherche suivante", async () => {
    let resolveFirst!: (value: PlaceResult[]) => void;
    mockSearchPlace.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );
    mockSearchPlace.mockResolvedValueOnce([
      { label: 'Résultat récent', position: { latitude: 4.05, longitude: 9.69 } },
    ]);
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<PlacePicker placeholder="Rechercher" onSelect={jest.fn()} wait={immediateWait} />);
    });

    await act(async () => {
      root.root.findByType(TextInput).props.onChangeText('premier');
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      root.root.findByType(TextInput).props.onChangeText('second');
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      resolveFirst([{ label: 'Résultat périmé', position: { latitude: 0, longitude: 0 } }]);
      await Promise.resolve();
    });

    const rendered = root.root.findAllByType(Text).map((n) => JSON.stringify(n.props.children)).join(' ');
    expect(rendered).toContain('Résultat récent');
    expect(rendered).not.toContain('Résultat périmé');
  });
});
