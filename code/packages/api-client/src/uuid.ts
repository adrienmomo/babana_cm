/**
 * `node:crypto` n'existe pas dans le runtime React Native (Hermes) : ce paquet est consommé par
 * `apps/*`, donc pas de dépendance Node ici. Générateur UUID v4 minimal sur Math.random() --
 * suffisant pour un identifiant d'idempotence ou de message non secret, portable partout sans
 * dépendance nouvelle. Extrait de `realtime.ts` (L0-03) pour être partagé avec `http/idempotency.ts`
 * (L6-03) -- un seul générateur, pas deux copies qui divergeraient.
 */
export function randomUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
