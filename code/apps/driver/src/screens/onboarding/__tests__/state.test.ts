jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { http } from '@babana/contracts';
import {
  allDocumentsSubmitted,
  clearPendingUpload,
  documentSlots,
  loadPendingUploads,
  loadProfileAcknowledged,
  resolveOnboardingRoute,
  savePendingUpload,
  setProfileAcknowledged,
} from '../state';

function doc(overrides: Partial<http.DriverDocument>): http.DriverDocument {
  return {
    id: 1,
    documentType: 'license',
    verificationStatus: 'pending',
    rejectionReason: null,
    expiresOn: null,
    uploadedAt: '2026-08-30T09:00:00Z',
    ...overrides,
  };
}

describe('documentSlots (L6-15, critère 5 -- l’état de chaque document)', () => {
  it('un type jamais téléversé est « missing » explicite', () => {
    const slots = documentSlots([doc({ documentType: 'license', verificationStatus: 'verified' })]);
    expect(slots.map((s) => [s.type, s.status])).toEqual([
      ['license', 'verified'],
      ['id_card', 'missing'],
    ]);
  });

  it('ne garde que le plus récent par type (un renvoi après rejet ajoute une ligne)', () => {
    const slots = documentSlots([
      doc({ id: 2, documentType: 'id_card', verificationStatus: 'pending', uploadedAt: '2026-08-30T10:00:00Z' }),
      doc({ id: 1, documentType: 'id_card', verificationStatus: 'rejected', rejectionReason: 'Floue', uploadedAt: '2026-08-30T09:00:00Z' }),
    ]);
    const idCard = slots.find((s) => s.type === 'id_card')!;
    expect(idCard.status).toBe('pending');
    expect(idCard.rejectionReason).toBeNull();
  });

  it('un document rejeté porte son motif (critère 3)', () => {
    const slots = documentSlots([doc({ documentType: 'license', verificationStatus: 'rejected', rejectionReason: 'Numéro illisible' })]);
    expect(slots.find((s) => s.type === 'license')).toMatchObject({ status: 'rejected', rejectionReason: 'Numéro illisible' });
  });
});

describe('resolveOnboardingRoute (L6-15, critère 1 -- reprenable)', () => {
  const bothPending = documentSlots([
    doc({ documentType: 'license', verificationStatus: 'pending' }),
    doc({ documentType: 'id_card', verificationStatus: 'pending' }),
  ]);

  it('profil non confirmé -> Profile, quel que soit l’état des documents', () => {
    expect(resolveOnboardingRoute(bothPending, false)).toBe('Profile');
  });

  it('profil confirmé, un document manquant -> Documents', () => {
    expect(resolveOnboardingRoute(documentSlots([doc({ documentType: 'license' })]), true)).toBe('Documents');
  });

  it('profil confirmé, un document rejeté -> Documents', () => {
    const slots = documentSlots([
      doc({ documentType: 'license', verificationStatus: 'rejected', rejectionReason: 'x' }),
      doc({ documentType: 'id_card', verificationStatus: 'verified' }),
    ]);
    expect(resolveOnboardingRoute(slots, true)).toBe('Documents');
  });

  it('profil confirmé, tout déposé -> Pending', () => {
    expect(resolveOnboardingRoute(bothPending, true)).toBe('Pending');
    expect(allDocumentsSubmitted(bothPending)).toBe(true);
  });
});

describe('persistance locale (critère 1 + le téléversement survit à une coupure)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('le drapeau « profil confirmé » survit à un rechargement', async () => {
    expect(await loadProfileAcknowledged('u1')).toBe(false);
    await setProfileAcknowledged('u1');
    expect(await loadProfileAcknowledged('u1')).toBe(true);
    // Cloisonné par utilisateur.
    expect(await loadProfileAcknowledged('u2')).toBe(false);
  });

  it('une photo prise mais non envoyée est conservée puis effacée après succès', async () => {
    await savePendingUpload('u1', { type: 'license', uri: 'file:///p.jpg', name: 'p.jpg', mimeType: 'image/jpeg', expiresOn: '2030-01-01' });
    expect((await loadPendingUploads('u1')).license).toMatchObject({ uri: 'file:///p.jpg', expiresOn: '2030-01-01' });

    await clearPendingUpload('u1', 'license');
    expect((await loadPendingUploads('u1')).license).toBeUndefined();
  });
});
