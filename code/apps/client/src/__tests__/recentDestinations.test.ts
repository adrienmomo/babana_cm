jest.mock('../auth', () => ({ apiClient: { request: jest.fn() } }));

import { http } from '@babana/contracts';
import { pickRecentDestinations, RECENT_DESTINATIONS_COUNT } from '../recentDestinations';

const BASE = http.rideHistoryResponseExample.rides[0]!;

function ride(id: number, dropoffLabel: string | null, latitude = 4.06): http.RideHistoryEntry {
  return { ...BASE, id: `${id}`, dropoffLabel, dropoff: { latitude, longitude: 9.71 } };
}

describe('pickRecentDestinations', () => {
  it('les arrivées distinctes, dans l’ordre de l’historique (la plus récente d’abord)', () => {
    const points = pickRecentDestinations([
      ride(1, 'vers Rond-point Deïdo', 4.0622),
      ride(2, 'vers Marché Sandaga', 4.0476),
      ride(3, 'vers Rond-point Deïdo', 4.0623),
    ]);
    expect(points).toEqual([
      { label: 'vers Rond-point Deïdo', position: { latitude: 4.0622, longitude: 9.71 } },
      { label: 'vers Marché Sandaga', position: { latitude: 4.0476, longitude: 9.71 } },
    ]);
  });

  it('ignore une course sans libellé, et s’arrête au plafond', () => {
    const points = pickRecentDestinations([
      ride(1, null),
      ride(2, 'A'),
      ride(3, 'B'),
      ride(4, 'C'),
      ride(5, 'D'),
    ]);
    expect(points.map((point) => point.label)).toEqual(['A', 'B', 'C']);
    expect(points).toHaveLength(RECENT_DESTINATIONS_COUNT);
  });
});
