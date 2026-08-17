import { activeMapProvider } from './activeProvider';

/**
 * Composant carte public (L6-01). Un écran importe `MapView` d'ici, jamais d'un fournisseur --
 * c'est ce qui rend L6-18 (fournisseur web) invisible pour les écrans.
 */
export const MapView = activeMapProvider.MapView;
