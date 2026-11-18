import type { http, realtime } from '@babana/contracts';

/**
 * Copie du trajet gardée par le téléphone (L4-16, amoa/specs/L4-course.md). Pendant la course --
 * de `ride.started` à `ride.completed` / `ride.cancelled` -- chaque relevé de la capture en course
 * (déjà produit pour `position.update`, aucune cadence de plus) est ajouté à une copie locale,
 * persistée. À la fin, elle est téléversée UNE fois par la file hors connexion
 * (`uploadRideTrack`) : le serveur la retient seulement si le service temps réel n'a rien laissé
 * (redémarré en pleine course, par exemple). Rien ici ne décide de quoi que ce soit : le
 * téléphone garde, le serveur filtre et choisit (invariant 3).
 */
export interface RideTraceStorage {
  load(): Promise<StoredTrace | null>;
  save(trace: StoredTrace): Promise<void>;
  clear(): Promise<void>;
}

export interface StoredTrace {
  rideId: string;
  points: http.TrackPoint[];
}

export interface RideTraceDeps {
  storage: RideTraceStorage;
  /** Mise en file de `uploadRideTrack` (offlineRunner.attempt) -- part au retour du réseau sinon. */
  upload: (rideId: string, points: http.TrackPoint[]) => Promise<unknown>;
  maxPoints: number;
  persistEvery: number;
}

export interface RideFix {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  /** Vitesse rapportée par le GPS, `null` si inconnue (L6-21 : détection de départ). */
  speedMetersPerSecond: number | null;
  capturedAtIso: string;
}

export class RideTraceRecorder {
  private trace: StoredTrace | null = null;
  private unsaved = 0;
  private restored: Promise<void> | null = null;

  constructor(private readonly deps: RideTraceDeps) {}

  /** Relit une copie en cours après une app tuée puis relancée en pleine course. */
  restore(): Promise<void> {
    if (!this.restored) {
      this.restored = this.deps.storage
        .load()
        .then((stored) => {
          if (stored && !this.trace) this.trace = stored;
        })
        .catch(() => {});
    }
    return this.restored;
  }

  getRideId(): string | null {
    return this.trace?.rideId ?? null;
  }

  getPointCount(): number {
    return this.trace?.points.length ?? 0;
  }

  async begin(rideId: string): Promise<void> {
    await this.restore();
    if (this.trace?.rideId === rideId) return;
    // Une copie d'une autre course restée là (fin jamais vue) part d'abord : elle n'est pas perdue.
    if (this.trace) await this.finish(this.trace.rideId);
    this.trace = { rideId, points: [] };
    this.unsaved = 0;
    await this.deps.storage.save(this.trace);
  }

  record(fix: RideFix): void {
    if (!this.trace) return;
    const point: http.TrackPoint = {
      latitude: fix.latitude,
      longitude: fix.longitude,
      capturedAt: fix.capturedAtIso,
      accuracyMeters: fix.accuracyMeters,
    };
    if (this.trace.points.length >= this.deps.maxPoints) {
      this.trace.points[this.trace.points.length - 1] = point;
    } else {
      this.trace.points.push(point);
    }
    this.unsaved += 1;
    if (this.unsaved >= this.deps.persistEvery) {
      this.unsaved = 0;
      this.deps.storage.save(this.trace).catch(() => {});
    }
  }

  /** Téléverse une fois et oublie. Sans copie pour cette course : ne fait rien (idempotent). */
  async finish(rideId: string): Promise<void> {
    await this.restore();
    if (!this.trace || this.trace.rideId !== rideId) return;
    const { points } = this.trace;
    this.trace = null;
    this.unsaved = 0;
    await this.deps.storage.clear();
    if (points.length === 0) return;
    // Une erreur métier (course jamais démarrée côté serveur) n'a rien à rattraper : la copie
    // ne sert qu'à la sécurité. Une erreur réseau, elle, met l'envoi en file.
    await this.deps.upload(rideId, points).catch(() => {});
  }

  /** Suit le cycle de vie de la course depuis les messages temps réel reçus par le chauffeur. */
  handleMessage(message: realtime.ServerToClientMessage): void {
    if (message.type === 'ride.started') {
      this.begin(message.payload.rideId).catch(() => {});
    } else if (message.type === 'ride.completed' || message.type === 'ride.cancelled') {
      this.finish(message.payload.rideId).catch(() => {});
    }
  }
}

export function createAsyncStorageRideTrace(): RideTraceStorage {
  const AsyncStorage = require('@react-native-async-storage/async-storage').default;
  const KEY = 'babana:driver:ride-trace';
  return {
    async load() {
      const raw = await AsyncStorage.getItem(KEY);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as StoredTrace;
        return parsed && typeof parsed.rideId === 'string' && Array.isArray(parsed.points) ? parsed : null;
      } catch {
        return null;
      }
    },
    async save(trace) {
      await AsyncStorage.setItem(KEY, JSON.stringify(trace));
    },
    async clear() {
      await AsyncStorage.removeItem(KEY);
    },
  };
}
