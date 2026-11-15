/**
 * Abonnement GPS continu du chauffeur (14 novembre) -- remplace une lecture ponctuelle
 * (`getCurrentPosition`) à chaque relevé, qui rallumait le GPS à chaque fois : plus lent à répondre
 * et plus coûteux en batterie sur un terminal d'entrée de gamme. Le système livre les positions à
 * son rythme (`interval`) ; `tracker.ts` prend la plus récente à sa propre cadence.
 *
 * Les réglages suivent l'état du chauffeur (`configure`) : arrêté hors ligne, à la cadence de
 * l'état sinon. Toujours en haute précision : la précision basse de
 * `@react-native-community/geolocation` est la priorité « basse consommation » d'Android, de
 * l'ordre du quartier -- trop vague pour l'affectation au plus proche par la route (D78), et
 * refusée au-delà de 150 m par le service temps réel (L3-02).
 */

export interface RawFix {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  speedMetersPerSecond: number | null;
  headingDegrees: number | null;
}

export interface WatchSettings {
  intervalMs: number;
}

interface GeoPosition {
  coords: {
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    speed?: number | null;
    heading?: number | null;
  };
}

/** Ce que ce module utilise de `@react-native-community/geolocation`. */
export interface GeolocationLike {
  watchPosition(
    success: (position: GeoPosition) => void,
    error: (error: unknown) => void,
    options: { enableHighAccuracy: boolean; interval: number; fastestInterval: number; distanceFilter: number; maximumAge: number }
  ): number;
  clearWatch(watchId: number): void;
}

export class PositionWatcher {
  private desired: WatchSettings | null = null;
  private active: { watchId: number; intervalMs: number } | null = null;
  private latest: { fix: RawFix; atMs: number } | null = null;
  private readonly waiters = new Set<(fix: RawFix) => void>();

  constructor(
    private readonly geo: GeolocationLike,
    private readonly now: () => number
  ) {}

  /** `null` : arrêt (hors ligne) -- le dernier relevé est oublié avec. */
  configure(settings: WatchSettings | null): void {
    this.desired = settings;
    if (!settings) {
      this.stop();
      this.latest = null;
      return;
    }
    if (this.active && this.active.intervalMs === settings.intervalMs) return;
    this.stop();
    this.start();
  }

  /**
   * Le relevé le plus récent s'il n'a pas plus de `maximumAge` ms, sinon le prochain que le système
   * livre, au plus tard au bout de `timeout` ms -- `null` alors : jamais une position périmée
   * présentée comme fraîche.
   */
  next(options: { timeout: number; maximumAge: number }): Promise<RawFix | null> {
    // La permission a pu être accordée depuis un démarrage refusé : on réessaie ici.
    if (this.desired && !this.active) this.start();
    if (this.latest && this.now() - this.latest.atMs <= options.maximumAge) {
      return Promise.resolve(this.latest.fix);
    }
    return new Promise((resolve) => {
      const waiter = (fix: RawFix) => {
        clearTimeout(timer);
        resolve(fix);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(null);
      }, options.timeout);
      this.waiters.add(waiter);
    });
  }

  private start(): void {
    const settings = this.desired;
    if (!settings) return;
    const watchId = this.geo.watchPosition(
      (position) => this.receive(position),
      () => {
        // Permission refusée, localisation coupée : l'abonnement est considéré inactif et sera
        // relancé au prochain relevé demandé.
        if (this.active?.watchId === watchId) {
          this.geo.clearWatch(watchId);
          this.active = null;
        }
      },
      {
        enableHighAccuracy: true,
        interval: settings.intervalMs,
        fastestInterval: Math.max(1_000, Math.floor(settings.intervalMs / 2)),
        // Aucun filtre de distance : un chauffeur immobile doit continuer à recevoir des positions,
        // sans quoi il sortirait du vivier entre deux relevés (POSITION_TTL_SECONDS).
        distanceFilter: 0,
        maximumAge: settings.intervalMs,
      }
    );
    this.active = { watchId, intervalMs: settings.intervalMs };
  }

  private stop(): void {
    if (this.active) this.geo.clearWatch(this.active.watchId);
    this.active = null;
  }

  private receive(position: GeoPosition): void {
    const fix: RawFix = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyMeters: position.coords.accuracy ?? 0,
      speedMetersPerSecond: position.coords.speed ?? null,
      headingDegrees: position.coords.heading ?? null,
    };
    this.latest = { fix, atMs: this.now() };
    const waiting = [...this.waiters];
    this.waiters.clear();
    waiting.forEach((waiter) => waiter(fix));
  }
}
