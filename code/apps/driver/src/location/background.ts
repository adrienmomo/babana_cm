import { NativeModules, Platform } from 'react-native';
import PushNotification, { Importance } from 'react-native-push-notification';
import { APP_NAME } from '../brand';

/**
 * Notification persistante de capture (L6-05, critère d'acceptation 4 -- « avec une notification
 * persistante honnête sur ce qui est collecté »). Même patron que `proposalAlert.ts` (canal créé
 * une fois, notification posée/effacée par identifiant fixe) -- importance BASSE ici,
 * délibérément : contrairement à une proposition de course, cette notification n'a rien à
 * imposer, elle informe.
 *
 * **Sur Android, cette notification est celle d'un vrai service de premier plan** (décision du
 * 14 novembre, `android/.../online/OnlineService.kt`) : tant que le chauffeur est en ligne, le
 * service garde le processus, le GPS et le JavaScript actifs -- app en arrière-plan, écran éteint
 * ou app balayée des récentes -- et c'est ce qui lui permet de continuer à recevoir des courses.
 * Jusqu'au 14 novembre, ce module ne posait qu'une notification « ongoing » d'apparence, sans
 * service : React Native suspend tous les minuteurs JS hors de l'écran (JavaTimerManager), la
 * capture s'arrêtait donc dès que l'app quittait l'écran. Ailleurs (iOS, tests), la notification
 * locale d'avant reste le repli.
 *
 * **La notification constate, elle n'affirme pas** (précision du 3 septembre,
 * `amoa/questions/REPONSES-2026-09-03.md` §2 ; L6-05 spécification). Même avec le service, un
 * réseau coupé ou un constructeur qui tue les applications en arrière-plan peuvent arrêter
 * l'envoi : écrire « suivi actif » serait affirmer ce qu'on ne peut pas tenir. Le texte affiche donc QUAND la dernière position
 * est réellement partie -- et devient au passage le diagnostic gratuit dont la mesure GPS
 * (`amoa/06-jalons-et-pilote.md` §2) aura besoin : celui qui tient le téléphone voit si la
 * capture a calé, sans interroger le serveur. C'est la règle de tout le projet -- une absence
 * explicite plutôt qu'une valeur plausible et fausse -- appliquée à ce que le produit dit de
 * lui-même.
 */

/** Le service natif (Android seulement) -- absent ailleurs, la notification locale le remplace. */
interface OnlineServiceModule {
  /** Démarre le service au premier appel, met seulement sa notification à jour ensuite. Ne
   * démarre rien tant que la permission de position n'est pas accordée -- l'appel suivant
   * réessaie. */
  show(text: string): void;
  hide(): void;
}

function onlineService(): OnlineServiceModule | null {
  const native = (NativeModules as { BabanaOnlineService?: OnlineServiceModule }).BabanaOnlineService;
  return Platform.OS === 'android' && native ? native : null;
}

/** Même canal et même identifiant que la notification du service (OnlineService.kt) : une seule
 * notification, quel que soit le chemin qui la pose. */
const TRACKING_CHANNEL_ID = 'location-tracking';
// Numérique sous forme de chaîne : sur Android, react-native-push-notification fait un
// Integer.parseInt de l'identifiant et ne poste rien s'il échoue -- même exigence que l'alerte de
// proposition (proposalAlert.ts, '4201'), identifiant distinct pour ne jamais la remplacer.
const TRACKING_NOTIFICATION_ID = '4202';

let configured = false;

function ensureChannel(): void {
  if (configured) return;
  configured = true;
  PushNotification.createChannel(
    {
      channelId: TRACKING_CHANNEL_ID,
      channelName: 'Partage de position',
      channelDescription: `Indique quand ${APP_NAME} a envoyé votre position pour la dernière fois, pendant que vous êtes en ligne`,
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
  const service = onlineService();
  if (service) {
    service.show(message);
    return;
  }
  ensureChannel();
  PushNotification.localNotification({
    id: TRACKING_NOTIFICATION_ID,
    channelId: TRACKING_CHANNEL_ID,
    title: APP_NAME,
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
 * notification ne doit pas survivre à ce qu'elle annonce. Le service s'arrête avec elle, et la
 * tâche JS qu'il portait se termine (sans quoi React Native garderait ses minuteurs actifs en
 * arrière-plan pour rien). */
export function hideTrackingNotification(): void {
  const service = onlineService();
  if (service) {
    service.hide();
  } else {
    PushNotification.cancelLocalNotification(TRACKING_NOTIFICATION_ID);
  }
  const waiting = [...onlineTaskReleases];
  onlineTaskReleases.clear();
  waiting.forEach((release) => release());
}

const onlineTaskReleases = new Set<() => void>();

/**
 * Résolue au prochain passage hors ligne (`hideTrackingNotification`). C'est la durée de vie de
 * la tâche JS du service (`../onlineTask.ts`) : tant qu'elle n'est pas résolue, React Native garde
 * les minuteurs actifs hors de l'écran.
 */
export function untilTrackingStops(): Promise<void> {
  return new Promise((resolve) => onlineTaskReleases.add(resolve));
}
