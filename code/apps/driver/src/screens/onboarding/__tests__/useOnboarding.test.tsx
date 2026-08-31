jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest')
);

const mockFetchDriverDocuments = jest.fn();
jest.mock('../../../onboarding', () => ({
  fetchDriverDocuments: (...args: unknown[]) => mockFetchDriverDocuments(...args),
  documentUploader: { upload: jest.fn() },
}));

import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { http } from '@babana/contracts';
import { useOnboarding, type OnboardingController } from '../useOnboarding';
import { setProfileAcknowledged } from '../state';

function Probe({ userId, onRender }: { userId: string; onRender: (c: OnboardingController) => void }) {
  onRender(useOnboarding(userId));
  return null;
}

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

const roots: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => {
    for (const r of roots.splice(0)) r.unmount();
  });
  jest.clearAllMocks();
  await AsyncStorage.clear();
});

async function mount(userId = 'u1') {
  let latest!: OnboardingController;
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<Probe userId={userId} onRender={(c) => (latest = c)} />);
  });
  roots.push(root);
  return () => latest;
}

describe('useOnboarding (L6-15, critère 1 -- reprenable)', () => {
  it('sans profil confirmé, reprend sur Profile même si des documents existent', async () => {
    mockFetchDriverDocuments.mockResolvedValue([doc({ documentType: 'license', verificationStatus: 'pending' })]);
    const get = await mount();
    expect(get().status).toBe('ready');
    expect(get().initialRoute).toBe('Profile');
  });

  it('profil confirmé + un document rejeté -> reprend sur Documents', async () => {
    await setProfileAcknowledged('u1');
    mockFetchDriverDocuments.mockResolvedValue([
      doc({ documentType: 'license', verificationStatus: 'rejected', rejectionReason: 'Floue' }),
      doc({ documentType: 'id_card', verificationStatus: 'verified' }),
    ]);
    const get = await mount();
    expect(get().initialRoute).toBe('Documents');
    expect(get().slots.find((s) => s.type === 'license')).toMatchObject({ status: 'rejected', rejectionReason: 'Floue' });
  });

  it('profil confirmé + tout déposé -> reprend sur Pending', async () => {
    await setProfileAcknowledged('u1');
    mockFetchDriverDocuments.mockResolvedValue([
      doc({ documentType: 'license', verificationStatus: 'pending' }),
      doc({ documentType: 'id_card', verificationStatus: 'pending' }),
    ]);
    const get = await mount();
    expect(get().initialRoute).toBe('Pending');
  });

  it('hors ligne (lecture serveur en échec) -> parcours utilisable, tout « à déposer »', async () => {
    await setProfileAcknowledged('u1');
    mockFetchDriverDocuments.mockRejectedValue(new Error('offline'));
    const get = await mount();
    expect(get().status).toBe('ready');
    expect(get().initialRoute).toBe('Documents');
    expect(get().slots.map((s) => s.status)).toEqual(['missing', 'missing']);
  });

  it('refresh relit le serveur et met à jour les slots', async () => {
    await setProfileAcknowledged('u1');
    mockFetchDriverDocuments.mockResolvedValueOnce([doc({ documentType: 'license' })]);
    const get = await mount();
    expect(get().slots.find((s) => s.type === 'id_card')!.status).toBe('missing');

    mockFetchDriverDocuments.mockResolvedValueOnce([
      doc({ documentType: 'license', verificationStatus: 'pending' }),
      doc({ documentType: 'id_card', verificationStatus: 'pending' }),
    ]);
    await act(async () => {
      await get().refresh();
    });
    expect(get().slots.every((s) => s.status === 'pending')).toBe(true);
  });
});
