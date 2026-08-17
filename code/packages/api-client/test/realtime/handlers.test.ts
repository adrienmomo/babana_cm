import { parseIncomingMessage } from '../../src/realtime/handlers';

describe('parseIncomingMessage (L6-04, critère 5)', () => {
  it('accepte un message conforme au contrat C-02', () => {
    const raw = JSON.stringify({
      type: 'ride.assigned',
      id: '11111111-1111-4111-8111-111111111111',
      emittedAt: '2026-01-01T00:00:00Z',
      payload: { rideId: '22222222-2222-4222-8222-222222222222', driverId: '33333333-3333-4333-8333-333333333333' },
    });

    expect(parseIncomingMessage(raw)?.type).toBe('ride.assigned');
  });

  it("un JSON malformé est ignoré, jamais une exception qui ferait tomber l'app", () => {
    expect(() => parseIncomingMessage('{not json')).not.toThrow();
    expect(parseIncomingMessage('{not json')).toBeNull();
  });

  it("une forme qui ne correspond à aucun message du contrat est ignorée", () => {
    const raw = JSON.stringify({ type: 'unknown.type', id: '1', emittedAt: '2026-01-01T00:00:00Z', payload: {} });
    expect(parseIncomingMessage(raw)).toBeNull();
  });
});
