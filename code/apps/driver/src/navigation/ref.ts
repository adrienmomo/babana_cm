import { createNavigationContainerRef } from '@react-navigation/native';
import type { DriverParamList } from './types';

/**
 * Réf de navigation partagée -- isolée dans son propre module pour qu'un consommateur hors de
 * l'arbre d'écrans (`push/handlers.ts`, L7-04) puisse l'importer sans créer de cycle avec
 * `navigation/index.tsx` (qui importe les écrans, qui importent `push/handlers.ts`).
 *
 * Typée `DriverParamList` seulement : valide uniquement quand `DriverNavigator` est monté
 * (chauffeur `approved`) -- exactement le cas où une proposition, une course en cours ou leurs
 * transitions ont un sens.
 */
export const navigationRef = createNavigationContainerRef<DriverParamList>();
