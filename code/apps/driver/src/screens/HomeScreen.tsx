import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { asRideId } from '@babana/navigation';
import type { ConnectionState } from '@babana/api-client';
import type { realtime } from '@babana/contracts';
import { AvailabilityToggle } from '../components/AvailabilityToggle';
import { ensureRealtimeConnected, onRealtimeConnectionStateChange, onRealtimeMessage, realtimeClient } from '../realtime';
import type { DriverParamList } from '../navigation/types';

/**
 * Écran d'accueil (L6-11) : l'écran permanent de l'app Chauffeur (`navigation/types.ts`), que
 * les événements interrompent -- proposition reçue (L6-12), course en cours (L6-13). Il porte
 * donc deux responsabilités : la bascule en ligne/hors ligne elle-même, et l'écoute des messages
 * qui font quitter cet écran (`proposal.new`), puisque `Proposal` n'a pas d'autre point d'entrée.
 */

type Props = NativeStackScreenProps<DriverParamList, 'Home'>;

// États de course qui interdisent le passage hors ligne (L3-04, critère 2) -- mêmes valeurs que
// `TOGETHER_STATES` côté Odoo (`babana_ride.py`, cité dans TrackingScreen.tsx côté Client) : un
// chauffeur affecté ou en course est engagé, jamais entre les deux.
const ACTIVE_RIDE_STATES: ReadonlySet<realtime.SessionSyncedMessage['payload']['activeRideState']> = new Set(['assigned', 'in_progress']);

function isSessionSyncedMessage(message: realtime.ServerToClientMessage): message is realtime.SessionSyncedMessage {
  return message.type === 'session.synced';
}

function isProposalNewMessage(message: realtime.ServerToClientMessage): message is realtime.ProposalNewMessage {
  return message.type === 'proposal.new';
}

export function HomeScreen({ navigation }: Props) {
  const [connectionState, setConnectionState] = useState<ConnectionState>(() => realtimeClient.getState());
  // Lu depuis session.synced (activeRideState), jamais deviné (invariant 3) -- session.resync est
  // déjà envoyé automatiquement à chaque connexion établie, initiale ou après coupure
  // (@babana/api-client/realtime/connection.ts), donc une réponse arrive sans action de cet écran.
  const [inCourse, setInCourse] = useState(false);

  useEffect(() => {
    ensureRealtimeConnected();

    const unsubscribeConnectionState = onRealtimeConnectionStateChange(setConnectionState);

    const unsubscribeMessages = onRealtimeMessage((message) => {
      if (isSessionSyncedMessage(message)) {
        setInCourse(ACTIVE_RIDE_STATES.has(message.payload.activeRideState));
      } else if (isProposalNewMessage(message)) {
        // Deux propositions ne peuvent pas s'afficher simultanément (L6-12, critère 5) : si
        // l'écran affiché est déjà Proposal (même pile, présenté par-dessus Home), cette nouvelle
        // proposition n'a rien à faire ici -- un chauffeur déjà engagé sur une proposition sort
        // du pool avant qu'une seconde ne puisse lui être envoyée (L3-06/L3-17), mais un message
        // en double ou en retard reste possible sur un réseau intermittent.
        const alreadyOnProposal = navigation.getState().routes.some((route) => route.name === 'Proposal');
        if (alreadyOnProposal) return;
        navigation.navigate('Proposal', { rideId: asRideId(message.payload.rideId) });
      }
    });

    return () => {
      unsubscribeConnectionState();
      unsubscribeMessages();
    };
  }, [navigation]);

  function goToRemittance() {
    navigation.navigate('Remittance');
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Babana Chauffeur</Text>

      <Text style={styles.connectionState} testID="connection-state">
        {connectionState === 'connected'
          ? 'Connexion au service établie'
          : connectionState === 'connecting'
            ? 'Connexion en cours…'
            : 'Hors connexion'}
      </Text>

      <View style={styles.toggleWrap}>
        <AvailabilityToggle inCourse={inCourse} onNavigateToRemittance={goToRemittance} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
    padding: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
  },
  connectionState: {
    color: '#6B7280',
  },
  toggleWrap: {
    marginTop: 8,
  },
});
