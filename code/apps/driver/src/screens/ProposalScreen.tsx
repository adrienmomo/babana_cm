import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { reverseGeocode } from '@babana/maps';
import type { realtime } from '@babana/contracts';
import { CountdownRing } from '../components/CountdownRing';
import { formatDistance, formatMoney } from '../format';
import { alertIncomingProposal, dismissProposalAlert } from '../proposalAlert';
import { onRealtimeMessage, realtimeClient } from '../realtime';
import { replaceWithActiveRide } from '../navigation/transitions';
import type { DriverParamList } from '../navigation/types';

/**
 * Réception de proposition (L6-12) : plein écran, par-dessus Home (`navigation/types.ts`). Un
 * chauffeur en circulation ne regarde pas son écran -- `proposalAlert.ts` réveille l'appareil,
 * joue un son, vibre (critère 1) dès le montage.
 *
 * **Le compte à rebours est indicatif ; le serveur est seul juge** (spécification, L3-07) --
 * cet écran n'expire jamais lui-même une proposition, il ne fait qu'afficher `expiresAt` et
 * réagir à `proposal.expired` quand le serveur le pousse réellement.
 */

type Props = NativeStackScreenProps<DriverParamList, 'Proposal'>;

type Decision = 'idle' | 'accepting' | 'rejecting' | 'resolved';

/** Durée d'affichage du message de résolution avant le retour automatique (critère 4) -- assez
 * long pour être lu, pas assez pour que le chauffeur se demande si l'écran est figé. */
const RESOLUTION_DISPLAY_MS = 2500;

const TICK_MS = 1000;

// États de course qui confirment que cette proposition est bien devenue la course du chauffeur --
// mêmes valeurs que `ACTIVE_RIDE_STATES` dans HomeScreen.tsx, lues depuis session.synced.
const ASSIGNED_RIDE_STATES: ReadonlySet<realtime.SessionSyncedMessage['payload']['activeRideState']> = new Set([
  'assigned',
  'in_progress',
]);

function isProposalExpiredMessage(message: realtime.ServerToClientMessage): message is realtime.ProposalExpiredMessage {
  return message.type === 'proposal.expired';
}

function isProposalAcceptedMessage(message: realtime.ServerToClientMessage): message is realtime.ProposalAcceptedMessage {
  return message.type === 'proposal.accepted';
}

function isSessionSyncedMessage(message: realtime.ServerToClientMessage): message is realtime.SessionSyncedMessage {
  return message.type === 'session.synced';
}

