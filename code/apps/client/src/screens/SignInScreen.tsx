import React, { useRef } from 'react';
import { PhoneSignIn } from '@babana/ui';
import { ApiError, translateApiError, type AuthState } from '@babana/api-client';
import { authClient } from '../auth';
import { APP_NAME } from '../brand';

/**
 * Connexion par numéro de téléphone et code SMS (OTP). Toute la logique -- envoi du code, échange
 * contre le jeton applicatif, stockage sécurisé -- vit dans `@babana/api-client` et `../auth.ts` ;
 * l'interface est `PhoneSignIn` (`@babana/ui`), partagée avec l'autre app. Cet écran relie les
 * deux et ne décide de rien (invariant 3). Seul le rôle ('client') diffère d'une app à l'autre.
 */
export interface SignInScreenProps {
  /** Le routage qui suit est décidé par l'appelant à partir de `session.user` -- pas par cet
   * écran. */
  onSignedIn: (session: AuthState) => void;
}

const GENERIC_ERROR = 'La connexion a échoué. Réessayez.';

export function describeSignInError(cause: unknown): string {
  return cause instanceof ApiError ? translateApiError(cause) : GENERIC_ERROR;
}

export function SignInScreen({ onSignedIn }: SignInScreenProps) {
  const verificationId = useRef<string | null>(null);

  return (
    <PhoneSignIn
      title={APP_NAME}
      describeError={describeSignInError}
      requestCode={async (phoneNumber) => {
        const response = await authClient.requestOtp(phoneNumber, 'client');
        verificationId.current = response.verificationId;
      }}
      verifyCode={async (code) => {
        if (!verificationId.current) throw new Error('aucune demande de code en cours');
        onSignedIn(await authClient.verifyOtp(verificationId.current, code));
      }}
    />
  );
}
