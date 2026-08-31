import type { z } from 'zod';
import { ErrorCode } from './errors';

export * from './errors';
export * from './common';
export * from './auth';
export * from './phone';
export * from './quote';
export * from './ride';
export * from './settlement';
export * from './remittance';
export * from './driver';
export * from './documents';
export * from './devices';
export * from './incident';
export * from './share';

import * as auth from './auth';
import * as phone from './phone';
import * as quote from './quote';
import * as ride from './ride';
import * as settlement from './settlement';
import * as remittance from './remittance';
import * as driver from './driver';
import * as documents from './documents';
import * as devices from './devices';
import * as incident from './incident';
import * as share from './share';

/**
 * Codes implicitement possibles sur tout endpoint, sans être répétés dans la liste
 * d'erreurs de chaque endpoint (critère d'acceptation 4 de C-01 : le catalogue reste
 * exhaustif, ces codes en font partie au même titre que les codes spécifiques).
 *
 * - VALIDATION_ERROR et INTERNAL_ERROR : possibles partout.
 * - UNAUTHORIZED : possible partout sauf sur l'unique endpoint public, /auth/google.
 */
export const IMPLICIT_ERRORS = ['VALIDATION_ERROR', 'INTERNAL_ERROR'] as const satisfies readonly ErrorCode[];
export const IMPLICIT_AUTHENTICATED_ERRORS = ['UNAUTHORIZED'] as const satisfies readonly ErrorCode[];

export interface HttpEndpointDescriptor {
  method: 'GET' | 'POST';
  path: string;
  requiresAuth: boolean;
  requestSchema: z.ZodTypeAny | null;
  responseSchema: z.ZodTypeAny;
  errors: readonly ErrorCode[];
  requestExample: unknown;
  responseExample: unknown;
}

/**
 * Registre unique de tous les endpoints du contrat C-01. Consommé par
 * scripts/generate-json-schema.ts pour produire dist/json-schema/, et par
 * docs/contracts/http-api.md pour rester synchronisé avec le code (D17 : le contrat est du
 * code, pas un document qu'on oublie de mettre à jour).
 */
