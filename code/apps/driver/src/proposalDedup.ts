/**
 * Déduplication d'une proposition par son identifiant de course (L6-12 critère 5, L7-04
 * critère 2). **Un seul registre**, partagé par les deux sources qui peuvent annoncer la même
 * proposition :
 *
 * - le message temps réel `proposal.new` (et son filet `session.synced.activeProposal`), reçu par
 *   `HomeScreen` ;
 * - la notification push, routée par `push/handlers.ts`.
 *
 * Un chauffeur connecté reçoit souvent les deux -- le WebSocket arrive en premier, la
 * notification est alors redondante. Sans registre commun, chaque source aurait sa propre garde
 * et un cas limite (notification traitée avant que `HomeScreen` ait navigué, ou l'inverse)
 * ouvrirait deux écrans. Ici, la première source qui traite un `rideId` le marque, la seconde
 * s'arrête.
 *
 * `forget` est appelé quand une proposition se résout sans acceptation (refus, expiration) : le
 * cas est rare, mais si le serveur re-proposait la même course à ce chauffeur, le registre ne
 * doit pas l'avaler en silence. Une acceptation ne l'appelle pas -- il n'y a plus de proposition
 * à rouvrir.
 */

const handled = new Set<string>();
const MAX_TRACKED = 32;

export function isProposalHandled(rideId: string): boolean {
  return handled.has(rideId);
}

export function markProposalHandled(rideId: string): void {
  handled.add(rideId);
  // Borne dure : on ne garde que les plus récents. Un `Set` conserve l'ordre d'insertion, la
  // première valeur est donc la plus ancienne.
  if (handled.size > MAX_TRACKED) {
    const oldest = handled.values().next().value;
    if (oldest !== undefined) handled.delete(oldest);
  }
}

export function forgetProposal(rideId: string): void {
  handled.delete(rideId);
}

/** Pour les tests -- repartir d'un registre vide. */
export function resetProposalDedup(): void {
  handled.clear();
}
