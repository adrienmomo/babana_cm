import type { MapProvider } from './types';
import { webMapProvider } from './providers/web';

/**
 * Résolu à la place d'`activeProvider.ts` (natif) par l'extension `.web.ts` -- même mécanisme
 * que `tokenStorage.web.ts`/`googleSignIn.web.ts` de `@babana/api-client`. `MapView.tsx`,
 * `navigation.ts` et `places.ts` (racine du paquet) ne font que relayer `activeMapProvider`
 * (inchangés par cette tâche) : c'est ce fichier, seul, qui choisit -- jamais un `Platform.OS` lu
 * à l'exécution, qui aurait laissé `react-native-maps` atteignable depuis le graphe du bundle
 * web (webpack suit les imports statiquement, pas les branches conditionnelles).
 */
export const activeMapProvider: MapProvider = webMapProvider;
