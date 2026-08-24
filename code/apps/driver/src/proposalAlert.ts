import { Platform } from 'react-native';
import PushNotification, { Importance } from 'react-native-push-notification';

/**
 * Alerte de proposition (L6-12, critère d'acceptation 1 -- réveille l'appareil, produit un
 * signal sonore et une vibration). Un chauffeur en circulation ne regarde pas son écran, la
 * proposition doit s'imposer (spécification).
 *
 * **Notification LOCALE, pas distante** : déclenchée par l'app elle-même à la réception de
 * `proposal.new` sur la connexion WebSocket déjà ouverte -- `react-native-push-notification`
 * sert ici uniquement son mécanisme de notification système (canal Android à importance haute :
 * réveille l'écran, joue le son, vibre, un seul mécanisme pour les trois exigences). La
 * notification distante hors connexion (Firebase/APNs) reste L7-04, une tâche distincte, hors
 * périmètre ce soir -- voir `android/app/src/main/AndroidManifest.xml`, qui n'enregistre donc
 * que les composants strictement nécessaires au local (aucun récepteur Firebase).
 */

const PROPOSAL_CHANNEL_ID = 'proposal-alert';
// Identifiant fixe et réutilisé, jamais un nouvel identifiant par proposition -- une seule
// notification peut exister à la fois (L6-12, critère 5 : deux propositions ne s'affichent
// jamais simultanément côté écran, donc jamais deux alertes non plus). Poser la même la remplace
// plutôt que d'en empiler une seconde.
const PROPOSAL_NOTIFICATION_ID = 'proposal-alert-current';

let configured = false;

/** Point d'accroche unique (même discipline que `bootstrap.ts::configureGoogleSignIn`/
 * `configureMapsProvider`) -- crée le canal de notification une seule fois, avant toute alerte. */
export function configureProposalAlerts(): void {
  if (configured) return;
  configured = true;

  PushNotification.configure({
    // popInitialNotification: false -- cet écran ne relit jamais une notification passée au
    // démarrage de l'app (`proposal.new` est un événement temps réel, jamais rejoué depuis une
    // notification système).
    popInitialNotification: false,
    requestPermissions: Platform.OS === 'ios',
  });

  PushNotification.createChannel(
    {
      channelId: PROPOSAL_CHANNEL_ID,
      channelName: 'Proposition de course',
      channelDescription: 'Alerte à la réception d’une nouvelle proposition de course',
      playSound: true,
      soundName: 'default',
      importance: Importance.HIGH,
      vibrate: true,
    },
    () => {
      // Le second argument (booléen "déjà existant") ne change rien ici -- createChannel est
      // idempotent côté natif, appelé une seule fois de toute façon (configured, ci-dessus).
    }
  );
}

/** Déclenche l'alerte -- réveille l'appareil, joue le son, vibre (critère 1). `message` reste
 * court et sans donnée sensible au-delà de ce que l'écran de verrouillage affiche déjà à
 * n'importe quelle notification (D20 -- pas de montant ni de point exact dans le texte système,
 * l'écran lui-même porte le détail une fois l'app ouverte). */
export function alertIncomingProposal(): void {
  PushNotification.localNotification({
    id: PROPOSAL_NOTIFICATION_ID,
    channelId: PROPOSAL_CHANNEL_ID,
    title: 'Nouvelle proposition de course',
    message: 'Une course vous est proposée -- ouvrez l’app pour répondre.',
    playSound: true,
    soundName: 'default',
    vibrate: true,
    vibration: 1000,
    priority: 'high',
    importance: 'high',
  });
}

/** Efface l'alerte -- acceptée, refusée, ou expirée : plus rien à signaler (appelé au démontage
 * de `ProposalScreen`, quelle que soit l'issue). */
export function dismissProposalAlert(): void {
  PushNotification.cancelLocalNotification(PROPOSAL_NOTIFICATION_ID);
}
