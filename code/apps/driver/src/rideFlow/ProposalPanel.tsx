import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { reverseGeocode } from '@babana/maps';
import type { LatLng } from '@babana/maps';
import type { realtime } from '@babana/contracts';
import { CountdownRing } from '../components/CountdownRing';
import { SwipeButton } from '../components/SwipeButton';
import { formatDistance, formatMoney } from '../format';
import type { ConnectionState } from '@babana/api-client';
import { alertIncomingProposal, dismissProposalAlert } from '../proposalAlert';
import { onRealtimeConnectionStateChange, onRealtimeMessage, realtimeClient } from '../realtime';
import { markProposalHandled, forgetProposal } from '../proposalDedup';

import type { ActiveRideParams, ProposalParams } from '../navigation/types';
import { cardsOf, makeStyles } from '../theme';

/**
 * Réception de proposition (L6-12) : un panneau posé sur la carte de Home (`rideFlow/`) -- la
 * carte ne disparaît jamais, Refuser/Accepter prennent la place des deux boutons flottants. Un
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

export interface ProposalPanelProps {
  params: ProposalParams;
  /** La proposition est terminée sans course (refusée, expirée, plus à prendre) : la carte revient
   * à son état de repos. */
  onDismiss: () => void;
  /** Le serveur a tranché en faveur du chauffeur : la course commence sur cette même carte. */
  onAccepted: (ride: ActiveRideParams) => void;
}

// Plus de « refus » côté chauffeur depuis le 18 novembre : accepter, ou laisser expirer.
type Decision = 'idle' | 'accepting' | 'resolved';

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
  pickupNote: string | null;
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

function isRideCancelledMessage(message: realtime.ServerToClientMessage): message is realtime.RideCancelledMessage {
  return message.type === 'ride.cancelled';
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

/**
 * Secondes restantes avant `expiresAt` (heure du SERVEUR), mesurées sur l'horloge du serveur
 * estimée : heure locale + `serverOffsetMs`. Un téléphone dont l'horloge dérive de deux minutes
 * afficherait sinon 150 s pour une fenêtre de 30 (constaté sur émulateur, 21 octobre).
 */
function remainingSeconds(expiresAt: string, serverOffsetMs: number): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - (Date.now() + serverOffsetMs)) / 1000));
}

/** Écart horloge serveur - horloge locale, estimé à la réception d'une heure du serveur (la
 * latence du réseau, quelques centaines de ms, est négligée -- l'affichage est à la seconde). */
function serverOffsetFrom(serverNow: string | undefined): number {
  if (!serverNow) return 0;
  const parsed = Date.parse(serverNow);
  return Number.isNaN(parsed) ? 0 : parsed - Date.now();
}

function detailsFromRealtimeParams(
  params: Extract<ProposalParams, { source?: 'realtime' }>
): ProposalDisplayDetails {
  return {
    origin: params.origin,
    destination: params.destination,
    amount: params.amount,
    distanceMeters: params.distanceMeters,
    distanceToOriginMeters: params.distanceToOriginMeters,
    expiresAt: params.expiresAt,
    emittedAt: params.emittedAt,
    pickupNote: params.pickupNote,
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
    pickupNote: active.pickupNote,
  };
}

