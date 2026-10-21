import { realtime } from '@babana/contracts';
import { QUICK_MESSAGE_LABELS, quickMessagesFor } from '../../src/realtime/quickMessages';

describe('messages rapides -- libellés français', () => {
  it('chaque code du contrat a un libellé (un code ajouté sans libellé fait échouer ce test)', () => {
    for (const code of realtime.QuickMessageCodeSchema.options) {
      expect(QUICK_MESSAGE_LABELS[code]).toEqual(expect.any(String));
      expect(QUICK_MESSAGE_LABELS[code].length).toBeGreaterThan(0);
    }
  });

  it('chaque rôle ne propose que ses propres codes', () => {
    expect(quickMessagesFor('driver').every((code) => code.startsWith('driver_'))).toBe(true);
    expect(quickMessagesFor('client').every((code) => code.startsWith('client_'))).toBe(true);
    expect(quickMessagesFor('driver').length + quickMessagesFor('client').length).toBe(realtime.QuickMessageCodeSchema.options.length);
  });
});
