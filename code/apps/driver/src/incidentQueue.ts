import { PendingIncidentQueue, createAsyncStoragePendingIncidentQueue } from '@babana/api-client';

/**
 * Singleton, même patron que `apps/client/src/incidentQueue.ts` -- la file d'attente doit être
 * partagée par tout appelant de ce process, sinon le mutex interne de `PendingIncidentQueue` ne
 * protège rien.
 */
export const pendingIncidentQueue = new PendingIncidentQueue(createAsyncStoragePendingIncidentQueue());
