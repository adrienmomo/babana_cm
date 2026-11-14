import type { realtime } from '@babana/contracts';
import { asDriverId, asRideId } from '@babana/navigation';
import type { ClientParamList, RidePoint } from './navigation/types';
import { onRealtimeMessage } from './realtime';

/**
 * Reprise du suivi après une relance de l'app (14 novembre) : le client dont la course est
 * affectée ou en cours revenait à l'accueil, et ne voyait plus sa moto. `session.synced` porte
 * désormais sa course (`clientRide`, envoyé à chaque connexion) : ce module, indépendant des
 * écrans comme dans l'app Chauffeur (`proposalWatch.ts`), rouvre le suivi par-dessus l'accueil.
 *
 * Rien n'est deviné ici (invariant 3) : l'état vient du serveur, les points et le chauffeur aussi.
 */

export type TrackingParams = ClientParamList['Tracking'];

const UNNAMED_POINT = 'Point choisi sur la carte';

function point(raw: { latitude: number; longitude: number; label: string | null }): RidePoint {
  return { position: { latitude: raw.latitude, longitude: raw.longitude }, label: raw.label ?? UNNAMED_POINT };
}

/** Le suivi à rouvrir, ou `null` : pas de course à suivre, ou course pas encore affectée. */
export function trackingParamsFrom(message: realtime.ServerToClientMessage): TrackingParams | null {
  if (message.type !== 'session.synced') return null;
  const { activeRideId, activeRideState, clientRide } = message.payload;
  if (!activeRideId || !clientRide) return null;
  if (activeRideState !== 'assigned' && activeRideState !== 'in_progress') return null;
  return {
    rideId: asRideId(activeRideId),
    origin: point(clientRide.origin),
    destination: point(clientRide.destination),
    driver: { ...clientRide.driver, driverId: asDriverId(clientRide.driver.driverId) },
  };
}

export interface ResumeNavigation {
  isReady(): boolean;
  /** L'écran affiché et ses paramètres, pour ne pas rouvrir un suivi déjà à l'écran. */
  currentRoute(): { name: string; params?: unknown } | undefined;
  openTracking(params: TrackingParams): void;
}

let pending: TrackingParams | null = null;

/** Décision : ouvrir le suivi, ou le garder pour quand la navigation sera prête. */
export function resumeTracking(params: TrackingParams, navigation: ResumeNavigation): void {
  if (!navigation.isReady()) {
    pending = params;
    return;
  }
  const route = navigation.currentRoute();
  const shown = route?.name === 'Tracking' && (route.params as TrackingParams | undefined)?.rideId === params.rideId;
  if (shown) return; // simple reconnexion : l'écran de suivi en cours sait déjà où il en est
  navigation.openTracking(params);
}

/** À appeler quand la navigation devient prête (`NavigationContainer.onReady`). */
export function flushPendingResume(navigation: ResumeNavigation): void {
  const params = pending;
  pending = null;
  if (params) resumeTracking(params, navigation);
}

let started = false;

/** Point d'accroche unique (`navigation/index.tsx`). Idempotent. */
export function startRideResume(navigation: ResumeNavigation): void {
  if (started) return;
  started = true;
  onRealtimeMessage((message) => {
    const params = trackingParamsFrom(message);
    if (params) resumeTracking(params, navigation);
  });
}
