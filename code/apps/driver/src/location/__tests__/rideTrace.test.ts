import type { http, realtime } from '@babana/contracts';
import { RideTraceRecorder, type RideTraceStorage, type StoredTrace } from '../rideTrace';

function memoryStorage(initial: StoredTrace | null = null) {
  let value: StoredTrace | null = initial ? JSON.parse(JSON.stringify(initial)) : null;
  const saves: StoredTrace[] = [];
  const storage: RideTraceStorage = {
    load: async () => (value ? JSON.parse(JSON.stringify(value)) : null),
    save: async (trace) => {
      value = JSON.parse(JSON.stringify(trace));
      saves.push(JSON.parse(JSON.stringify(trace)));
    },
    clear: async () => {
      value = null;
    },
  };
  return { storage, saves, current: () => value };
}

function fix(i: number) {
  return { latitude: 4.05 + i * 0.0001, longitude: 9.7, accuracyMeters: 5, capturedAtIso: new Date(1_000_000 + i * 5_000).toISOString() };
}

function message(type: 'ride.started' | 'ride.completed' | 'ride.cancelled', rideId: string) {
  return { type, id: `m-${type}`, emittedAt: new Date().toISOString(), payload: { rideId } } as unknown as realtime.ServerToClientMessage;
}

async function settle() {
  await new Promise<void>((resolve) => setImmediate(() => resolve()));
}

describe('RideTraceRecorder (L4-16)', () => {
  it('ne garde rien hors d’une course démarrée', () => {
    const { storage } = memoryStorage();
    const recorder = new RideTraceRecorder({ storage, upload: jest.fn(), maxPoints: 100, persistEvery: 2 });
    recorder.record(fix(0));
    expect(recorder.getPointCount()).toBe(0);
  });

  it('de ride.started à ride.completed : garde les relevés horodatés puis les téléverse une fois', async () => {
    const { storage, current } = memoryStorage();
    const upload = jest.fn(async () => undefined);
    const recorder = new RideTraceRecorder({ storage, upload, maxPoints: 100, persistEvery: 2 });

    recorder.handleMessage(message('ride.started', 'ride-1'));
    await settle();
    [0, 1, 2].forEach((i) => recorder.record(fix(i)));
    recorder.handleMessage(message('ride.completed', 'ride-1'));
    await settle();

    expect(upload).toHaveBeenCalledTimes(1);
    const [rideId, points] = upload.mock.calls[0] as unknown as [string, http.TrackPoint[]];
    expect(rideId).toBe('ride-1');
    expect(points).toHaveLength(3);
    expect(points[0]).toEqual({ latitude: 4.05, longitude: 9.7, capturedAt: fix(0).capturedAtIso, accuracyMeters: 5 });
    expect(current()).toBeNull();

    // Un second signal de fin (message + bouton « Terminer ») ne téléverse rien de plus.
    await recorder.finish('ride-1');
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('persiste tous les N relevés, pour survivre à une app tuée en pleine course', async () => {
    const { storage, saves } = memoryStorage();
    const recorder = new RideTraceRecorder({ storage, upload: jest.fn(), maxPoints: 100, persistEvery: 2 });
    await recorder.begin('ride-2');
    [0, 1, 2, 3].forEach((i) => recorder.record(fix(i)));
    await settle();
    expect(saves.map((s) => s.points.length)).toEqual([0, 2, 4]);
  });

  it('une app relancée reprend la copie en cours et la téléverse à la fin', async () => {
    const { storage } = memoryStorage({ rideId: 'ride-3', points: [{ latitude: 4.05, longitude: 9.7, capturedAt: fix(0).capturedAtIso, accuracyMeters: 5 }] });
    const upload = jest.fn(async () => undefined);
    const recorder = new RideTraceRecorder({ storage, upload, maxPoints: 100, persistEvery: 2 });
    await recorder.restore();
    recorder.record(fix(1));
    await recorder.finish('ride-3');
    expect((upload.mock.calls[0] as unknown as [string, http.TrackPoint[]])[1]).toHaveLength(2);
  });

  it('une copie restée d’une autre course part avant d’en commencer une nouvelle', async () => {
    const { storage } = memoryStorage({ rideId: 'old', points: [{ latitude: 4.05, longitude: 9.7, capturedAt: fix(0).capturedAtIso, accuracyMeters: 5 }] });
    const upload = jest.fn(async () => undefined);
    const recorder = new RideTraceRecorder({ storage, upload, maxPoints: 100, persistEvery: 2 });
    await recorder.begin('new');
    expect(upload).toHaveBeenCalledWith('old', expect.any(Array));
    expect(recorder.getRideId()).toBe('new');
  });

  it('au-delà du plafond, le plus récent remplace le dernier point', async () => {
    const { storage } = memoryStorage();
    const recorder = new RideTraceRecorder({ storage, upload: jest.fn(), maxPoints: 3, persistEvery: 100 });
    await recorder.begin('ride-4');
    [0, 1, 2, 3, 4].forEach((i) => recorder.record(fix(i)));
    expect(recorder.getPointCount()).toBe(3);
  });

  it('une annulation téléverse aussi ce qui a été gardé ; une course sans point ne téléverse rien', async () => {
    const { storage } = memoryStorage();
    const upload = jest.fn(async () => undefined);
    const recorder = new RideTraceRecorder({ storage, upload, maxPoints: 100, persistEvery: 2 });
    await recorder.begin('ride-5');
    recorder.record(fix(0));
    recorder.handleMessage(message('ride.cancelled', 'ride-5'));
    await settle();
    expect(upload).toHaveBeenCalledTimes(1);
    await recorder.begin('ride-6');
    await recorder.finish('ride-6');
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('un échec de téléversement ne remonte jamais à l’écran', async () => {
    const { storage } = memoryStorage();
    const recorder = new RideTraceRecorder({ storage, upload: jest.fn(async () => { throw new Error('métier'); }), maxPoints: 100, persistEvery: 2 });
    await recorder.begin('ride-7');
    recorder.record(fix(0));
    await expect(recorder.finish('ride-7')).resolves.toBeUndefined();
  });
});
