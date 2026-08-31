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
 *
 * **La notification constate, elle n'affirme pas** (précision du 3 septembre,
 * `amoa/questions/REPONSES-2026-09-03.md` §2 ; L6-05 spécification). Faute de service de premier
 * plan natif, rien ne garantit que la capture continue en arrière-plan : écrire « suivi actif »
 * serait affirmer ce qu'on ne peut pas tenir. Le texte affiche donc QUAND la dernière position
 * est réellement partie -- et devient au passage le diagnostic gratuit dont la mesure GPS
 * (`amoa/06-jalons-et-pilote.md` §2) aura besoin : celui qui tient le téléphone voit si la
 * capture a calé, sans interroger le serveur. C'est la règle de tout le projet -- une absence
 * explicite plutôt qu'une valeur plausible et fausse -- appliquée à ce que le produit dit de
 * lui-même.
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
      channelDescription: 'Indique quand Babana a envoyé votre position pour la dernière fois, pendant que vous êtes en ligne',
      importance: Importance.LOW,
      playSound: false,
      vibrate: false,
    },
    () => {
      // Idempotent côté natif -- rien de plus à faire, voir proposalAlert.ts.
    }
  );
}

/**
 * Texte de la notification : un fait constaté, jamais une promesse. `lastSentAtMs` -- `null` tant
 * qu'aucune position n'est partie depuis le passage en ligne (le cas transitoire des premières
 * secondes, ou une capture qui a calé d'entrée : dans les deux cas la notification le dit et ne
 * prétend rien d'autre). `nowMs` est fourni explicitement par `tracker.ts` -- jamais `Date.now()`
 * ici -- pour rester testable en horloge virtuelle, comme le reste de la logique de capture.
 */
export function formatLastSentMessage(lastSentAtMs: number | null, nowMs: number): string {
  if (lastSentAtMs === null) {
    return 'En ligne — position pas encore envoyée.';
  }
  const minutes = Math.max(0, Math.floor((nowMs - lastSentAtMs) / 60_000));
  if (minutes === 0) {
    return 'Dernière position envoyée à l’instant.';
  }
  if (minutes === 1) {
    return 'Dernière position envoyée il y a 1 minute.';
  }
  return `Dernière position envoyée il y a ${minutes} minutes.`;
}

/**
 * Pose ou met à jour la notification persistante (« ongoing », non balayable) avec `message` --
 * toujours un fait produit par `formatLastSentMessage`, jamais un libellé générique du type
 * « Babana fonctionne en arrière-plan ». Même identifiant fixe à chaque appel : reposter remplace
 * la notification en place, n'en empile pas une seconde.
 */
export function updateTrackingNotification(message: string): void {
  ensureChannel();
  PushNotification.localNotification({
    id: TRACKING_NOTIFICATION_ID,
    channelId: TRACKING_CHANNEL_ID,
    title: 'Babana',
    message,
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
