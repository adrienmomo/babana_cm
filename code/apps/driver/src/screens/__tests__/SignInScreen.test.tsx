import React from 'react';
import { Text } from 'react-native';
import { act, create } from 'react-test-renderer';

jest.mock('../../auth', () => ({
  authClient: { requestOtp: jest.fn(), verifyOtp: jest.fn() },
}));

import { ApiError } from '@babana/api-client';
import { authClient } from '../../auth';
import { SignInScreen } from '../SignInScreen';

const mockRequest = authClient.requestOtp as jest.Mock;
const mockVerify = authClient.verifyOtp as jest.Mock;

const byId = (root: ReturnType<typeof create>, id: string) => root.root.findByProps({ testID: id });
const texts = (root: ReturnType<typeof create>) =>
  root.root.findAllByType(Text).map((node) => String(node.props.children)).join(' ');

async function render(onSignedIn = jest.fn()) {
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(<SignInScreen onSignedIn={onSignedIn} />);
  });
  return root;
}

async function typeInto(root: ReturnType<typeof create>, id: string, value: string) {
  await act(async () => {
    byId(root, id).props.onChangeText(value);
  });
}

async function press(root: ReturnType<typeof create>, id: string) {
  await act(async () => {
    await byId(root, id).props.onPress();
  });
}

describe('SignInScreen (app Driver) -- connexion par OTP', () => {
  afterEach(() => jest.clearAllMocks());

  it("n'offre aucune connexion Google", async () => {
    const root = await render();
    expect(texts(root)).not.toMatch(/google/i);
  });

  it('le bouton reste inactif tant que le numéro est incomplet', async () => {
    const root = await render();
    await typeInto(root, 'phone-input', '69123');
    expect(byId(root, 'send-code').props.disabled).toBe(true);
    await typeInto(root, 'phone-input', '691234567');
    expect(byId(root, 'send-code').props.disabled).toBe(false);
  });

  it('demande le code avec le rôle "driver" puis connecte avec le code saisi', async () => {
    mockRequest.mockResolvedValue({ verificationId: 'v-1', expiresIn: 300 });
    mockVerify.mockResolvedValue({ user: { role: 'driver' } });
    const onSignedIn = jest.fn();
    const root = await render(onSignedIn);

    await typeInto(root, 'phone-input', '691234567');
    await press(root, 'send-code');
    expect(mockRequest).toHaveBeenCalledWith('+237691234567', 'driver');
    expect(texts(root)).toContain('+237691234567');

    await typeInto(root, 'code-input', '482913');
    await press(root, 'verify-code');
    expect(mockVerify).toHaveBeenCalledWith('v-1', '482913');
    expect(onSignedIn).toHaveBeenCalledWith({ user: { role: 'driver' } });
  });

  it("affiche le message français d'un code incorrect, sans quitter l'étape du code", async () => {
    mockRequest.mockResolvedValue({ verificationId: 'v-1', expiresIn: 300 });
    mockVerify.mockRejectedValue(new ApiError('OTP_INVALID', 'x', 400));
    const root = await render();
    await typeInto(root, 'phone-input', '691234567');
    await press(root, 'send-code');
    await typeInto(root, 'code-input', '000000');
    await press(root, 'verify-code');

    expect(texts(root)).toContain('Le code saisi est incorrect.');
    expect(byId(root, 'code-input')).toBeTruthy();
  });

  it("affiche l'erreur d'envoi et reste sur le numéro", async () => {
    mockRequest.mockRejectedValue(new ApiError('SMS_UNAVAILABLE', 'x', 503));
    const root = await render();
    await typeInto(root, 'phone-input', '691234567');
    await press(root, 'send-code');

    expect(texts(root)).toContain('Impossible d\'envoyer le SMS');
    expect(byId(root, 'phone-input')).toBeTruthy();
  });

  it('"Renvoyer le code" fait une nouvelle demande et utilise le nouvel identifiant', async () => {
    mockRequest
      .mockResolvedValueOnce({ verificationId: 'v-1', expiresIn: 300 })
      .mockResolvedValueOnce({ verificationId: 'v-2', expiresIn: 300 });
    mockVerify.mockResolvedValue({ user: {} });
    const root = await render();
    await typeInto(root, 'phone-input', '691234567');
    await press(root, 'send-code');
    await press(root, 'resend-code');
    await typeInto(root, 'code-input', '111111');
    await press(root, 'verify-code');

    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockVerify).toHaveBeenCalledWith('v-2', '111111');
  });
});
