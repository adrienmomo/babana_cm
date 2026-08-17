import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { searchPlace, type PlaceResult } from '@babana/maps';
import type { RidePoint } from '../navigation/types';

/**
 * Recherche de lieu par texte (L6-06, second des deux moyens de désignation -- complément du
 * déplacement de carte sous réticule, jamais le chemin principal : l'adresse formelle n'existe
 * quasiment pas à Douala). Composant de saisie autonome : il ne connaît pas le point
 * actuellement désigné (départ ou arrivée), seulement `onSelect` -- HomeScreen reste la seule
 * source de vérité pour "quel point est actif" et pour son libellé courant, affiché ailleurs à
 * l'écran (jamais dans ce champ, qui redevient vide après une sélection).
 */
export interface PlacePickerProps {
  placeholder: string;
  onSelect: (point: RidePoint) => void;
  /** Injectable pour les tests -- une vraie temporisation par défaut. */
  wait?: (ms: number) => Promise<void>;
}

const SEARCH_DEBOUNCE_MS = 400;
const MIN_QUERY_LENGTH = 3;

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function PlacePicker({ placeholder, onSelect, wait = defaultWait }: PlacePickerProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [searching, setSearching] = useState(false);
  // Identifie la recherche la plus récente : une réponse en retard d'une requête abandonnée ne
  // doit jamais écraser le résultat d'une requête plus récente (l'utilisateur tape vite, le
  // réseau mobile est lent et inégal -- CLAUDE.md, "le réseau mobile est intermittent").
  const requestId = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setSearching(false);
      return;
    }

    const thisRequest = ++requestId.current;
    let cancelled = false;
    setSearching(true);

    (async () => {
      // Un appel réseau par frappe enverrait des dizaines de requêtes pour un seul mot tapé, sur
      // un forfait de données compté -- même raisonnement que le géocodage inverse au relâchement
      // du geste de carte, appliqué ici à la saisie.
      await wait(SEARCH_DEBOUNCE_MS);
      if (cancelled || requestId.current !== thisRequest) return;
      try {
        const found = await searchPlace(trimmed);
        if (!cancelled && requestId.current === thisRequest) setResults(found);
      } catch {
        if (!cancelled && requestId.current === thisRequest) setResults([]);
      } finally {
        if (!cancelled && requestId.current === thisRequest) setSearching(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [query, wait]);

  function handleSelect(result: PlaceResult) {
    setQuery('');
    setResults([]);
    onSelect({ position: result.position, label: result.label });
  }

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        placeholder={placeholder}
        value={query}
        onChangeText={setQuery}
        accessibilityLabel={placeholder}
      />
      {searching ? <ActivityIndicator style={styles.spinner} size="small" /> : null}
      {results.length > 0 ? (
        <FlatList
          style={styles.results}
          data={results}
          keyExtractor={(item, index) => `${item.label}-${index}`}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item, index }) => (
            <Pressable testID={`place-result-${index}`} style={styles.resultRow} onPress={() => handleSelect(item)}>
              <Text numberOfLines={1}>{item.label}</Text>
            </Pressable>
          )}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
  },
  input: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#FFFFFF',
  },
  spinner: {
    position: 'absolute',
    right: 12,
    top: 10,
  },
  results: {
    maxHeight: 180,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderTopWidth: 0,
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
  },
  resultRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  },
});
