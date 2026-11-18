import { useCallback, useEffect, useRef, useState } from 'react';
import type { http } from '@babana/contracts';
import type { LatLng } from '@babana/maps';
import { apiClient } from '../auth';
import { offlineRunner } from '../offline';
import { onRealtimeMessage } from '../realtime';
import { locationTracker } from '../location';
import { StopDetector, type DetectorTarget } from './stopDetector';

/**
 * Arrêts de la course côté chauffeur (L6-21) : lus du serveur (à l'affectation, après
 * `ride.stop.added`, après une resynchronisation), avec les seuils de détection. Les relevés de la
 * capture en course alimentent le détecteur ; arrivées et départs partent par la file hors
 * connexion avec leur heure d'origine -- un événement émis sans réseau garde l'heure où il s'est
 * produit (L4-14 la borne côté serveur). Les boutons « Arrivé » / « Repartir » / « Arrêt client »
 * sont le secours manuel des mêmes événements.
 */
export interface RideStopsState {
  stops: http.RideStop[];
  /** Prochain arrêt prévu non atteint, dans l'ordre. */
  nextStop: http.RideStop | null;
  /** Arrêt atteint dont le départ n'est pas encore déclaré. */
  openStop: http.RideStop | null;
  /** « Le client a ajouté un arrêt » -- jusqu'à ce que le chauffeur le ferme. */
  alert: string | null;
  dismissAlert: () => void;
  arrive: () => void;
  depart: () => void;
  unplanned: () => void;
}

type Stage = 'approach' | 'arrived' | 'transit';

function nextOf(stops: http.RideStop[]): http.RideStop | null {
  return stops.find((stop) => stop.kind === 'planned' && !stop.reached) ?? null;
}

function openOf(stops: http.RideStop[]): http.RideStop | null {
  return stops.find((stop) => stop.reached && !stop.left) ?? null;
}

export function useRideStops({
  rideId,
  stage,
  origin,
  position,
}: {
  rideId: string;
  stage: Stage;
  origin: LatLng;
  position: LatLng | null;
}): RideStopsState {
  const [stops, setStops] = useState<http.RideStop[]>([]);
  const [alert, setAlert] = useState<string | null>(null);
  const [pickupDeparted, setPickupDeparted] = useState(false);
  const detectorRef = useRef<StopDetector | null>(null);
  const stateRef = useRef({ stops, stage, pickupDeparted, position });
  stateRef.current = { stops, stage, pickupDeparted, position };

  const load = useCallback(() => {
    apiClient
      .request('rideStops', { pathParams: { id: rideId } })
      .then((raw) => {
        const response = raw as Partial<http.RideStopsResponse> | undefined;
        if (!response?.stops || !response.detection) return;
        setStops(response.stops);
        setPickupDeparted(Boolean(response.pickupDeparted));
        if (detectorRef.current) detectorRef.current.setConfig(response.detection);
        else detectorRef.current = new StopDetector(response.detection);
      })
      .catch(() => {});
  }, [rideId]);

  useEffect(load, [load]);

  useEffect(
    () =>
      onRealtimeMessage((message) => {
        if (message.type === 'ride.stop.added' && message.payload.rideId === rideId) {
          setAlert('Le client a ajouté un arrêt. L’itinéraire est mis à jour.');
          setStops((current) => {
            // Les arrêts prévus du message, plus les arrêts imprévus déjà connus ici.
            const unplanned = current.filter((stop) => stop.kind === 'unplanned');
            return [...message.payload.stops, ...unplanned].sort((a, b) => a.sequence - b.sequence);
          });
          load();
        } else if (message.type === 'session.synced' && message.payload.activeRideId === rideId) {
          load();
        }
      }),
    [rideId, load]
  );

  const send = useCallback(
    (
      name: 'stopArrived' | 'stopDeparted' | 'stopUnplanned',
      body: http.StopArrivedRequest | http.StopDepartedRequest | http.StopUnplannedRequest
    ) => {
      offlineRunner
        .attempt(name, { pathParams: { id: rideId }, body })
        .then((raw) => {
          const response = raw as http.RideWithStopsResponse | undefined;
          if (response?.stops) setStops(response.stops);
        })
        // Refus métier (événement déjà enregistré, course terminée entre-temps) : relire l'état.
        .catch(load);
    },
    [rideId, load]
  );

  const markArrived = useCallback(
    (stopId: string, atMs: number) => {
      setStops((current) => current.map((stop) => (stop.id === stopId ? { ...stop, reached: true } : stop)));
      send('stopArrived', { stopId, occurredAt: new Date(atMs).toISOString() });
    },
    [send]
  );

  const markDeparted = useCallback(
    (stopId: string | null, atMs: number) => {
      if (stopId === null) setPickupDeparted(true);
      else setStops((current) => current.map((stop) => (stop.id === stopId ? { ...stop, left: true } : stop)));
      send('stopDeparted', { ...(stopId ? { stopId } : {}), occurredAt: new Date(atMs).toISOString() });
    },
    [send]
  );

  // Détection automatique, sur les relevés de la capture en course (aucune cadence de plus).
  useEffect(
    () =>
      locationTracker.subscribeRideFix((fix) => {
        const detector = detectorRef.current;
        if (!detector) return;
        const { stops: current, stage: currentStage, pickupDeparted: departedFromPickup } = stateRef.current;
        const open = openOf(current);
        const next = nextOf(current);
        let target: DetectorTarget | null = null;
        if (currentStage === 'arrived' && !departedFromPickup) {
          target = { kind: 'departure', stopId: null, anchor: origin };
        } else if (currentStage === 'transit' && open) {
          target = { kind: 'departure', stopId: open.id, anchor: open.position };
        } else if (currentStage === 'transit' && next) {
          target = { kind: 'arrival', stopId: next.id, position: next.position };
        }
        const event = detector.feed(
          { latitude: fix.latitude, longitude: fix.longitude, speedMetersPerSecond: fix.speedMetersPerSecond, atMs: Date.parse(fix.capturedAtIso) },
          target
        );
        if (event?.type === 'arrived') markArrived(event.stopId, event.atMs);
        else if (event?.type === 'departed') markDeparted(event.stopId, event.atMs);
      }),
    [origin, markArrived, markDeparted]
  );

  const nextStop = nextOf(stops);
  const openStop = openOf(stops);

  return {
    stops,
    nextStop,
    openStop,
    alert,
    dismissAlert: () => setAlert(null),
    arrive: () => {
      if (nextStop && !openStop) markArrived(nextStop.id, Date.now());
    },
    depart: () => {
      if (openStop) markDeparted(openStop.id, Date.now());
    },
    unplanned: () => {
      const here = stateRef.current.position;
      if (!here || openStop) return;
      send('stopUnplanned', { position: here, occurredAt: new Date().toISOString() });
    },
  };
}
