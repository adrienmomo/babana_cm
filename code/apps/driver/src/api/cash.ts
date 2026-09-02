import type { http } from '@babana/contracts';
import { apiClient } from '../auth';
import { offlineRunner } from '../offline';

/**
 * Enveloppe fine autour de `apiClient`/`offlineRunner` pour le domaine caisse (L5-07) -- le
 * premier module `api/` de cette app. Les écrans (`CashScreen.tsx`, `RemittanceScreen.tsx`)
 * n'appellent jamais `apiClient` ni `offlineRunner` directement : ce fichier est le seul endroit
 * qui sait quel endpoint sert quelle donnée, même raison que `auth.ts` est le seul endroit qui
 * construit `apiClient` lui-même.
 *
 * Aucune règle métier ici (invariant 3) -- ni calcul de solde, ni décision de blocage : les deux
 * fonctions ne font que relayer la requête et retourner ce qu'Odoo a répondu, tel quel.
 */

export async function fetchCashSummary(): Promise<http.DriverCashResponse> {
  return (await apiClient.request('driverCash')) as http.DriverCashResponse;
}

/**
 * `declareRemittance` est autorisée hors connexion (L6-16, spécification) : passe par
 * `offlineRunner`, jamais `apiClient` directement -- mise en file automatique sur un réseau
 * absent, rejouée à la reconnexion avec une clé d'idempotence stable posée par le gestionnaire
 * lui-même (plus besoin que l'écran en garde une). `onQueued` bascule l'affichage de l'écran
 * dès la mise en file, sans attendre un succès qui peut survenir bien plus tard.
 */
export async function declareRemittance(
  amount: number,
  onQueued?: () => void
): Promise<http.CreateRemittanceResponse> {
  return (await offlineRunner.attempt('createRemittance', {
    body: { amount },
    onQueued,
  })) as http.CreateRemittanceResponse;
}
