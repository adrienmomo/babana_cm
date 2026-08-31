import { useCallback, useEffect, useState } from 'react';
import { fetchDriverDocuments } from '../../onboarding';
import {
  clearPendingUpload,
  documentSlots,
  loadPendingUploads,
  loadProfileAcknowledged,
  resolveOnboardingRoute,
  savePendingUpload,
  setProfileAcknowledged,
  type DocumentSlot,
  type DriverStatus,
  type OnboardingRoute,
  type PendingUpload,
  type RequiredDocumentType,
} from './state';

/**
 * État partagé du parcours d'inscription (L6-15). Détenu ici plutôt que dans chaque écran :
 * l'avancement (`slots`) et l'écran d'entrée (`initialRoute`) se dérivent une fois, à l'ouverture,
 * de l'état serveur -- c'est ce qui rend le parcours reprenable après une fermeture (critère 1).
 * Les écrans reçoivent les données et les gestes en props ; ils ne lisent jamais le serveur
 * eux-mêmes.
 */
export interface OnboardingController {
  status: 'loading' | 'ready';
  slots: DocumentSlot[];
  initialRoute: OnboardingRoute;
  pendingUploads: Partial<Record<RequiredDocumentType, PendingUpload>>;
  /** Relit l'état des documents depuis le serveur. Hors ligne : conserve ce qu'on savait. */
  refresh: () => Promise<void>;
  acknowledgeProfile: () => Promise<void>;
  savePending: (upload: PendingUpload) => Promise<void>;
  clearPending: (type: RequiredDocumentType) => Promise<void>;
}

export function useOnboarding(userId: string, driverStatus?: DriverStatus): OnboardingController {
  const [status, setStatus] = useState<'loading' | 'ready'>('loading');
  const [slots, setSlots] = useState<DocumentSlot[]>([]);
  const [initialRoute, setInitialRoute] = useState<OnboardingRoute>('Profile');
  const [pendingUploads, setPendingUploads] = useState<Partial<Record<RequiredDocumentType, PendingUpload>>>({});

  const reloadPending = useCallback(async () => {
    setPendingUploads(await loadPendingUploads(userId));
  }, [userId]);

  const refresh = useCallback(async () => {
    try {
      setSlots(documentSlots(await fetchDriverDocuments()));
    } catch {
      // Hors ligne : garder ce qu'on savait (ou « tout à déposer » au tout premier chargement).
      // L'écran des documents reste utilisable ; l'envoi retentera.
      setSlots((current) => (current.length ? current : documentSlots([])));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const acknowledged = await loadProfileAcknowledged(userId);
      const pending = await loadPendingUploads(userId);
      let computed: DocumentSlot[];
      try {
        computed = documentSlots(await fetchDriverDocuments());
      } catch {
        computed = documentSlots([]);
      }
      // Un seul point de mise à jour, gardé : rien ne setState après un démontage (fuite de
      // travail asynchrone dans une suite de tests -- CLAUDE.md).
      if (cancelled) return;
      setPendingUploads(pending);
      setSlots(computed);
      setInitialRoute(resolveOnboardingRoute(computed, acknowledged, driverStatus));
      setStatus('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, driverStatus]);

  const acknowledgeProfile = useCallback(async () => {
    await setProfileAcknowledged(userId);
  }, [userId]);

  const savePending = useCallback(
    async (upload: PendingUpload) => {
      await savePendingUpload(userId, upload);
      await reloadPending();
    },
    [userId, reloadPending]
  );

  const clearPending = useCallback(
    async (type: RequiredDocumentType) => {
      await clearPendingUpload(userId, type);
      await reloadPending();
    },
    [userId, reloadPending]
  );

  return { status, slots, initialRoute, pendingUploads, refresh, acknowledgeProfile, savePending, clearPending };
}
