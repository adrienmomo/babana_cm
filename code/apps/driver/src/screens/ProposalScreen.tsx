import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { reverseGeocode } from '@babana/maps';
import type { LatLng } from '@babana/maps';
import type { realtime } from '@babana/contracts';
import { CountdownRing } from '../components/CountdownRing';
import { formatDistance, formatMoney } from '../format';
import type { ConnectionState } from '@babana/api-client';
import { alertIncomingProposal, dismissProposalAlert } from '../proposalAlert';
import { onRealtimeConnectionStateChange, onRealtimeMessage, realtimeClient } from '../realtime';
import { markProposalHandled, forgetProposal } from '../proposalDedup';
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
 *
 * **Deux façons d'arriver ici** (L7-04) :
 * - `source: 'realtime'` -- l'app tenait déjà les détails (`proposal.new`, ou
 *   `session.synced.activeProposal` après reconnexion). Affichage immédiat.
 * - `source: 'notification'` -- l'app était fermée à l'émission, ouverte depuis la notification
 *   push. Elle n'a jamais reçu `proposal.new`. L'écran **revalide auprès du serveur** (une
 *   `session.resync` forcée) et attend un `session.synced` explicite : soit il porte une
 *   `activeProposal` pour ce `rideId` -- détails et **véritable** échéance -- soit il porte
 *   `null`, et l'écran dit « cette course n'est plus à prendre » (jamais des boutons pour une
 *   course déjà attribuée ou expirée, critère 3). Aucun délai inventé : on attend la réponse,
 *   on ne conclut jamais d'un silence (D49).
 *
 * Pendant cette attente, l'écran **affiche un fait plutôt qu'une attente muette** (L7-04,
 * 6 septembre) : il connaît l'état de la connexion temps réel. « Vérification… » devient
 * « Vérification… — hors connexion » quand le lien n'est pas établi. Aucune durée devinée : on
 * dit ce qu'on observe, on n'en tire aucune conclusion sur la proposition.
 */

type Props = NativeStackScreenProps<DriverParamList, 'Proposal'>;

type Decision = 'idle' | 'accepting' | 'rejecting' | 'resolved';

/** Détails complets d'une proposition affichable -- présents d'emblée en mode `realtime`,
 * remplis par la revalidation en mode `notification`. */
interface ProposalDisplayDetails {
  origin: LatLng;
  destination: LatLng;
  amount: number;
  distanceMeters: number;
  distanceToOriginMeters: number | null;
  expiresAt: string;
  emittedAt: string;
}

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

function isProposalNewMessage(message: realtime.ServerToClientMessage): message is realtime.ProposalNewMessage {
  return message.type === 'proposal.new';
}

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

function detailsFromRealtimeParams(
  params: Extract<DriverParamList['Proposal'], { source?: 'realtime' }>
): ProposalDisplayDetails {
  return {
    origin: params.origin,
    destination: params.destination,
    amount: params.amount,
    distanceMeters: params.distanceMeters,
    distanceToOriginMeters: params.distanceToOriginMeters,
    expiresAt: params.expiresAt,
    emittedAt: params.emittedAt,
  };
}

function detailsFromActiveProposal(active: realtime.ActiveProposal): ProposalDisplayDetails {
  return {
    origin: active.origin,
    destination: active.destination,
    amount: active.amount,
    distanceMeters: active.distanceMeters,
    distanceToOriginMeters: active.distanceToOriginMeters,
    expiresAt: active.expiresAt,
    emittedAt: active.emittedAt,
  };
}

