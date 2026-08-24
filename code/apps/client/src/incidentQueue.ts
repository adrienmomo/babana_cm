import { PendingIncidentQueue, createAsyncStoragePendingIncidentQueue } from '@babana/api-client';

/**
 * Singleton, même patron que `realtimeClient` (realtime.ts) : la file d'attente doit être
 * partagée par tout appelant de ce process, sinon le mutex interne de `PendingIncidentQueue`
 * (sérialisation des accès concurrents) ne protège rien.
 */
export const pendingIncidentQueue = new PendingIncidentQueue(createAsyncStoragePendingIncidentQueue());
