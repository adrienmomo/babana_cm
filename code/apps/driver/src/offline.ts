import { createOfflineActionRunner, type OfflineActionRunner } from '@babana/api-client';
import { apiClient } from './auth';
import { onRealtimeConnectionStateChange } from './realtime';

/**
 * File des écritures REST autorisées hors connexion (L6-16) : confirmation d'encaissement
 * (`SettlementScreen`), fin de course (`ActiveRideScreen`), déclaration de remise
 * (`RemittanceScreen`). Un seul point de construction par app -- même convention que
 * `apiClient`/`authClient`/`realtimeClient` (`./auth.ts`, `./realtime.ts`) : les écrans
 * importent `offlineRunner` d'ici, jamais `createOfflineActionRunner` directement.
 *
 * Rejouée automatiquement à la reconnexion (critère 2), sur le même signal que la file du client
 * temps réel (`connection.ts`, `HomeScreen.tsx` pour le précédent déjà établi côté abonnements) :
 * pas un second mécanisme de détection de retour réseau, le seul qui existe dans l'app aujourd'hui
 * est la connexion WebSocket elle-même.
 */
export const offlineRunner: OfflineActionRunner = createOfflineActionRunner({ httpClient: apiClient });

onRealtimeConnectionStateChange((state) => {
  if (state === 'connected') offlineRunner.flush().catch(() => {});
});
