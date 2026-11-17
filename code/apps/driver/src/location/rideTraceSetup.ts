import { RIDE_TRACE_MAX_POINTS, RIDE_TRACE_PERSIST_EVERY } from '../../config';
import { offlineRunner } from '../offline';
import { onRealtimeMessage } from '../realtime';
import { createAsyncStorageRideTrace, RideTraceRecorder } from './rideTrace';
import { locationTracker } from './tracker';

/**
 * Instance de l'app (L4-16) : copie locale du trajet, téléversée par la file hors connexion. La
 * file est FIFO et persistante -- une fin de course mise en attente hors connexion part donc
 * avant ce téléversement, que le serveur n'accepte qu'après la fin.
 */
export const rideTrace = new RideTraceRecorder({
  storage: createAsyncStorageRideTrace(),
  upload: (rideId, points) =>
    offlineRunner.attempt('uploadRideTrack', { pathParams: { id: rideId }, body: { points } }),
  maxPoints: RIDE_TRACE_MAX_POINTS,
  persistEvery: RIDE_TRACE_PERSIST_EVERY,
});

let started = false;

export function startRideTrace(): void {
  if (started) return;
  started = true;
  rideTrace.restore().catch(() => {});
  onRealtimeMessage((message) => rideTrace.handleMessage(message));
  locationTracker.subscribeRideFix((fix) => rideTrace.record(fix));
}
