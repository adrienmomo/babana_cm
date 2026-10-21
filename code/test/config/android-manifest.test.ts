// Le manifeste Android de l'app Chauffeur doit déclarer toutes les permissions que le code
// DEMANDE à l'exécution. Une permission demandée par `PermissionsAndroid.request` mais absente du
// manifeste est refusée sans dialogue : le chauffeur passe « en ligne » mais l'app ne lit jamais
// sa position, il n'apparaît chez aucun client et ne reçoit jamais de proposition. Constaté en
// faisant tourner l'app sur un émulateur (21 octobre) : seules INTERNET et VIBRATE y figuraient.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const manifest = readFileSync(join(root, 'apps/driver/android/app/src/main/AndroidManifest.xml'), 'utf8');
const permissionsSource = readFileSync(join(root, 'apps/driver/src/location/permissions.ts'), 'utf8');

const declared = new Set([...manifest.matchAll(/<uses-permission android:name="([^"]+)"/g)].map((m) => m[1]));
const requested = [...permissionsSource.matchAll(/PermissionsAndroid\.PERMISSIONS\.([A-Z_]+)/g)].map(
  (m) => `android.permission.${m[1]}`
);

test('le code demande au moins une permission de localisation (sinon ce test ne prouve rien)', () => {
  assert.ok(requested.length >= 2, `permissions détectées : ${requested.join(', ')}`);
});

for (const permission of new Set(requested)) {
  test(`${permission} demandée à l'exécution est déclarée dans le manifeste`, () => {
    assert.ok(declared.has(permission), `${permission} absente de AndroidManifest.xml`);
  });
}

test('la permission de notification (Android 13+) est déclarée, sinon aucune alerte de proposition', () => {
  assert.ok(declared.has('android.permission.POST_NOTIFICATIONS'));
});
