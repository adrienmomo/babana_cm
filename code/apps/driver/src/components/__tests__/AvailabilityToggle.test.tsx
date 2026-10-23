import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ApiError } from '@babana/api-client';

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

const mockSend = jest.fn();
jest.mock('../../realtime', () => ({
  realtimeClient: { send: (...args: unknown[]) => mockSend(...args) },
}));

// L6-05 : sans ce double, le singleton réel (`../../location`) programmerait de vrais minuteurs
// GPS récursifs dès `setOnline(true)` -- voir tracker.test.ts pour les tests qui exercent
// réellement LocationTracker, avec des dépendances injectées.
const mockSetOnline = jest.fn();
let mockTrackerState = 'offline';
const mockOnlineListeners = new Set<(online: boolean) => void>();
jest.mock('../../location', () => ({
  locationTracker: {
    setOnline: (...args: unknown[]) => mockSetOnline(...args),
    getState: () => mockTrackerState,
    subscribeOnline: (listener: (online: boolean) => void) => {
      mockOnlineListeners.add(listener);
      return () => mockOnlineListeners.delete(listener);
    },
  },
}));

import { AvailabilityToggle } from '../AvailabilityToggle';
import { SwipeButton } from '../SwipeButton';

function texts(root: ReactTestRenderer): string {
  return root.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

async function renderToggle(props: Partial<{ inCourse: boolean; onNavigateToRemittance: () => void }> = {}): Promise<ReactTestRenderer> {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(
      <AvailabilityToggle inCourse={props.inCourse ?? false} onNavigateToRemittance={props.onNavigateToRemittance ?? jest.fn()} />
    );
  });
  return root;
}

