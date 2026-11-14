import { PositionWatcher, type GeolocationLike } from '../watcher';

// 14 novembre : un abonnement GPS continu, réglé sur la cadence de l'état, au lieu d'une lecture
// ponctuelle à chaque relevé.

type Success = Parameters<GeolocationLike['watchPosition']>[0];
type Failure = Parameters<GeolocationLike['watchPosition']>[1];
type Options = Parameters<GeolocationLike['watchPosition']>[2];

function fakeGeo() {
  let nextId = 1;
  const watches = new Map<number, { success: Success; error: Failure; options: Options }>();
  const geo: GeolocationLike & { watches: typeof watches; emit: (lat: number) => void; fail: () => void } = {
    watches,
    watchPosition: (success, error, options) => {
      const id = nextId++;
      watches.set(id, { success, error, options });
      return id;
    },
    clearWatch: (id) => {
      watches.delete(id);
    },
    emit: (lat) => watches.forEach((w) => w.success({ coords: { latitude: lat, longitude: 9.7, accuracy: 8, speed: 0, heading: null } })),
    fail: () => watches.forEach((w) => w.error({ code: 1 })),
  };
  return geo;
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('réglé sur la cadence de l’état, en haute précision, sans filtre de distance', () => {
  const geo = fakeGeo();
  const watcher = new PositionWatcher(geo, () => Date.now());
  watcher.configure({ intervalMs: 3_000 });
  const [watch] = [...geo.watches.values()];
  expect(watch!.options).toMatchObject({ enableHighAccuracy: true, interval: 3_000, distanceFilter: 0 });
});

test('même cadence : l’abonnement n’est pas relancé ; autre cadence : remplacé ; hors ligne : arrêté', () => {
  const geo = fakeGeo();
  const watcher = new PositionWatcher(geo, () => Date.now());
  watcher.configure({ intervalMs: 15_000 });
  const firstId = [...geo.watches.keys()][0];
  watcher.configure({ intervalMs: 15_000 });
  expect([...geo.watches.keys()]).toEqual([firstId]);

  watcher.configure({ intervalMs: 3_000 });
  expect(geo.watches.size).toBe(1);
  expect([...geo.watches.values()][0]!.options.interval).toBe(3_000);

  watcher.configure(null);
  expect(geo.watches.size).toBe(0);
});

test('une position récente est rendue tout de suite', async () => {
  const geo = fakeGeo();
  const watcher = new PositionWatcher(geo, () => Date.now());
  watcher.configure({ intervalMs: 3_000 });
  geo.emit(4.05);
  await expect(watcher.next({ timeout: 3_000, maximumAge: 3_000 })).resolves.toMatchObject({ latitude: 4.05, accuracyMeters: 8 });
});

test('une position trop vieille : on attend la suivante', async () => {
  const geo = fakeGeo();
  const watcher = new PositionWatcher(geo, () => Date.now());
  watcher.configure({ intervalMs: 3_000 });
  geo.emit(4.05);
  jest.advanceTimersByTime(5_000);
  const pending = watcher.next({ timeout: 3_000, maximumAge: 3_000 });
  geo.emit(4.06);
  await expect(pending).resolves.toMatchObject({ latitude: 4.06 });
});

test('rien dans le délai : null, jamais une position périmée', async () => {
  const geo = fakeGeo();
  const watcher = new PositionWatcher(geo, () => Date.now());
  watcher.configure({ intervalMs: 3_000 });
  geo.emit(4.05);
  jest.advanceTimersByTime(10_000);
  const pending = watcher.next({ timeout: 3_000, maximumAge: 3_000 });
  jest.advanceTimersByTime(3_000);
  await expect(pending).resolves.toBeNull();
});

test('abonnement refusé (permission) : relancé au relevé suivant', async () => {
  const geo = fakeGeo();
  const watcher = new PositionWatcher(geo, () => Date.now());
  watcher.configure({ intervalMs: 3_000 });
  geo.fail();
  expect(geo.watches.size).toBe(0);

  const pending = watcher.next({ timeout: 3_000, maximumAge: 3_000 });
  expect(geo.watches.size).toBe(1);
  geo.emit(4.07);
  await expect(pending).resolves.toMatchObject({ latitude: 4.07 });
});

test('hors ligne : le dernier relevé est oublié', async () => {
  const geo = fakeGeo();
  const watcher = new PositionWatcher(geo, () => Date.now());
  watcher.configure({ intervalMs: 3_000 });
  geo.emit(4.05);
  watcher.configure(null);
  const pending = watcher.next({ timeout: 1_000, maximumAge: 60_000 });
  jest.advanceTimersByTime(1_000);
  await expect(pending).resolves.toBeNull();
});
