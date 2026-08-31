import Geolocation from '@react-native-community/geolocation';
import type { realtime } from '@babana/contracts';
import {
  LOCATION_BATCH_MAX_WAIT_MS,
  LOCATION_BATCH_SIZE,
  LOCATION_CAPTURE_INTERVAL_IDLE_MS,
  LOCATION_CAPTURE_INTERVAL_MOVING_MS,
  LOCATION_CAPTURE_INTERVAL_RIDE_MS,
  LOCATION_DEGRADED_MODE,
  LOCATION_DEGRADED_ONLINE_INTERVAL_MS,
  LOCATION_IDLE_DETECTION_WINDOW_MS,
  LOCATION_IDLE_DISPLACEMENT_THRESHOLD_METERS,
  LOCATION_IDLE_SPEED_THRESHOLD_MPS,
  LOCATION_NOTIFICATION_REFRESH_MS,
} from '../../config';
import { captureIntervalFor, MovementDetector, type AdaptiveCaptureConfig, type DriverActivityState } from './adaptive';
import { ensureBackgroundPermission, ensureForegroundPermission, type PermissionState } from './permissions';
import { updateTrackingNotification, hideTrackingNotification, formatLastSentMessage } from './background';
import { onRealtimeMessage, realtimeClient } from '../realtime';
import { onSessionLost } from '../auth';

/**
 * Capture GPS continue du chauffeur (L6-05) -- émet `position.update` (C-02), qui n'avait jamais
 * eu d'émetteur réel avant ce soir (`docs/contracts/realtime-message-map.json`, "Émetteur
 * manquant -- tâche L6-05, non commencée").
 *
 * **Un singleton indépendant des écrans**, comme `realtimeClient` (`../realtime.ts`) : la
 * capture doit continuer pendant qu'un chauffeur navigue entre Home, Proposal et ActiveRide, et
 * pendant que l'app est reléguée derrière Google Maps (D12, L6-13 critère 2) -- un composant
 * monté/démonté à chaque écran ne pourrait pas tenir cette promesse. L'état (en ligne, en course)
 * est appris de deux façons : `setOnline()`, appelé explicitement par `AvailabilityToggle.tsx`
 * (rien dans le contrat ne pousse "vous êtes en ligne" au chauffeur, c'est une décision locale
 * confirmée par la réponse HTTP) ; le reste (`proposal.accepted`, `ride.completed`,
 * `ride.cancelled`, `session.synced`) est lu directement du même flux que le reste de l'app,
 * jamais transmis par un écran -- ce module n'a besoin d'aucun appelant pour rester à jour.
 *
 * **Arrêt immédiat au passage hors ligne** (spécification) : `setOnline(false)` annule le
 * minuteur en cours ET vide le tampon sans l'envoyer -- un chauffeur qui vient de finir sa
 * journée ne doit plus émettre une seule position, y compris celles déjà captées dans les
 * quelques secondes précédentes.
 */

export interface LocationTrackerDeps {
  getPosition: (options: { enableHighAccuracy: boolean; timeout: number; maximumAge: number }) => Promise<RawFix | null>;
  ensureForegroundPermission: () => Promise<PermissionState>;
  ensureBackgroundPermission: () => Promise<PermissionState>;
  send: (payload: realtime.PositionUpdateMessage['payload']) => void;
  onMessage: (listener: (message: realtime.ServerToClientMessage) => void) => () => void;
  onSessionLost: (listener: () => void) => () => void;
  /** Pose ou met à jour la notification persistante avec un texte déjà composé (voir
   * `background.ts::formatLastSentMessage`) -- ce module lui fournit un fait constaté, jamais une
   * promesse de suivi. */
  updateNotification: (message: string) => void;
  hideNotification: () => void;
  now: () => number;
}

interface RawFix {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  speedMetersPerSecond: number | null;
  headingDegrees: number | null;
}

interface BufferedSample extends RawFix {
  capturedAtIso: string;
}

export interface LocationMetricsSnapshot {
  /** Nombre de relevés GPS obtenus avec succès (`captureOnce`), qu'ils aient été envoyés ou non
   * (un relevé fait toujours partie d'un lot qui finit par être envoyé -- compté ici au moment de
   * la capture, pour que L6-17 puisse aussi observer le délai entre capture et envoi). */
  positionsCaptured: number;
  /** Nombre de relevés effectivement partis sur le fil, tous lots confondus. */
  positionsSent: number;
  /** Octets JSON envoyés (`position.update`, tous lots confondus) -- ce que L6-17 rapportera au
   * volume de données horaire. */
  bytesSent: number;
  /** Temps cumulé où un appel GPS était en vol (de la demande à la réponse, succès ou échec) --
   * proxy de l'activité du capteur, pas un chronomètre système précis. */
  gpsActiveMs: number;
}

