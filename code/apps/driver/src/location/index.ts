/**
 * Barrel du dossier `location/` (L6-05). `getCurrentPosition` réexporté tel quel pour que
 * `ActiveRideScreen.tsx` (`import { getCurrentPosition } from '../location'`) continue de
 * fonctionner sans changement -- ce dossier remplace l'ancien fichier `location.ts`.
 */
export { getCurrentPosition } from './oneShot';
export { locationTracker } from './tracker';
export type { DriverActivityState } from './adaptive';
export type { LocationMetricsSnapshot } from './tracker';
