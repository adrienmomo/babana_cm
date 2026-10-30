import { z } from 'zod';
import { IsoDateTimeSchema, LatLngSchema, MoneyAmountSchema } from './common';
import { FareBreakdownSchema } from './quote';

/**
 * Historique et factures du client (L6-10, version minimale de démonstration, 30 octobre).
 *
 * GET /rides -- les courses terminées du client, de la plus récente à la plus ancienne, par pages
 * (taille fixée par le serveur, babana.ride_history_page_size). `cursor` : le `nextCursor` de la
 * page précédente ; absent pour la première page.
 */
export const RideHistoryQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
});
export type RideHistoryQuery = z.infer<typeof RideHistoryQuerySchema>;

export const RideHistoryStatusSchema = z.enum(['settled', 'completed', 'cancelled']);
export type RideHistoryStatus = z.infer<typeof RideHistoryStatusSchema>;

export const RideHistoryEntrySchema = z.object({
  id: z.string().uuid(),
  reference: z.string(),
  requestedAt: IsoDateTimeSchema,
  pickupLabel: z.string().nullable(),
  dropoffLabel: z.string().nullable(),
  /** Le point d'arrivée lui-même : l'app en tire ses destinations récentes. */
  dropoff: LatLngSchema,
  amount: MoneyAmountSchema,
  status: RideHistoryStatusSchema,
  /** Vrai seulement pour une course encaissée : seule elle a une facture. */
  invoiceAvailable: z.boolean(),
});
export type RideHistoryEntry = z.infer<typeof RideHistoryEntrySchema>;

export const RideHistoryResponseSchema = z.object({
  rides: z.array(RideHistoryEntrySchema),
  nextCursor: z.string().nullable(),
});
export type RideHistoryResponse = z.infer<typeof RideHistoryResponseSchema>;

export const RideHistoryErrors = [] as const;

/**
 * GET /rides/{id}/invoice -- la facture d'une course encaissée, telle qu'émise : le détail
 * décomposé est celui GELÉ à la création de la course, jamais recalculé depuis la grille actuelle
 * (L6-10, critère 4). Paiement toujours en espèces (D8).
 */
export const RideInvoiceResponseSchema = z.object({
  rideId: z.string().uuid(),
  reference: z.string(),
  invoiceNumber: z.string(),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rideDate: IsoDateTimeSchema,
  pickupLabel: z.string().nullable(),
  dropoffLabel: z.string().nullable(),
  distanceMeters: z.number().int().nonnegative().nullable(),
  driverName: z.string().nullable(),
  amount: MoneyAmountSchema,
  currency: z.literal('XAF'),
  breakdown: FareBreakdownSchema,
  paymentMethod: z.literal('cash'),
  /** Adresse où « Recevoir par email » enverra la facture ; `null` : aucune adresse connue. */
  email: z.string().nullable(),
});
export type RideInvoiceResponse = z.infer<typeof RideInvoiceResponseSchema>;

export const RideInvoiceErrors = ['RIDE_NOT_FOUND', 'INVOICE_NOT_AVAILABLE'] as const;

/** POST /rides/{id}/invoice/email -- renvoie la facture PDF à l'adresse du client. */
export const SendInvoiceEmailResponseSchema = z.object({
  sent: z.literal(true),
  email: z.string(),
});
export type SendInvoiceEmailResponse = z.infer<typeof SendInvoiceEmailResponseSchema>;

export const SendInvoiceEmailErrors = [
  'RIDE_NOT_FOUND',
  'INVOICE_NOT_AVAILABLE',
  'CLIENT_EMAIL_MISSING',
  'INVOICE_EMAIL_FAILED',
] as const;

export const rideHistoryRequestExample: RideHistoryQuery = {};

export const rideHistoryResponseExample: RideHistoryResponse = {
  rides: [
    {
      id: '11111111-2222-4333-8444-555555555555',
      reference: 'BAB-2026-000123',
      requestedAt: '2026-10-29T18:12:00+01:00',
      pickupLabel: 'vers Carrefour Tiff',
      dropoffLabel: 'vers Rond-point Deïdo',
      dropoff: { latitude: 4.0622, longitude: 9.7108 },
      amount: 700,
      status: 'settled',
      invoiceAvailable: true,
    },
  ],
  nextCursor: null,
};

export const rideInvoiceResponseExample: RideInvoiceResponse = {
  rideId: '11111111-2222-4333-8444-555555555555',
  reference: 'BAB-2026-000123',
  invoiceNumber: 'INV/2026/00042',
  invoiceDate: '2026-10-29',
  rideDate: '2026-10-29T18:12:00+01:00',
  pickupLabel: 'vers Carrefour Tiff',
  dropoffLabel: 'vers Rond-point Deïdo',
  distanceMeters: 2600,
  driverName: 'Emmanuel',
  amount: 700,
  currency: 'XAF',
  breakdown: {
    baseFare: 200,
    approachFare: 75,
    distanceFare: 260,
    surgeAmount: 0,
    discountAmount: 0,
    floorAmount: 0,
    roundingAmount: 165,
    minimumFareApplied: false,
  },
  paymentMethod: 'cash',
  email: 'nadege.eloundou@example.cm',
};

export const sendInvoiceEmailResponseExample: SendInvoiceEmailResponse = {
  sent: true,
  email: 'nadege.eloundou@example.cm',
};