const ASSIGNED_RIDE_STATES: ReadonlySet<realtime.SessionSyncedMessage['payload']['activeRideState']> = new Set([
  'assigned',
  'in_progress',
]);

function isProposalAcceptedMessage(m: realtime.ServerToClientMessage): m is realtime.ProposalAcceptedMessage {
  return m.type === 'proposal.accepted';
}
function isRideCompletedMessage(m: realtime.ServerToClientMessage): m is realtime.RideCompletedMessage {
  return m.type === 'ride.completed';
}
function isRideCancelledMessage(m: realtime.ServerToClientMessage): m is realtime.RideCancelledMessage {
  return m.type === 'ride.cancelled';
}
function isSessionSyncedMessage(m: realtime.ServerToClientMessage): m is realtime.SessionSyncedMessage {
  return m.type === 'session.synced';
}

export function adaptiveConfigFromEnv(): AdaptiveCaptureConfig {
  return {
    idleIntervalMs: LOCATION_CAPTURE_INTERVAL_IDLE_MS,
    movingIntervalMs: LOCATION_CAPTURE_INTERVAL_MOVING_MS,
    rideIntervalMs: LOCATION_CAPTURE_INTERVAL_RIDE_MS,
    idleSpeedThresholdMps: LOCATION_IDLE_SPEED_THRESHOLD_MPS,
    idleDisplacementThresholdMeters: LOCATION_IDLE_DISPLACEMENT_THRESHOLD_METERS,
    idleDetectionWindowMs: LOCATION_IDLE_DETECTION_WINDOW_MS,
    degradedMode: LOCATION_DEGRADED_MODE,
    degradedIntervalMs: LOCATION_DEGRADED_ONLINE_INTERVAL_MS,
    batchSize: LOCATION_BATCH_SIZE,
    batchMaxWaitMs: LOCATION_BATCH_MAX_WAIT_MS,
    notificationRefreshMs: LOCATION_NOTIFICATION_REFRESH_MS,
  };
}

export class LocationTracker {
  private online = false;
  private rideActive = false;
  private state: DriverActivityState = 'offline';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private notificationTimer: ReturnType<typeof setInterval> | null = null;
  /** Horodatage du dernier envoi réellement parti sur le fil (`flush()`), ou `null` tant
   * qu'aucune position n'est partie depuis le passage en ligne -- porté par la notification
   * persistante, qui constate ce fait plutôt que d'affirmer un suivi actif (3 septembre). */
  private lastPositionSentAtMs: number | null = null;
  private buffer: BufferedSample[] = [];
  private batchStartedAtMs: number | null = null;
  private readonly movement: MovementDetector;
  private foregroundGranted = false;
  private unsubscribeMessages: (() => void) | null = null;

  private readonly metrics: LocationMetricsSnapshot = {
    positionsCaptured: 0,
    positionsSent: 0,
    bytesSent: 0,
    gpsActiveMs: 0,
  };

  constructor(
    private readonly deps: LocationTrackerDeps,
    private readonly config: AdaptiveCaptureConfig
  ) {
    this.movement = new MovementDetector(config);
  }

  /** Point d'accroche unique (même discipline que `bootstrap.ts`) -- démarre l'écoute des
   * messages qui font évoluer l'état de course. Idempotent. */
  start(): void {
    if (this.unsubscribeMessages) return;
    this.unsubscribeMessages = this.deps.onMessage((message) => {
      if (isProposalAcceptedMessage(message)) {
        this.setRideActive(true);
      } else if (isRideCompletedMessage(message) || isRideCancelledMessage(message)) {
        this.setRideActive(false);
      } else if (isSessionSyncedMessage(message)) {
        // Filet de resynchronisation (même raisonnement que ProposalScreen/HomeScreen) : reprend
        // l'état réel après une reconnexion, une app tuée puis relancée en pleine course.
        this.setRideActive(ASSIGNED_RIDE_STATES.has(message.payload.activeRideState));
      }
    });
    // Session perdue (déconnexion, jeton de renouvellement révoqué) : un chauffeur qui n'est plus
    // authentifié ne doit plus capturer sa position, ni afficher une notification qui prétendrait
    // le contraire -- même raisonnement que l'arrêt immédiat au passage hors ligne.
    this.deps.onSessionLost(() => this.setOnline(false));
  }