export const HTTP_ENDPOINTS = {
  authGoogle: {
    method: 'POST',
    path: '/api/v1/auth/google',
    requiresAuth: false,
    requestSchema: auth.GoogleAuthRequestSchema,
    responseSchema: auth.GoogleAuthResponseSchema,
    errors: auth.GoogleAuthErrors,
    requestExample: auth.googleAuthRequestExample,
    responseExample: auth.googleAuthResponseExample,
  },
  authRefresh: {
    method: 'POST',
    path: '/api/v1/auth/refresh',
    requiresAuth: true,
    requestSchema: auth.RefreshRequestSchema,
    responseSchema: auth.RefreshResponseSchema,
    errors: auth.RefreshErrors,
    requestExample: auth.refreshRequestExample,
    responseExample: auth.refreshResponseExample,
  },
  authLogout: {
    method: 'POST',
    path: '/api/v1/auth/logout',
    requiresAuth: true,
    requestSchema: auth.LogoutRequestSchema,
    responseSchema: auth.LogoutResponseSchema,
    errors: auth.LogoutErrors,
    requestExample: auth.logoutRequestExample,
    responseExample: auth.logoutResponseExample,
  },
  me: {
    method: 'GET',
    path: '/api/v1/me',
    requiresAuth: true,
    requestSchema: null,
    responseSchema: auth.MeResponseSchema,
    errors: auth.MeErrors,
    requestExample: null,
    responseExample: auth.meResponseExample,
  },
  phoneVerifyStart: {
    method: 'POST',
    path: '/api/v1/phone/verify/start',
    requiresAuth: true,
    requestSchema: phone.PhoneVerifyStartRequestSchema,
    responseSchema: phone.PhoneVerifyStartResponseSchema,
    errors: phone.PhoneVerifyStartErrors,
    requestExample: phone.phoneVerifyStartRequestExample,
    responseExample: phone.phoneVerifyStartResponseExample,
  },
  phoneVerifyConfirm: {
    method: 'POST',
    path: '/api/v1/phone/verify/confirm',
    requiresAuth: true,
    requestSchema: phone.PhoneVerifyConfirmRequestSchema,
    responseSchema: phone.PhoneVerifyConfirmResponseSchema,
    errors: phone.PhoneVerifyConfirmErrors,
    requestExample: phone.phoneVerifyConfirmRequestExample,
    responseExample: phone.phoneVerifyConfirmResponseExample,
  },
  quote: {
    method: 'POST',
    path: '/api/v1/quote',
    requiresAuth: true,
    requestSchema: quote.QuoteRequestSchema,
    responseSchema: quote.QuoteResponseSchema,
    errors: quote.QuoteErrors,
    requestExample: quote.quoteRequestExample,
    responseExample: quote.quoteResponseExample,
  },
  createRide: {
    method: 'POST',
    path: '/api/v1/rides',
    requiresAuth: true,
    requestSchema: ride.CreateRideRequestSchema,
    responseSchema: ride.CreateRideResponseSchema,
    errors: ride.CreateRideErrors,
    requestExample: ride.createRideRequestExample,
    responseExample: ride.createRideResponseExample,
  },
  selectDriver: {
    method: 'POST',
    path: '/api/v1/rides/{id}/select-driver',
    requiresAuth: true,
    requestSchema: ride.SelectDriverRequestSchema,
    responseSchema: ride.SelectDriverResponseSchema,
    errors: ride.SelectDriverErrors,
    requestExample: ride.selectDriverRequestExample,
    responseExample: ride.selectDriverResponseExample,
  },
  startRide: {
    method: 'POST',
    path: '/api/v1/rides/{id}/start',
    requiresAuth: true,
    requestSchema: ride.StartRideRequestSchema,
    responseSchema: ride.StartRideResponseSchema,
    errors: ride.StartRideErrors,
    requestExample: ride.startRideRequestExample,
    responseExample: ride.startRideResponseExample,
  },
  completeRide: {
    method: 'POST',
    path: '/api/v1/rides/{id}/complete',
    requiresAuth: true,
    requestSchema: ride.CompleteRideRequestSchema,
    responseSchema: ride.CompleteRideResponseSchema,
    errors: ride.CompleteRideErrors,
    requestExample: ride.completeRideRequestExample,
    responseExample: ride.completeRideResponseExample,
  },
  settleRide: {
    method: 'POST',
    path: '/api/v1/rides/{id}/settle',
    requiresAuth: true,
    requestSchema: settlement.SettleRideRequestSchema,
    responseSchema: settlement.SettleRideResponseSchema,
    errors: settlement.SettleRideErrors,
    requestExample: settlement.settleRideRequestExample,
    responseExample: settlement.settleRideResponseExample,
  },
  cancelRide: {
    method: 'POST',
    path: '/api/v1/rides/{id}/cancel',
    requiresAuth: true,
    requestSchema: ride.CancelRideRequestSchema,
    responseSchema: ride.CancelRideResponseSchema,
    errors: ride.CancelRideErrors,
    requestExample: ride.cancelRideRequestExample,
    responseExample: ride.cancelRideResponseExample,
  },
  rateRide: {
    method: 'POST',
    path: '/api/v1/rides/{id}/rate',
    requiresAuth: true,
    requestSchema: ride.RateRideRequestSchema,
    responseSchema: ride.RateRideResponseSchema,
    errors: ride.RateRideErrors,
    requestExample: ride.rateRideRequestExample,
    responseExample: ride.rateRideResponseExample,
  },
  setAvailability: {
    method: 'POST',
    path: '/api/v1/drivers/me/availability',
    requiresAuth: true,
    requestSchema: driver.SetAvailabilityRequestSchema,
    responseSchema: driver.SetAvailabilityResponseSchema,
    errors: driver.SetAvailabilityErrors,
    requestExample: driver.setAvailabilityRequestExample,
    responseExample: driver.setAvailabilityResponseExample,
  },
  driverCash: {
    method: 'GET',
    path: '/api/v1/drivers/me/cash',
    requiresAuth: true,
    requestSchema: null,
    responseSchema: settlement.DriverCashResponseSchema,
    errors: settlement.DriverCashErrors,
    requestExample: null,
    responseExample: settlement.driverCashResponseExample,
  },
  createRemittance: {
    method: 'POST',
    path: '/api/v1/remittances',
    requiresAuth: true,
    requestSchema: remittance.CreateRemittanceRequestSchema,
    responseSchema: remittance.CreateRemittanceResponseSchema,
    errors: remittance.CreateRemittanceErrors,
    requestExample: remittance.createRemittanceRequestExample,
    responseExample: remittance.createRemittanceResponseExample,
  },
  uploadDriverDocument: {
    method: 'POST',
    path: '/api/v1/driver/documents',
    requiresAuth: true,
    // multipart/form-data (fichier + champs), pas un corps JSON -- voir documents.ts.
    // UploadDriverDocumentFieldsSchema décrit les champs hors fichier, à part.
    requestSchema: null,
    responseSchema: documents.UploadDriverDocumentResponseSchema,
    errors: documents.UploadDriverDocumentErrors,
    // Corps multipart, pas JSON : requestSchema est null (comme driverCash, GET sans body),
    // donc requestExample l'est aussi -- UploadDriverDocumentFieldsSchema/
    // uploadDriverDocumentFieldsExample restent exportés depuis documents.ts pour l'app, mais
    // hors de ce registre générique qui suppose un corps JSON pur.
    requestExample: null,
    responseExample: documents.uploadDriverDocumentResponseExample,
  },
  listDriverDocuments: {
    method: 'GET',
    path: '/api/v1/driver/documents',
    requiresAuth: true,
    requestSchema: null,
    responseSchema: documents.ListDriverDocumentsResponseSchema,
    errors: documents.ListDriverDocumentsErrors,
    requestExample: null,
    responseExample: documents.listDriverDocumentsResponseExample,
  },
  registerDeviceToken: {
    method: 'POST',
    path: '/api/v1/devices',
    requiresAuth: true,
    requestSchema: devices.RegisterDeviceTokenRequestSchema,
    responseSchema: devices.RegisterDeviceTokenResponseSchema,
    errors: devices.RegisterDeviceTokenErrors,
    requestExample: devices.registerDeviceTokenRequestExample,
    responseExample: devices.registerDeviceTokenResponseExample,
  },
  deactivateDeviceToken: {
    method: 'POST',
    path: '/api/v1/devices/deactivate',
    requiresAuth: true,
    requestSchema: devices.DeactivateDeviceTokenRequestSchema,
    responseSchema: devices.DeactivateDeviceTokenResponseSchema,
    errors: devices.DeactivateDeviceTokenErrors,
    requestExample: devices.deactivateDeviceTokenRequestExample,
    responseExample: devices.deactivateDeviceTokenResponseExample,
  },
  driverDocumentSignedUrl: {
    method: 'GET',
    path: '/api/v1/driver/documents/{id}/url',
    requiresAuth: true,
    requestSchema: null,
    responseSchema: documents.DriverDocumentSignedUrlResponseSchema,
    errors: documents.DriverDocumentSignedUrlErrors,
    requestExample: null,
    responseExample: documents.driverDocumentSignedUrlResponseExample,
  },
  triggerIncident: {
    method: 'POST',
    path: '/api/v1/rides/{id}/incidents',
    requiresAuth: true,
    requestSchema: incident.TriggerIncidentRequestSchema,
    responseSchema: incident.TriggerIncidentResponseSchema,
    errors: incident.TriggerIncidentErrors,
    requestExample: incident.triggerIncidentRequestExample,
    responseExample: incident.triggerIncidentResponseExample,
  },
  createRideShare: {
    method: 'POST',
    path: '/api/v1/rides/{id}/share',
    requiresAuth: true,
    requestSchema: null,
    responseSchema: share.CreateRideShareResponseSchema,
    errors: share.CreateRideShareErrors,
    requestExample: null,
    responseExample: share.createRideShareResponseExample,
  },
  revokeRideShare: {
    method: 'POST',
    path: '/api/v1/rides/{id}/share/revoke',
    requiresAuth: true,
    requestSchema: null,
    responseSchema: share.RevokeRideShareResponseSchema,
    errors: share.RevokeRideShareErrors,
    requestExample: null,
    responseExample: share.revokeRideShareResponseExample,
  },
} satisfies Record<string, HttpEndpointDescriptor>;
