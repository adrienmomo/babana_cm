import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from './Button';

/**
 * Écran de connexion par numéro de téléphone et code SMS (OTP), partagé par les deux apps.
 * Purement présentationnel : il ne sait ni appeler le serveur, ni valider un numéro, ni décider
 * de quoi que ce soit (invariant 3). Il saisit, appelle les deux actions qu'on lui donne, et
 * affiche le message d'erreur que `describeError` produit.
 *
 * Deux étapes : le numéro (le préfixe pays est affiché, l'utilisateur ne tape que les chiffres
 * locaux), puis le code reçu par SMS. Uniquement des primitives `react-native` (D22).
 */
export interface PhoneSignInProps {
  title: string;
  /** Préfixe pays affiché devant la saisie ; l'action reçoit le numéro complet. */
  phonePrefix?: string;
  /** Nombre de chiffres locaux attendus (9 au Cameroun) : le bouton reste inactif en dessous. */
  phoneDigits?: number;
  codeLength?: number;
  /** Demande l'envoi du code. Rejette en cas d'échec. */
  requestCode: (phoneNumber: string) => Promise<void>;
  /** Vérifie le code. Rejette en cas d'échec ; en cas de succès, l'appelant navigue. */
  verifyCode: (code: string) => Promise<void>;
  describeError: (error: unknown) => string;
}

export function PhoneSignIn({
  title,
  phonePrefix = '+237',
  phoneDigits = 9,
  codeLength = 6,
  requestCode,
  verifyCode,
  describeError,
}: PhoneSignInProps) {
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fullNumber = `${phonePrefix}${phone}`;

  async function run(action: () => Promise<void>) {
    setError(null);
    setPending(true);
    try {
      await action();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setPending(false);
    }
  }

  const sendCode = () =>
    run(async () => {
      await requestCode(fullNumber);
      setCode('');
      setStep('code');
    });

  const confirmCode = () => run(() => verifyCode(code));

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      {step === 'phone' ? (
        <>
          <Text style={styles.label}>Votre numéro de téléphone</Text>
          <View style={styles.row}>
            <Text style={styles.prefix}>{phonePrefix}</Text>
            <TextInput
              testID="phone-input"
              style={[styles.input, styles.grow]}
              value={phone}
              onChangeText={(text) => setPhone(text.replace(/\D/g, '').slice(0, phoneDigits))}
              keyboardType="phone-pad"
              autoComplete="tel"
              placeholder="6XXXXXXXX"
              editable={!pending}
            />
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button
            testID="send-code"
            label={pending ? 'Envoi…' : 'Recevoir le code par SMS'}
            onPress={sendCode}
            disabled={pending || phone.length !== phoneDigits}
          />
        </>
      ) : (
        <>
          <Text style={styles.label}>Code reçu par SMS au {fullNumber}</Text>
          <TextInput
            testID="code-input"
            style={[styles.input, styles.code]}
            value={code}
            onChangeText={(text) => setCode(text.replace(/\D/g, '').slice(0, codeLength))}
            keyboardType="number-pad"
            autoComplete="sms-otp"
            textContentType="oneTimeCode"
            maxLength={codeLength}
            editable={!pending}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button
            testID="verify-code"
            label={pending ? 'Vérification…' : 'Se connecter'}
            onPress={confirmCode}
            disabled={pending || code.length !== codeLength}
          />
          <Button testID="resend-code" label="Renvoyer le code" variant="secondary" onPress={sendCode} disabled={pending} />
          <Button
            testID="change-number"
            label="Changer de numéro"
            variant="secondary"
            onPress={() => {
              setError(null);
              setStep('phone');
            }}
            disabled={pending}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', gap: 16, padding: 24 },
  title: { fontSize: 24, fontWeight: '700', textAlign: 'center' },
  label: { textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  prefix: { fontSize: 18, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: '#9CA3AF', borderRadius: 8, padding: 12, fontSize: 18 },
  grow: { flex: 1 },
  code: { textAlign: 'center', letterSpacing: 8, fontSize: 24 },
  error: { color: '#B91C1C', textAlign: 'center' },
});
