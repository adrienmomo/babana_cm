import PushNotification, { Importance } from 'react-native-push-notification';

/**
 * Notification persistante de capture (L6-05, critère d'acceptation 4 -- « avec une notification
 * persistante honnête sur ce qui est collecté »). Même patron que `proposalAlert.ts` (canal créé
 * une fois, notification posée/effacée par identifiant fixe) -- importance BASSE ici,
 * délibérément : contrairement à une proposition de course, cette notification n'a rien à
 * imposer, elle informe.
 *
 * **Ce que ce module NE fait PAS, et pourquoi ça compte** : il pose une notification "ongoing"
 * (non balayable), qui donne à la capture l'apparence visuelle d'un service de premier plan
 * Android. Il ne démarre PAS de vrai service de premier plan natif (`startForegroundService` /
 * `ForegroundService`) -- aucune bibliothèque de ce type n'est une dépendance de ce paquet
 * aujourd'hui (invariant "pas de dépendance nouvelle sans nécessité", signalé plutôt qu'ajouté en
 * silence). Sans ce lien natif, Android peut throttler ou suspendre les minuteurs JS de
 * `tracker.ts` une fois l'app reléguée en arrière-plan, au-delà de ce que ce module peut garantir
 * depuis l'espace JavaScript seul. Détaillé dans `amoa/questions/L6-05.md`.
 */

const TRACKING_CHANNEL_ID = 'location-tracking';
const TRACKING_NOTIFICATION_ID = 'location-tracking-current';

let configured = false;

function ensureChannel(): void {
  if (configured) return;
  configured = true;
  PushNotification.createChannel(
    {
      channelId: TRACKING_CHANNEL_ID,
      channelName: 'Partage de position',
      channelDescription: 'Indique que Babana partage votre position pendant que vous êtes en ligne',
      importance: Importance.LOW,
      playSound: false,
      vibrate: false,
    },
    () => {
      // Idempotent côté natif -- rien de plus à faire, voir proposalAlert.ts.
    }
  );
}

/** Posée dès que la capture démarre (état non `offline`) -- texte honnête sur ce qui est
 * collecté, jamais un libellé générique du type « Babana fonctionne en arrière-plan ». */
export function showTrackingNotification(): void {
  ensureChannel();
  PushNotification.localNotification({
    id: TRACKING_NOTIFICATION_ID,
    channelId: TRACKING_CHANNEL_ID,
    title: 'Babana',
    message: 'Partage de votre position en cours, tant que vous êtes en ligne.',
    ongoing: true,
    autoCancel: false,
    playSound: false,
    vibrate: false,
    importance: 'low',
    priority: 'low',
  });
}

/** Effacée au passage hors ligne -- la capture s'arrête au même instant (tracker.ts), la
 * notification ne doit pas survivre à ce qu'elle annonce. */
export function hideTrackingNotification(): void {
  PushNotification.cancelLocalNotification(TRACKING_NOTIFICATION_ID);
}
