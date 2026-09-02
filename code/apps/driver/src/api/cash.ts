import type { http } from '@babana/contracts';
import { apiClient } from '../auth';

/**
 * Enveloppe fine autour de `apiClient.request` pour le domaine caisse (L5-07) -- le premier
 * module `api/` de cette app. Les écrans (`CashScreen.tsx`, `RemittanceScreen.tsx`) n'appellent
 * jamais `apiClient` directement : ce fichier est le seul endroit qui sait quel endpoint sert
 * quelle donnée, même raison que `auth.ts` est le seul endroit qui construit `apiClient` lui-même.
 *
 * Aucune règle métier ici (invariant 3) -- ni calcul de solde, ni décision de blocage : les deux
 * fonctions ne font que relayer la requête et retourner ce qu'Odoo a répondu, tel quel.
 */

export async function fetchCashSummary(): Promise<http.DriverCashResponse> {
  return (await apiClient.request('driverCash')) as http.DriverCashResponse;
}

export async function declareRemittance(
  amount: number,
  idempotencyKey: string
): Promise<http.CreateRemittanceResponse> {
  return (await apiClient.request('createRemittance', {
    body: { amount },
    idempotencyKey,
  })) as http.CreateRemittanceResponse;
}
