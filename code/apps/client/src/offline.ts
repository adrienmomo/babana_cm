import { createOfflineActionRunner, type OfflineActionRunner } from '@babana/api-client';
import { apiClient } from './auth';
import { onRealtimeConnectionStateChange } from './realtime';

/**
 * File des écritures REST autorisées hors connexion (L6-16) : notation d'une course
 * (`RideSummaryScreen`). Même patron que `apps/driver/src/offline.ts` (voir ce fichier pour le
 * raisonnement) -- un seul point de construction par app, rejouée automatiquement sur le même
 * signal de reconnexion que le client temps réel.
 */
export const offlineRunner: OfflineActionRunner = createOfflineActionRunner({ httpClient: apiClient });

onRealtimeConnectionStateChange((state) => {
  if (state === 'connected') offlineRunner.flush().catch(() => {});
});
