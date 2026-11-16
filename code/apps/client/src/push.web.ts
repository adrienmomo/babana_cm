import { createPushRegistrar, createUnavailablePushBinding } from '@babana/api-client';
import { apiClient } from './auth';

/** Export web (D22) : aucune notification push ; l'enregistrement le constate sans erreur. */
export const pushRegistrar = createPushRegistrar({
  apiClient,
  binding: createUnavailablePushBinding('aucune notification push sur le web'),
  platform: 'web',
});
