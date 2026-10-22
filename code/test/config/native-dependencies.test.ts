// Un module natif n'est compilé dans l'APK que si l'APP le déclare : l'autolinking de React Native
// lit le package.json de l'app, jamais celui des paquets partagés qu'elle importe. Un module natif
// requis par `@babana/api-client` ou `@babana/maps` mais absent de l'app passe tous les tests Jest
// (les modules natifs y sont simulés) et plante seulement sur l'appareil. Constaté le 22 octobre en
// lançant l'app Client sur émulateur : `react-native-webview` (carte OpenStreetMap) puis
// `@react-native-async-storage/async-storage` (file hors connexion) manquaient.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const APPS = ['client', 'driver'];

type PackageJson = { name: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };

const readJson = (path: string): PackageJson => JSON.parse(readFileSync(path, 'utf8')) as PackageJson;

/** Un paquet est natif pour Android s'il porte un dossier `android/` (ce que l'autolinking compile). */
const isNative = (name: string): boolean => existsSync(join(root, 'node_modules', name, 'android'));

test('au moins un module natif est détecté dans les paquets partagés (sinon ce test ne prouve rien)', () => {
  assert.ok(isNative('react-native-maps'));
});

for (const app of APPS) {
  const appPackage = readJson(join(root, 'apps', app, 'package.json'));
  const declared = new Set(Object.keys(appPackage.dependencies ?? {}));
  const shared = [...declared].filter((name) => name.startsWith('@babana/'));

  for (const sharedName of shared) {
    const sharedPackage = readJson(join(root, 'packages', sharedName.replace('@babana/', ''), 'package.json'));
    const required = [...Object.keys(sharedPackage.dependencies ?? {}), ...Object.keys(sharedPackage.peerDependencies ?? {})];
    const missing = required.filter((name) => name !== 'react-native' && isNative(name) && !declared.has(name));

    test(`apps/${app} déclare les modules natifs dont ${sharedName} a besoin`, () => {
      assert.deepEqual(missing, [], `à ajouter aux dependencies de apps/${app}/package.json : ${missing.join(', ')}`);
    });
  }
}