  /** Appelé explicitement par `AvailabilityToggle.tsx`, juste après l'autorisation d'Odoo --
   * jamais avant (même règle que `availability.set` lui-même). */
  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    if (!online) {
      // Arrêt immédiat (spécification) : rien de ce qui est déjà en tampon ne part.
      this.buffer = [];
      this.batchStartedAtMs = null;
      this.movement.reset();
    }
    this.recomputeState();
  }

  private setRideActive(active: boolean): void {
    if (this.rideActive === active) return;
    this.rideActive = active;
    this.recomputeState();
  }

  getState(): DriverActivityState {
    return this.state;
  }

  getMetrics(): LocationMetricsSnapshot {
    return { ...this.metrics };
  }

  private recomputeState(): void {
    const next: DriverActivityState = !this.online
      ? 'offline'
      : this.rideActive
        ? 'in_ride'
        : this.movement.isMoving(null)
          ? 'online_moving'
          : 'online_idle';

    const wasOffline = this.state === 'offline';
    this.state = next;

    if (next === 'offline') {
      this.stopTimer();
      this.stopNotificationTimer();
      this.lastPositionSentAtMs = null;
      this.deps.hideNotification();
      return;
    }
    if (wasOffline) {
      // Nouvelle session de capture : aucune position n'est encore partie. La notification le
      // dit, et ne prétend rien d'autre tant que le premier envoi n'a pas eu lieu.
      this.lastPositionSentAtMs = null;
      this.refreshNotification();
      this.startNotificationTimer();
    }
    // Un changement d'état (immobile -> en mouvement, hors course -> en course) reprogramme le
    // prochain relevé à la nouvelle cadence plutôt que d'attendre l'ancienne -- une transition
    // vers "en course" doit accélérer la capture immédiatement, pas au bout du délai précédent.
    this.scheduleNextCapture(0);
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Recompose et repose la notification persistante à partir du dernier envoi réellement parti
   * -- « il y a N min », ou « pas encore envoyée » si aucun. Appelée à chaque `flush()`, à chaque
   * changement d'état, et périodiquement (`startNotificationTimer`). */
  private refreshNotification(): void {
    this.deps.updateNotification(formatLastSentMessage(this.lastPositionSentAtMs, this.deps.now()));
  }

  /** Réaffiche la notification à cadence fixe, indépendamment de la capture : c'est ce
   * réaffichage qui fait grandir « il y a N min » quand plus aucune position ne part, et révèle
   * ainsi une capture calée (une notification figée sur le dernier envoi réussi rassurerait à
   * tort). Arrêté au passage hors ligne. */
  private startNotificationTimer(): void {
    this.stopNotificationTimer();
    this.notificationTimer = setInterval(() => this.refreshNotification(), this.config.notificationRefreshMs);
  }

  private stopNotificationTimer(): void {
    if (this.notificationTimer) clearInterval(this.notificationTimer);
    this.notificationTimer = null;
  }

  /**
   * `explicitDelayMs` -- littéral, jamais mélangé avec la cadence de l'état (piège rencontré en
   * écrivant ce module : `delayMs || interval` traite silencieusement 0 comme "pas de délai
   * fourni" en JavaScript, donc comme "utilise l'intervalle", exactement l'inverse de l'intention
   * "capture immédiate" du seul appelant qui passe 0, `recomputeState()`). Omis, la cadence de
   * l'état courant s'applique -- c'est le chemin normal, celui de `captureOnce()`.
   */
  private scheduleNextCapture(explicitDelayMs?: number): void {
    this.stopTimer();
    const interval = captureIntervalFor(this.state, this.config);
    if (interval === null) return;
    const delay = explicitDelayMs === undefined ? interval : explicitDelayMs;
    this.timer = setTimeout(() => {
      this.captureOnce().catch(() => {
        // Une capture manquée n'est pas un incident (réseau mobile intermittent, GPS
        // momentanément indisponible) -- le prochain relevé, programmé dans captureOnce() lui-
        // même sur succès comme sur échec, referme la boucle.
      });
    }, Math.max(0, delay));
  }

  private async ensurePermission(): Promise<boolean> {
    if (this.foregroundGranted) return true;
    const foreground = await this.deps.ensureForegroundPermission();
    if (foreground !== 'granted') return false;
    this.foregroundGranted = true;
    // Arrière-plan demandé une seule fois, après le premier plan (Android l'exige) -- un refus ne
    // bloque pas la capture au premier plan, seulement sa continuité une fois l'app reléguée
    // (dégradation explicite, jamais un blocage, spécification critère 5).
    await this.deps.ensureBackgroundPermission();
    return true;
  }

  private async captureOnce(): Promise<void> {
    // Toujours reprogrammer, y compris permission refusée : un chauffeur qui accorde la
    // permission plus tard (réglages du téléphone) doit voir la capture reprendre sans relancer
    // l'app.
    if (this.state === 'offline') return;

    const allowed = await this.ensurePermission();
    if (!allowed) {
      // À la cadence normale de l'état, jamais immédiatement en boucle serrée -- une permission
      // refusée n'est pas censée redevenir vraie d'un instant à l'autre.
      this.scheduleNextCapture();
      return;
    }

    const interval = captureIntervalFor(this.state, this.config) ?? LOCATION_CAPTURE_INTERVAL_IDLE_MS;
    const startedAtMs = this.deps.now();
    const fix = await this.deps.getPosition({
      // Haute précision réservée à la course (spécification : c'est le tracé accumulé par L3-10)
      // -- ailleurs, la précision par défaut du terminal suffit et coûte moins de batterie.
      enableHighAccuracy: this.state === 'in_ride',
      timeout: Math.min(10_000, interval),
      maximumAge: Math.floor(interval / 2),
    }).catch(() => null);
    this.metrics.gpsActiveMs += this.deps.now() - startedAtMs;

    // Relu via getState() plutôt que this.state directement : TypeScript rétrécirait sinon le
    // type à "jamais offline" depuis le premier contrôle ci-dessus, alors que setOnline(false) a
    // très bien pu s'exécuter PENDANT l'attente de deps.getPosition() ci-dessus (JS reste
    // mono-thread, mais un appel asynchrone laisse la main entre les deux lignes).
    if (this.getState() === 'offline') return; // passé hors ligne pendant l'appel GPS -- rien à faire suivre, le buffer a déjà été vidé par setOnline(false)

    if (fix) {
      this.metrics.positionsCaptured += 1;
      const capturedAtIso = new Date(this.deps.now()).toISOString();
      this.movement.record(fix, this.deps.now());
      this.buffer.push({ ...fix, capturedAtIso });
      if (this.batchStartedAtMs === null) this.batchStartedAtMs = this.deps.now();

      // Un changement d'immobilité peut avoir eu lieu à l'instant -- recalcule l'état AVANT de
      // programmer le prochain relevé, pour appliquer la nouvelle cadence tout de suite plutôt
      // qu'un tour de retard.
      if (!this.rideActive && this.online) {
        const moving = this.movement.isMoving(fix.speedMetersPerSecond);
        const next: DriverActivityState = moving ? 'online_moving' : 'online_idle';
        if (next !== this.state) {
          this.state = next;
        }
      }

      this.maybeFlush();
    }

    // À la cadence de l'état courant (potentiellement mise à jour ci-dessus) -- jamais 0, ce
    // relevé vient de réussir, le suivant attend son tour normalement.
    this.scheduleNextCapture();
  }

  private maybeFlush(): void {
    if (this.buffer.length === 0) return;
    const elapsed = this.batchStartedAtMs === null ? 0 : this.deps.now() - this.batchStartedAtMs;
    if (this.buffer.length >= this.config.batchSize || elapsed >= this.config.batchMaxWaitMs) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    const [precedingSamples, latest] = [this.buffer.slice(0, -1), this.buffer[this.buffer.length - 1]!];
    const payload: realtime.PositionUpdateMessage['payload'] = {
      latitude: latest.latitude,
      longitude: latest.longitude,
      accuracyMeters: latest.accuracyMeters,
      speedMetersPerSecond: latest.speedMetersPerSecond,
      headingDegrees: latest.headingDegrees,
      precedingSamples: precedingSamples.map((sample) => ({
        latitude: sample.latitude,
        longitude: sample.longitude,
        accuracyMeters: sample.accuracyMeters,
        speedMetersPerSecond: sample.speedMetersPerSecond,
        headingDegrees: sample.headingDegrees,
        capturedAt: sample.capturedAtIso,
      })),
    };
    this.deps.send(payload);
    this.metrics.positionsSent += this.buffer.length;
    this.metrics.bytesSent += JSON.stringify(payload).length;
    this.buffer = [];
    this.batchStartedAtMs = null;

    // Un envoi vient réellement de partir -- la notification le constate (« à l'instant »), et
    // repartira à grandir depuis cet instant si plus rien ne suit (3 septembre).
    this.lastPositionSentAtMs = this.deps.now();
    this.refreshNotification();
  }
}

function defaultDeps(): LocationTrackerDeps {
  return {
    getPosition: (options) =>
      new Promise((resolve) => {
        Geolocation.getCurrentPosition(
          (position) =>
            resolve({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracyMeters: position.coords.accuracy ?? 0,
              speedMetersPerSecond: position.coords.speed ?? null,
              headingDegrees: position.coords.heading ?? null,
            }),
          () => resolve(null),
          options
        );
      }),
    ensureForegroundPermission,
    ensureBackgroundPermission,
    send: (payload) => realtimeClient.send('position.update', payload),
    onMessage: onRealtimeMessage,
    onSessionLost,
    updateNotification: updateTrackingNotification,
    hideNotification: hideTrackingNotification,
    now: () => Date.now(),
  };
}

export const locationTracker = new LocationTracker(defaultDeps(), adaptiveConfigFromEnv());