function remainingSeconds(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

export function ProposalScreen({ route, navigation }: Props) {
  const { rideId, origin, destination, amount, distanceMeters, distanceToOriginMeters, expiresAt } = route.params;

  const [originLabel, setOriginLabel] = useState<string | null>(null);
  const [destinationLabel, setDestinationLabel] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision>('idle');
  const [resolutionMessage, setResolutionMessage] = useState<string | null>(null);
  const [, forceTick] = useState(0);
  // Lu de façon synchrone par le gestionnaire de proposal.expired et par le délai de grâce de
  // l'acceptation -- `decision` (état React) y serait périmé, même raisonnement que `phaseRef`
  // dans TrackingScreen.tsx (apps/client).
  const decisionRef = useRef<Decision>('idle');

  function updateDecision(next: Decision) {
    decisionRef.current = next;
    setDecision(next);
  }

  // Réveille l'appareil, joue un son, vibre (critère 1) -- une seule fois au montage, effacée au
  // démontage quelle que soit l'issue (acceptée, refusée, ou expirée).
  useEffect(() => {
    alertIncomingProposal();
    return () => {
      dismissProposalAlert();
    };
  }, []);

  // Départ/arrivée affichés comme une approximation lisible, jamais comme un fait précis --
  // même honnêteté que HomeScreen.tsx côté Client (doute L6-06 §1) : c'est le point que le
  // serveur a transmis qui fait foi, le libellé ne fait qu'aider à le lire d'un coup d'œil.
  useEffect(() => {
    let cancelled = false;
    reverseGeocode(origin)
      .then((label) => {
        if (!cancelled) setOriginLabel(label);
      })
      .catch(() => {});
    reverseGeocode(destination)
      .then((label) => {
        if (!cancelled) setDestinationLabel(label);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [origin, destination]);

  // Un tick par seconde pour rafraîchir le compte à rebours affiché -- purement indicatif.
  useEffect(() => {
    const timer = setInterval(() => forceTick((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Toutes les issues d'une proposition passent par le fil (D49) -- plus aucun délai deviné :
  //  - `proposal.accepted` : l'acceptation a été résolue en faveur du chauffeur -> ActiveRide ;
  //  - `proposal.expired` : expiration simple, ou acceptation arrivée trop tard (critère 3) ;
  //  - `session.synced` : filet de sécurité si `proposal.accepted` s'est perdu sans que la
  //    connexion tombe puis se rétablisse -- la resynchronisation automatique
  //    (`@babana/api-client`, à chaque `connected`) rapporte alors l'état réel de la course.
  useEffect(() => {
    return onRealtimeMessage((message) => {
      if (isProposalAcceptedMessage(message) && message.payload.rideId === rideId) {
        if (decisionRef.current === 'rejecting' || decisionRef.current === 'resolved') return;
        updateDecision('resolved');
        replaceWithActiveRide(navigation, {
          rideId,
          origin,
          destination,
          amount,
          distanceMeters,
          clientPhoneNumber: message.payload.clientPhoneNumber,
        });
        return;
      }
      if (
        isSessionSyncedMessage(message) &&
        decisionRef.current === 'accepting' &&
        message.payload.activeRideId === rideId &&
        ASSIGNED_RIDE_STATES.has(message.payload.activeRideState)
      ) {
        updateDecision('resolved');
        // Filet de resynchronisation (D30) : session.synced ne porte pas le numéro du client --
        // absent, jamais inventé, plutôt qu'une valeur périmée ou devinée.
        replaceWithActiveRide(navigation, { rideId, origin, destination, amount, distanceMeters, clientPhoneNumber: null });
        return;
      }
      if (isProposalExpiredMessage(message) && message.payload.rideId === rideId) {
        const wasAccepting = decisionRef.current === 'accepting';
        setResolutionMessage(
          wasAccepting
            ? 'Cette course a été attribuée -- votre acceptation est arrivée trop tard.'
            : 'Le délai de réponse est dépassé.'
        );
        updateDecision('resolved');
      }
    });
    // origin/destination/amount/distanceMeters viennent de route.params, stables pour la vie de
    // l'écran -- transmis tels quels à ActiveRide (L6-13), jamais une raison de se réabonner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rideId, navigation]);

  // Retour automatique, sans action requise (critère 4) -- le message reste lisible un instant
  // avant de disparaître, l'un n'empêche pas l'autre.
  useEffect(() => {
    if (!resolutionMessage) return;
    const timer = setTimeout(() => navigation.goBack(), RESOLUTION_DISPLAY_MS);
    return () => clearTimeout(timer);
  }, [resolutionMessage, navigation]);

  function handleAccept() {
    if (decision !== 'idle') return;
    updateDecision('accepting');
    realtimeClient.send('proposal.accept', { rideId });
    // Aucune bascule optimiste : la navigation vers ActiveRide n'a lieu qu'à la réception de
    // `proposal.accepted` (ou de `session.synced` en filet), jamais après un délai deviné (D49).
    // Le compte à rebours affiché reste purement indicatif -- le serveur seul tranche (L3-07).
  }

  function handleReject() {
    if (decision !== 'idle') return;
    updateDecision('rejecting');
    realtimeClient.send('proposal.reject', { rideId });
    navigation.goBack();
  }

  return (
    <View style={styles.container} testID="proposal-screen">
      <Text style={styles.title}>Nouvelle proposition</Text>

      <View style={styles.pointsSummary}>
        <Text style={styles.pointText} numberOfLines={1} testID="proposal-origin">
          Départ : {originLabel ?? '…'}
        </Text>
        <Text style={styles.pointText} numberOfLines={1} testID="proposal-destination">
          Arrivée : {destinationLabel ?? '…'}
        </Text>
      </View>

      <Text style={styles.amount} testID="proposal-amount">
        {formatMoney(amount)}
      </Text>
      <Text style={styles.distance} testID="proposal-distance">
        Course : {formatDistance(distanceMeters)}
      </Text>
      {/* D51 -- distance à vide jusqu'au client, souvent le chiffre le plus déterminant pour
          décider en trente secondes. Approximation à vol d'oiseau (É8), pas un itinéraire. */}
      <Text style={styles.approachDistance} testID="proposal-approach-distance">
        {distanceToOriginMeters === null
          ? 'Distance jusqu’au client indisponible'
          : `≈ ${formatDistance(distanceToOriginMeters)} pour rejoindre le client`}
      </Text>

      <CountdownRing remainingSeconds={remainingSeconds(expiresAt)} />

      {resolutionMessage ? (
        <View style={styles.resolutionBanner} testID="proposal-resolution">
          <Text style={styles.resolutionText}>{resolutionMessage}</Text>
        </View>
      ) : (
        <View style={styles.actionsRow}>
          <Pressable
            testID="proposal-reject"
            accessibilityRole="button"
            accessibilityLabel="Refuser la proposition"
            disabled={decision !== 'idle'}
            onPress={handleReject}
            style={({ pressed }) => [styles.actionButton, styles.rejectButton, pressed ? styles.pressed : null]}
          >
            <Text style={styles.actionLabel}>Refuser</Text>
          </Pressable>
          <Pressable
            testID="proposal-accept"
            accessibilityRole="button"
            accessibilityLabel="Accepter la proposition"
            disabled={decision !== 'idle'}
            onPress={handleAccept}
            style={({ pressed }) => [styles.actionButton, styles.acceptButton, pressed ? styles.pressed : null]}
          >
            <Text style={styles.actionLabel}>Accepter</Text>
          </Pressable>
        </View>
      )}

      {decision === 'accepting' ? (
        <Text style={styles.pending} testID="proposal-accepting">
          Envoi de votre acceptation…
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
    backgroundColor: '#FFFFFF',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
  },
  pointsSummary: {
    gap: 4,
    alignItems: 'center',
  },
  pointText: {
    color: '#374151',
    maxWidth: 320,
  },
  amount: {
    fontSize: 28,
    fontWeight: '700',
  },
  distance: {
    color: '#6B7280',
  },
  approachDistance: {
    color: '#0A7D3D',
    fontWeight: '600',
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 16,
  },
  // D20 -- cibles tactiles larges, le chauffeur est sur sa moto, parfois avec des gants (L6-12).
  actionButton: {
    minWidth: 140,
    minHeight: 72,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  acceptButton: {
    backgroundColor: '#0A7D3D',
  },
  rejectButton: {
    backgroundColor: '#DC2626',
  },
  pressed: {
    opacity: 0.85,
  },
  actionLabel: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  pending: {
    color: '#6B7280',
  },
  resolutionBanner: {
    marginTop: 16,
    backgroundColor: '#FEF3C7',
    borderRadius: 8,
    padding: 16,
    maxWidth: 320,
  },
  resolutionText: {
    color: '#92400E',
    textAlign: 'center',
  },
});
