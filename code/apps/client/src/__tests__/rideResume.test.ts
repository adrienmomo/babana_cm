import type { realtime } from '@babana/contracts';
import { flushPendingResume, resumeTracking, trackingParamsFrom, type ResumeNavigation, type TrackingParams } from '../rideResume';

// 14 novembre : l'app Client relancée en pleine course revenait à l'accueil -- le client ne voyait
// plus sa moto. `session.synced` porte sa course ; le suivi se rouvre.

const RIDE_ID = '11111111-1111-4111-8111-111111111111';
const DRIVER = {
  driverId: '22222222-2222-4222-8222-222222222222',
  firstName: 'Emmanuel',
  photoUrl: null,
  motorcycleClass: 'standard' as const,
  licensePlate: 'LT 4821 AC',
  phoneNumber: '+237690110201',
};

function synced(over: Partial<realtime.SessionSyncedMessage['payload']> = {}): realtime.SessionSyncedMessage {
  return {
    type: 'session.synced',
    id: 'm',
    emittedAt: '2026-11-14T15:00:00Z',
    payload: {
      activeRideId: RIDE_ID,
      activeRideState: 'in_progress',
      clientRide: {
        origin: { latitude: 4.05, longitude: 9.7, label: 'Carrefour Ndokoti' },
        destination: { latitude: 4.06, longitude: 9.71, label: null },
        driver: DRIVER,
      },
      activeProposal: null,
      rideStateKnown: true,
      driverOnline: null,
      serverTime: '2026-11-14T15:00:00Z',
      ...over,
    },
  };
}

function fakeNavigation(ready: boolean, current?: { name: string; params?: unknown }) {
  const opened: TrackingParams[] = [];
  const navigation: ResumeNavigation & { ready: boolean } = {
    ready,
    isReady: () => navigation.ready,
    currentRoute: () => current,
    openTracking: (params) => opened.push(params),
  };
  return { navigation, opened };
}

test('course en cours : le suivi se rouvre avec ses deux points et la carte du chauffeur', () => {
  const params = trackingParamsFrom(synced());
  expect(params).toEqual({
    rideId: RIDE_ID,
    origin: { position: { latitude: 4.05, longitude: 9.7 }, label: 'Carrefour Ndokoti' },
    destination: { position: { latitude: 4.06, longitude: 9.71 }, label: 'Point choisi sur la carte' },
    driver: DRIVER,
  });
});

test('affectée (le chauffeur arrive) : le suivi se rouvre aussi', () => {
  expect(trackingParamsFrom(synced({ activeRideState: 'assigned' }))).not.toBeNull();
});

test('rien à rouvrir : pas de course, course non affectée, ou terminée', () => {
  expect(trackingParamsFrom(synced({ activeRideId: null, activeRideState: null, clientRide: undefined }))).toBeNull();
  expect(trackingParamsFrom(synced({ activeRideState: 'requested', clientRide: undefined }))).toBeNull();
  expect(trackingParamsFrom(synced({ activeRideState: 'completed' }))).toBeNull();
});

test('accueil à l’écran : le suivi s’ouvre', () => {
  const { navigation, opened } = fakeNavigation(true, { name: 'Home' });
  resumeTracking(trackingParamsFrom(synced())!, navigation);
  expect(opened).toHaveLength(1);
});

test('suivi de cette course déjà à l’écran (simple reconnexion) : rien ne bouge', () => {
  const { navigation, opened } = fakeNavigation(true, { name: 'Tracking', params: { rideId: RIDE_ID } });
  resumeTracking(trackingParamsFrom(synced())!, navigation);
  expect(opened).toHaveLength(0);
});

test('navigation pas encore prête : le suivi s’ouvre dès qu’elle l’est', () => {
  const { navigation, opened } = fakeNavigation(false);
  resumeTracking(trackingParamsFrom(synced())!, navigation);
  expect(opened).toHaveLength(0);
  navigation.ready = true;
  flushPendingResume(navigation);
  expect(opened).toHaveLength(1);
  flushPendingResume(navigation);
  expect(opened).toHaveLength(1);
});
