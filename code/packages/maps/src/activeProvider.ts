import type { MapProvider } from './types';
import { googleMapProvider } from './providers/google';

/**
 * Le seul endroit qui choisit un fournisseur concret. En v1, un seul existe (Google, natif) ;
 * L6-18 ajoutera `providers/web` et fera dépendre ce choix de la plateforme ici -- jamais dans un
 * écran (critère d'acceptation 6, "aucune branche conditionnelle dans les écrans", même règle que
 * `@babana/ui`). `MapView.tsx`, `navigation.ts` et `places.ts` (racine du paquet) ne font que
 * relayer `activeMapProvider` : ce sont les seuls fichiers que L6-18 devra toucher pour brancher
 * un troisième fournisseur, jamais `apps/*`.
 */
export const activeMapProvider: MapProvider = googleMapProvider;
