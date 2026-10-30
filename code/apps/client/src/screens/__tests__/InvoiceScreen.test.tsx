import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { http } from '@babana/contracts';
import { ApiError } from '@babana/api-client';

const mockRequest = jest.fn();
jest.mock('../../auth', () => ({
  apiClient: { request: (...args: unknown[]) => mockRequest(...args) },
}));

import { InvoiceScreen } from '../InvoiceScreen';

const INVOICE = http.rideInvoiceResponseExample;

const roots: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  mockRequest.mockReset();
});

async function renderInvoice() {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(
      // @ts-expect-error -- fausse navigation minimale, suffisante pour cet écran
      <InvoiceScreen navigation={{}} route={{ key: 'Invoice', name: 'Invoice', params: { rideId: INVOICE.rideId } }} />
    );
  });
  roots.push(root);
  return root;
}

function texts(root: ReactTestRenderer): string {
  return root.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

const fcfa = (amount: number) => `${amount.toLocaleString('fr-FR')} FCFA`;

describe('InvoiceScreen (L6-10)', () => {
  it('affiche la facture telle qu’émise : numéro, trajet, détail, total payé en espèces', async () => {
    mockRequest.mockResolvedValue(INVOICE);
    const root = await renderInvoice();

    expect(mockRequest).toHaveBeenCalledWith('rideInvoice', { pathParams: { id: INVOICE.rideId } });
    expect(texts(root)).toContain(INVOICE.invoiceNumber);
    expect(texts(root)).toContain('vers Carrefour Tiff');
    expect(texts(root)).toContain('Prise en charge');
    expect(texts(root)).toContain(fcfa(INVOICE.breakdown.approachFare));
    expect(JSON.stringify(root.root.findByProps({ testID: 'invoice-total' }).props.children)).toContain(fcfa(INVOICE.amount));
    expect(texts(root)).toContain('Payé en espèces au chauffeur');
  });

  it('« Recevoir par email » envoie la facture et dit où', async () => {
    mockRequest.mockImplementation(async (name: string) => {
      if (name === 'rideInvoice') return INVOICE;
      if (name === 'sendInvoiceEmail') return { sent: true, email: 'nadege@example.cm' };
      throw new Error(name);
    });
    const root = await renderInvoice();

    await act(async () => {
      root.root.findByProps({ testID: 'invoice-send-email' }).props.onPress();
    });

    expect(mockRequest).toHaveBeenCalledWith('sendInvoiceEmail', { pathParams: { id: INVOICE.rideId } });
    expect(texts(root)).toContain('nadege@example.cm');
  });

  it('un envoi refusé est dit, pas caché', async () => {
    mockRequest.mockImplementation(async (name: string) => {
      if (name === 'rideInvoice') return INVOICE;
      throw new ApiError('INVOICE_EMAIL_FAILED', 'SMTP', 502);
    });
    const root = await renderInvoice();

    await act(async () => {
      root.root.findByProps({ testID: 'invoice-send-email' }).props.onPress();
    });

    expect(root.root.findByProps({ testID: 'invoice-send-error' })).toBeTruthy();
  });

  it('sans adresse email, pas de bouton mais une explication', async () => {
    mockRequest.mockResolvedValue({ ...INVOICE, email: null });
    const root = await renderInvoice();

    expect(root.root.findAllByProps({ testID: 'invoice-send-email' })).toHaveLength(0);
    expect(root.root.findByProps({ testID: 'invoice-no-email' })).toBeTruthy();
  });
});