async function press(root: ReactTestRenderer) {
  await act(async () => {
    root.root.findByProps({ testID: 'availability-toggle' }).props.onConfirm();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTrackerState = 'offline';
});

describe('AvailabilityToggle (L6-11, D7)', () => {
  it('suit la disponibilité appliquée par le serveur : mis hors ligne pendant une déconnexion, la bascule revient à « Hors ligne »', async () => {
    mockTrackerState = 'online_idle';
    const root = await renderToggle();
    expect(texts(root)).toContain('En ligne');

    // session.synced driverOnline:false, appliqué par LocationTracker.
    await act(async () => {
      mockOnlineListeners.forEach((listener) => listener(false));
    });

    expect(texts(root)).toContain('Hors ligne');
    expect(mockRequest).not.toHaveBeenCalled(); // rien à demander à Odoo : le serveur a déjà tranché
  });

  it('se désabonne au démontage', async () => {
    const before = mockOnlineListeners.size; // les rendus des autres cas ne sont pas démontés
    const root = await renderToggle();
    expect(mockOnlineListeners.size).toBe(before + 1);
    await act(async () => root.unmount());
    expect(mockOnlineListeners.size).toBe(before);
  });

  it('bascule en ligne avec succès -- l’état affiché reflète la réponse du serveur, pas une supposition locale', async () => {
    mockRequest.mockResolvedValue({ online: true });
    const root = await renderToggle();

    expect(texts(root)).toContain('Hors ligne');
    await press(root);

    expect(mockRequest).toHaveBeenCalledWith('setAvailability', { body: { online: true } });
    expect(texts(root)).toContain('En ligne');
  });

  it("applique réellement l'état côté service temps réel une fois Odoo autorisé -- deux appels, pas un", async () => {
    mockRequest.mockResolvedValue({ online: true });
    const root = await renderToggle();

    await press(root);

    // L'appel HTTP (autorisation) doit précéder l'envoi WebSocket (application) -- un chauffeur
    // refusé ne doit jamais apparaître disponible, même un instant.
    const requestOrder = mockRequest.mock.invocationCallOrder[0]!;
    const sendOrder = mockSend.mock.invocationCallOrder[0]!;
    expect(requestOrder).toBeLessThan(sendOrder);
    expect(mockSend).toHaveBeenCalledWith('availability.set', { online: true });
    // L6-05 : la capture GPS suit le même instant que l'application côté service temps réel.
    expect(mockSetOnline).toHaveBeenCalledWith(true);
  });

  it("un refus n'envoie jamais availability.set -- rien n'est appliqué côté service temps réel, ni la capture GPS", async () => {
    mockRequest.mockRejectedValue(new ApiError('DRIVER_NOT_APPROVED', 'x', 403));
    const root = await renderToggle();

    await press(root);

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSetOnline).not.toHaveBeenCalled();
  });

  it('critère 1 -- chaque motif de refus affiche un message distinct', async () => {
    const cases: Array<[string, string]> = [
      ['DRIVER_NOT_APPROVED', 'Votre dossier chauffeur est en cours de validation.'],
      ['MOTORCYCLE_NOT_ASSIGNED', "Aucune moto ne vous a encore été attribuée. Contactez l'assistance."],
      ['INSURANCE_EXPIRED', "L'assurance de votre moto a expiré. Contactez l'assistance."],
      ['LICENSE_EXPIRED', "Votre permis de conduire a expiré. Contactez l'assistance."],
      ['DRIVER_HAS_ACTIVE_RIDE', 'Impossible de vous mettre hors ligne pendant une course.'],
    ];

    for (const [code, expectedMessage] of cases) {
      mockRequest.mockRejectedValueOnce(new ApiError(code as never, 'x', 403));
      const root = await renderToggle();
      await press(root);
      expect(texts(root)).toContain(expectedMessage);
    }
  });

  it('critère 2 -- le motif « plafond » propose l’accès à la déclaration de remise (L5-07)', async () => {
    mockRequest.mockRejectedValue(new ApiError('CASH_LIMIT_REACHED', 'x', 403));
    const onNavigateToRemittance = jest.fn();
    const root = await renderToggle({ onNavigateToRemittance });

    await press(root);

    expect(texts(root)).toContain("Votre plafond d'encaisse est atteint. Faites une remise pour continuer.");
    const remittanceButton = root.root.findByProps({ testID: 'availability-go-to-remittance' });
    expect(remittanceButton).toBeTruthy();

    await act(async () => {
      remittanceButton.props.onPress();
    });
    expect(onNavigateToRemittance).toHaveBeenCalledTimes(1);
  });

  it('un motif autre que le plafond ne propose jamais le bouton de remise', async () => {
    mockRequest.mockRejectedValue(new ApiError('DRIVER_NOT_APPROVED', 'x', 403));
    const root = await renderToggle();

    await press(root);

    expect(root.root.findAllByProps({ testID: 'availability-go-to-remittance' })).toHaveLength(0);
  });

  it('critère 3 -- l’interrupteur est inactif en course, sans message permanent', async () => {
    const root = await renderToggle({ inCourse: true });

    expect(root.root.findByProps({ testID: 'availability-toggle' }).props.disabled).toBe(true);
    expect(texts(root)).not.toContain('Vous ne pouvez pas repasser hors ligne');
    expect(root.root.findAllByProps({ testID: 'availability-in-course-explanation' })).toHaveLength(0);

    await press(root);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('une panne réseau (pas une ApiError) affiche un message générique de réessai, jamais un motif inventé', async () => {
    mockRequest.mockRejectedValue(new Error('fetch failed'));
    const root = await renderToggle();

    await press(root);

    expect(texts(root)).toContain('La mise à jour a échoué. Réessayez.');
  });

  it('un curseur à glisser, pas un appui : 48 à 56 dp de haut, sur toute la largeur du panneau', async () => {
    const root = await renderToggle();
    const toggle = root.root.findByProps({ testID: 'availability-toggle' });
    expect(toggle.type).toBe(SwipeButton);
    const track = root.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'availability-toggle')[0]!;
    const style = StyleSheet.flatten(track.props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(48);
    expect(style.minHeight).toBeLessThanOrEqual(56);
    expect(style.alignSelf).toBe('stretch');
  });

  it("l'état est lisible sans dépendre de la couleur seule (libellé et teinte)", async () => {
    mockRequest.mockResolvedValue({ online: true });
    const root = await renderToggle();
    const status = () => root.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'availability-status')[0]!;
    expect(status().props.children).toContain('Hors ligne');
    expect(root.root.findByProps({ testID: 'availability-toggle' }).props.variant).toBe('primary');

    await press(root);
    expect(status().props.children).toContain('En ligne');
    expect(root.root.findByProps({ testID: 'availability-toggle' }).props.variant).toBe('soft');
  });

  it("remonté alors que le chauffeur est déjà en ligne (retour de l'encaissement), l'interrupteur dit « En ligne »", async () => {
    // Constaté sur émulateur (22 octobre) : après « Terminé » sur l'écran d'encaissement, l'accueil
    // est remonté et l'interrupteur repartait de « Hors ligne », alors que le chauffeur était
    // toujours en ligne côté serveur et recevait des propositions.
    mockTrackerState = 'online_idle';
    const root = await renderToggle();
    const status = root.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'availability-status')[0]!;
    expect(status.props.children).toContain('En ligne');
    expect(root.root.findByProps({ testID: 'availability-toggle' }).props.variant).toBe('soft');
  });

});