export function ProposalScreen({ route, navigation }: Props) {
  const params = route.params;
  const rideId = params.rideId;
  const fromNotification = params.source === 'notification';

  const [details, setDetails] = useState<ProposalDisplayDetails | null>(
    fromNotification ? null : detailsFromRealtimeParams(params)
  );
  const [originLabel, setOriginLabel] = useState<string | null>(null);
  const [destinationLabel, setDestinationLabel] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision>('idle');
  const [resolutionMessage, setResolutionMessage] = useState<string | null>(null);
  // État de la connexion temps réel -- affiché comme un fait pendant la revalidation (L7-04,
  // 6 septembre), jamais utilisé pour conclure quoi que ce soit sur la proposition.
  const [connectionState, setConnectionState] = useState<ConnectionState>(() => realtimeClient.getState());
  const [, forceTick] = useState(0);
  // Lu de façon synchrone par le gestionnaire de proposal.expired et par le délai de grâce de
  // l'acceptation -- `decision` (état React) y serait périmé, même raisonnement que `phaseRef`
  // dans TrackingScreen.tsx (apps/client).
  const decisionRef = useRef<Decision>('idle');
  // `proposal.seen` (L7-04, critère 4) n'est signalé qu'une fois -- au premier affichage réel
  // des boutons, quelle que soit la source.
  const seenSignalledRef = useRef(false);
  // Revalidation en mode notification : ne conclure « plus à prendre » qu'une fois, sur le
  // premier session.synced qui répond.
  const revalidationSettledRef = useRef(false);

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

  // Mode notification : revalider auprès du serveur (L7-04). Une `session.resync` forcée -- même
  // message que la reconnexion automatique -- pour obtenir un `session.synced` frais qui dira s'il
  // reste une proposition à prendre, et laquelle. Rien n'est affiché tant que la réponse n'est
  // pas là : aucun délai deviné.
  useEffect(() => {
    if (fromNotification) {
      realtimeClient.send('session.resync', { lastKnownRideId: rideId });
    }
  }, [fromNotification, rideId]);

  // Suivre l'état de connexion pour l'afficher pendant l'attente -- un fait observé, pas un délai.
  useEffect(() => onRealtimeConnectionStateChange(setConnectionState), []);

  // Départ/arrivée affichés comme une approximation lisible, jamais comme un fait précis --
  // même honnêteté que HomeScreen.tsx côté Client (doute L6-06 §1) : c'est le point que le
  // serveur a transmis qui fait foi, le libellé ne fait qu'aider à le lire d'un coup d'œil.
  useEffect(() => {
    if (!details) return;
    let cancelled = false;
    reverseGeocode(details.origin)
      .then((label) => {
        if (!cancelled) setOriginLabel(label);
      })
      .catch(() => {});
    reverseGeocode(details.destination)
      .then((label) => {
        if (!cancelled) setDestinationLabel(label);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [details]);

  // Un tick par seconde pour rafraîchir le compte à rebours affiché -- purement indicatif.
  useEffect(() => {
    const timer = setInterval(() => forceTick((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Signale au serveur l'affichage réel de la proposition (L7-04, critère 4) -- dès que les
  // détails et les boutons sont là, une seule fois. C'est ce chiffre, mesuré côté serveur à la
  // réception, qui dit si le délai d'acceptation de trente secondes est réaliste.
  useEffect(() => {
    if (!details || decision !== 'idle' || resolutionMessage || seenSignalledRef.current) return;
    seenSignalledRef.current = true;
    realtimeClient.send('proposal.seen', { rideId, emittedAt: details.emittedAt });
  }, [details, decision, resolutionMessage, rideId]);

  // Toutes les issues d'une proposition passent par le fil (D49) -- plus aucun délai deviné :
  //  - `session.synced` : en mode notification, porte (ou non) `activeProposal` -- la
  //    revalidation ; en mode accept, filet si `proposal.accepted` s'est perdu ;
  //  - `proposal.new` : le WebSocket a fini par rattraper la notification -- on remplit les
  //    détails s'ils manquaient encore ;
  //  - `proposal.accepted` : l'acceptation a été résolue en faveur du chauffeur -> ActiveRide ;
  //  - `proposal.expired` : expiration simple, ou acceptation arrivée trop tard (critère 3).
  useEffect(() => {
    return onRealtimeMessage((message) => {
      if (isSessionSyncedMessage(message)) {
        const active = message.payload.activeProposal;
        // Revalidation (mode notification) : la première réponse tranche.
        if (fromNotification && !revalidationSettledRef.current && decisionRef.current === 'idle') {
          if (active && active.rideId === rideId) {
            revalidationSettledRef.current = true;
            markProposalHandled(rideId);
            setDetails(detailsFromActiveProposal(active));
          } else {
            // `activeProposal` absent, ou pour une autre course : il n'y a plus rien à prendre.
            // On le dit -- pas de boutons pour une course qui n'est plus disponible (critère 3).
            revalidationSettledRef.current = true;
            setResolutionMessage('Cette course n’est plus à prendre.');
            updateDecision('resolved');
          }
        }
        // Filet d'acceptation (D30) : session.synced ne porte pas le numéro du client -- absent,
        // jamais inventé.
        if (
          decisionRef.current === 'accepting' &&
          message.payload.activeRideId === rideId &&
          ASSIGNED_RIDE_STATES.has(message.payload.activeRideState)
        ) {
          updateDecision('resolved');
          navigateToActiveRide(null);
        }
        return;
      }

      if (isProposalNewMessage(message) && message.payload.rideId === rideId) {
        if (decisionRef.current !== 'idle') return;
        revalidationSettledRef.current = true;
        markProposalHandled(rideId);
        setDetails((current) => current ?? {
          origin: message.payload.origin,
          destination: message.payload.destination,
          amount: message.payload.amount,
          distanceMeters: message.payload.distanceMeters,
          distanceToOriginMeters: message.payload.distanceToOriginMeters,
          expiresAt: message.payload.expiresAt,
          emittedAt: message.emittedAt,
        });
        return;
      }

      if (isProposalAcceptedMessage(message) && message.payload.rideId === rideId) {
        if (decisionRef.current === 'rejecting' || decisionRef.current === 'resolved') return;
        updateDecision('resolved');
        navigateToActiveRide(message.payload.clientPhoneNumber);
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
    // rideId/fromNotification stables pour la vie de l'écran -- jamais une raison de se réabonner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rideId, navigation]);

  function navigateToActiveRide(clientPhoneNumber: string | null) {
    // Les détails sont garantis présents ici : une acceptation n'est possible qu'après affichage
    // des boutons, donc après `setDetails`. Repli défensif sur les params `realtime` malgré tout.
    const d = details ?? (fromNotification ? null : detailsFromRealtimeParams(params));
    if (!d) return;
    replaceWithActiveRide(navigation, {
      rideId,
      origin: d.origin,
      destination: d.destination,
      amount: d.amount,
      distanceMeters: d.distanceMeters,
      clientPhoneNumber,
    });
  }

  // Retour automatique, sans action requise (critère 4) -- le message reste lisible un instant
  // avant de disparaître, l'un n'empêche pas l'autre. Couvre aussi « plus à prendre » (notif).
  useEffect(() => {
    if (!resolutionMessage) return;
    const timer = setTimeout(() => navigation.goBack(), RESOLUTION_DISPLAY_MS);
    return () => clearTimeout(timer);
  }, [resolutionMessage, navigation]);

  function handleAccept() {
    if (decision !== 'idle' || !details) return;
    updateDecision('accepting');
    realtimeClient.send('proposal.accept', { rideId });
    // Aucune bascule optimiste : la navigation vers ActiveRide n'a lieu qu'à la réception de
    // `proposal.accepted` (ou de `session.synced` en filet), jamais après un délai deviné (D49).
  }

  function handleReject() {
    if (decision !== 'idle') return;
    updateDecision('rejecting');
    realtimeClient.send('proposal.reject', { rideId });
    // Une proposition refusée peut être re-proposée plus tard (cas rare) : le registre de
    // déduplication ne doit pas l'avaler en silence.
    forgetProposal(rideId);
    navigation.goBack();
  }

  const provisionalExpiresAt = details?.expiresAt ?? (fromNotification && params.expiresAt ? params.expiresAt : null);

  return (
    <View style={styles.container} testID="proposal-screen">
      <Text style={styles.title}>Nouvelle proposition</Text>

      {details ? (
        <>
          <View style={styles.pointsSummary}>
            <Text style={styles.pointText} numberOfLines={1} testID="proposal-origin">
              Départ : {originLabel ?? '…'}
            </Text>
            <Text style={styles.pointText} numberOfLines={1} testID="proposal-destination">
              Arrivée : {destinationLabel ?? '…'}
            </Text>
          </View>

          <Text style={styles.amount} testID="proposal-amount">
            {formatMoney(details.amount)}
          </Text>
          <Text style={styles.distance} testID="proposal-distance">
            Course : {formatDistance(details.distanceMeters)}
          </Text>
          {/* D51 -- distance à vide jusqu'au client, souvent le chiffre le plus déterminant pour
              décider en trente secondes. Approximation à vol d'oiseau (É8), pas un itinéraire. */}
          <Text style={styles.approachDistance} testID="proposal-approach-distance">
            {details.distanceToOriginMeters === null
              ? 'Distance jusqu’au client indisponible'
              : `≈ ${formatDistance(details.distanceToOriginMeters)} pour rejoindre le client`}
          </Text>
        </>
      ) : !resolutionMessage ? (
        <Text style={styles.revalidating} testID="proposal-revalidating">
          {connectionState === 'connected'
            ? 'Vérification de la proposition…'
            : 'Vérification de la proposition… — hors connexion'}
        </Text>
      ) : null}

      {provisionalExpiresAt && !resolutionMessage ? (
        <CountdownRing remainingSeconds={remainingSeconds(provisionalExpiresAt)} />
      ) : null}

      {resolutionMessage ? (
        <View style={styles.resolutionBanner} testID="proposal-resolution">
          <Text style={styles.resolutionText}>{resolutionMessage}</Text>
        </View>
      ) : details ? (
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
      ) : null}

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
  revalidating: {
    color: '#6B7280',
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
