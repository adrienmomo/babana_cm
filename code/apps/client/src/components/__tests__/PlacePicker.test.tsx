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

describe('PlacePicker (L6-06, second moyen de désignation)', () => {
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