export function ProposalPanel({ params, onDismiss, onAccepted }: ProposalPanelProps) {
  const styles = useStyles();
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
  // Hors connexion, une acceptation/un refus est interdit (L6-16, spécification) : l'état
  // serveur qui déciderait qui obtient la course aura changé au moment où ce message
  // atteindrait enfin le serveur -- le mettre en file produirait un échec incompréhensible bien
  // plus tard. Refusé tout de suite, avec explication, jamais mis en file.
  const [offlineActionBlocked, setOfflineActionBlocked] = useState(false);
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
  // Écart d'horloge avec le serveur : l'heure du serveur portée par ce qui a ouvert la proposition
  // (`serverNow`), puis celle de la resynchronisation en mode notification (`serverTime`).
  const serverOffsetRef = useRef(serverOffsetFrom(params.source === 'notification' ? undefined : params.serverNow));

  function updateDecision(next: Decision) {
    decisionRef.current = next;
    setDecision(next);
  }

  // Réveille l'appareil, joue un son, vibre (critère 1) -- une seule fois au montage, effacée au
  // démontage quelle que soit l'issue (acceptée, refusée, ou expirée).
  useEffect(() => {
    alertIncomingProposal(params.expiresAt);
    return () => {
      dismissProposalAlert();
    };
    // Une seule alerte, au montage : l'échéance de cette proposition ne change pas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  useEffect(
    () =>
      onRealtimeConnectionStateChange((state) => {
        setConnectionState(state);
        // Le refus offline n'est qu'une explication ponctuelle, pas un état durable -- une
        // reconnexion l'efface, le chauffeur retente son geste lui-même.
        if (state === 'connected') setOfflineActionBlocked(false);
      }),
    []
  );

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
  // réception, qui dit si le délai d'acceptation est réaliste -- `expiresAt` lui donne le délai de
  // CETTE proposition (fixé par Odoo, 18 novembre).
  useEffect(() => {
    if (!details || decision !== 'idle' || resolutionMessage || seenSignalledRef.current) return;
    seenSignalledRef.current = true;
    realtimeClient.send('proposal.seen', { rideId, emittedAt: details.emittedAt, expiresAt: details.expiresAt });
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
            serverOffsetRef.current = serverOffsetFrom(message.payload.serverTime);
            setDetails(detailsFromActiveProposal(active));
          } else {
            // `activeProposal` absent, ou pour une autre course : il n'y a plus rien à prendre.
            // On le dit -- pas de boutons pour une course qui n'est plus disponible (critère 3).
            revalidationSettledRef.current = true;
            // Plus à prendre maintenant -- mais le serveur pourra la reproposer (« Réessayer »
            // côté client) : le registre ne doit pas l'avaler (voir l'expiration ci-dessous).
            forgetProposal(rideId);
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
        // Mode notification : premier contact avec une heure du serveur (enveloppe de ce message).
        if (fromNotification && !revalidationSettledRef.current) {
          serverOffsetRef.current = serverOffsetFrom(message.emittedAt);
        }
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
          pickupNote: message.payload.pickupNote,
        });
        return;
      }

      if (isProposalAcceptedMessage(message) && message.payload.rideId === rideId) {
        if (decisionRef.current === 'resolved') return;
        updateDecision('resolved');
        navigateToActiveRide(message.payload.clientPhoneNumber);
        return;
      }

      if (isRideCancelledMessage(message) && message.payload.rideId === rideId) {
        // Le client a annulé pendant la proposition : plus rien à accepter -- la carte se ferme
        // en le disant, au lieu d'attendre une échéance que le serveur a déjà levée (31 octobre).
        if (decisionRef.current === 'resolved') return;
        setResolutionMessage('Le client a annulé la course.');
        updateDecision('resolved');
        return;
      }

      if (isProposalExpiredMessage(message) && message.payload.rideId === rideId) {
        // Une course expirée peut revenir : le client appuie sur « Réessayer » et le serveur la
        // repropose au plus proche -- souvent ce même chauffeur. Constaté sur émulateur le 24
        // octobre : marquée traitée, elle était avalée en silence. Même règle que le refus.
        forgetProposal(rideId);
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
  }, [rideId]);

  function navigateToActiveRide(clientPhoneNumber: string | null) {
    // Les détails sont garantis présents ici : une acceptation n'est possible qu'après affichage
    // des boutons, donc après `setDetails`. Repli défensif sur les params `realtime` malgré tout.
    const d = details ?? (fromNotification ? null : detailsFromRealtimeParams(params));
    if (!d) return;
    onAccepted({
      rideId,
      origin: d.origin,
      destination: d.destination,
      amount: d.amount,
      distanceMeters: d.distanceMeters,
      clientPhoneNumber,
      pickupNote: d.pickupNote,
    });
  }

  // Retour automatique, sans action requise (critère 4) -- le message reste lisible un instant
  // avant de disparaître, l'un n'empêche pas l'autre. Couvre aussi « plus à prendre » (notif).
  useEffect(() => {
    if (!resolutionMessage) return;
    const timer = setTimeout(() => onDismiss(), RESOLUTION_DISPLAY_MS);
    return () => clearTimeout(timer);
  }, [resolutionMessage, onDismiss]);

  function handleAccept() {
    if (decision !== 'idle' || !details) return;
    if (connectionState !== 'connected') {
      setOfflineActionBlocked(true);
      return;
    }
    updateDecision('accepting');
    realtimeClient.send('proposal.accept', { rideId });
    // Aucune bascule optimiste : la navigation vers ActiveRide n'a lieu qu'à la réception de
    // `proposal.accepted` (ou de `session.synced` en filet), jamais après un délai deviné (D49).
  }


  const provisionalExpiresAt = details?.expiresAt ?? (fromNotification && params.expiresAt ? params.expiresAt : null);
  const canRespond = !resolutionMessage && details !== null;

  return (
    <View style={styles.overlay} pointerEvents="box-none" testID="proposal-screen">
      <View style={styles.card}>
        <Text style={styles.title}>Nouvelle proposition</Text>

        {details ? (
          <>
            <Text style={styles.amount} testID="proposal-amount">
              {formatMoney(details.amount)}
            </Text>
            {/* Adresse inconnue (géocodage indisponible) : pas de ligne vide « … ». */}
            {originLabel || destinationLabel ? (
              <View style={styles.pointsSummary}>
                {originLabel ? (
                  <Text style={styles.pointText} numberOfLines={1} testID="proposal-origin">
                    Départ : {originLabel}
                  </Text>
                ) : null}
                {destinationLabel ? (
                  <Text style={styles.pointText} numberOfLines={1} testID="proposal-destination">
                    Arrivée : {destinationLabel}
                  </Text>
                ) : null}
              </View>
            ) : null}
            {details.pickupNote ? (
              <Text style={styles.pickupNote} numberOfLines={2} testID="proposal-pickup-note">
                « {details.pickupNote} »
              </Text>
            ) : null}
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
          <CountdownRing remainingSeconds={remainingSeconds(provisionalExpiresAt, serverOffsetRef.current)} />
        ) : null}

        {resolutionMessage ? (
          <View style={styles.resolutionBanner} testID="proposal-resolution">
            <Text style={styles.resolutionText}>{resolutionMessage}</Text>
          </View>
        ) : null}

        {canRespond && offlineActionBlocked ? (
          <Text style={styles.offlineBlockedText} testID="proposal-offline-blocked">
            Hors connexion — impossible de répondre maintenant. Réessayez dès que la connexion revient.
          </Text>
        ) : null}

        {decision === 'accepting' ? (
          <Text style={styles.pending} testID="proposal-accepting">
            Envoi de votre acceptation…
          </Text>
        ) : null}
      </View>

      {/* 18 novembre (maître d'ouvrage) : le chauffeur ne refuse plus une course -- plus de bouton
          « Refuser ». Accepter se confirme d'un glissement, comme les décisions de la course :
          rien ne se déclenche par un appui accidentel, en roulant ou avec des gants. Sans
          réponse, la proposition expire (délai du serveur) et passe au chauffeur suivant. */}
      {canRespond ? (
        <View style={styles.acceptAction}>
          <SwipeButton
            testID="proposal-accept"
            label={decision === 'accepting' ? 'Acceptation…' : 'Accepter la course'}
            accessibilityLabel="Accepter la proposition"
            disabled={decision !== 'idle'}
            onConfirm={handleAccept}
          />
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  card: {
    ...cardsOf(c).floating,
    position: 'absolute',
    top: 12,
    left: 16,
    right: 16,
    alignItems: 'center',
    gap: 6,
    padding: 16,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: c.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  pointsSummary: {
    gap: 2,
    alignItems: 'center',
  },
  pointText: {
    color: c.inkSoft,
    maxWidth: 320,
  },
  amount: {
    fontSize: 30,
    fontWeight: '800',
    color: c.ink,
  },
  distance: {
    color: c.muted,
  },
  pickupNote: {
    color: c.ink,
    fontStyle: 'italic',
    textAlign: 'center',
    maxWidth: 320,
  },
  approachDistance: {
    color: c.brandText,
    fontWeight: '600',
  },
  revalidating: {
    color: c.muted,
  },
  // D20 -- cible large en bas d'écran, au pouce (L6-12) ; même place que les glissements de course.
  acceptAction: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 28,
  },
  pending: {
    color: c.muted,
  },
  resolutionBanner: {
    marginTop: 4,
    backgroundColor: c.warningSoft,
    borderRadius: 12,
    padding: 12,
    maxWidth: 320,
  },
  resolutionText: {
    color: c.warningText,
    textAlign: 'center',
  },
  offlineBlockedText: {
    color: c.warningText,
    textAlign: 'center',
  },
}));
