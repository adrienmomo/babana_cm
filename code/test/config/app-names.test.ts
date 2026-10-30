// Le nom sous l'icône est celui que l'app affiche (`src/brand.ts`) : « Babana Pro » pour le
// chauffeur, « Babana » pour le client, sur Android comme sur iOS. Vu le 30 octobre : l'émulateur
// montrait « BabanaDriver » sous l'icône et « Babana -- Chauffeur » à la connexion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const APPS = [
  { app: 'driver', ios: 'BabanaDriver', expected: 'Babana Pro' },
  { app: 'client', ios: 'BabanaClient', expected: 'Babana' },
] as const;

for (const { app, ios, expected } of APPS) {
  test(`app ${app} : src/brand.ts nomme l'app « ${expected} »`, () => {
    assert.match(read(`apps/${app}/src/brand.ts`), new RegExp(`export const APP_NAME = '${expected}';`));
  });

  test(`app ${app} : le même nom sous l'icône, Android et iOS`, () => {
    assert.equal(JSON.parse(read(`apps/${app}/app.json`)).displayName, expected);
    assert.ok(read(`apps/${app}/android/app/src/main/res/values/strings.xml`).includes(`<string name="app_name">${expected}</string>`));
    assert.match(read(`apps/${app}/ios/${ios}/Info.plist`), new RegExp(`<key>CFBundleDisplayName</key>\\s*<string>${expected}</string>`));
    assert.ok(read(`apps/${app}/ios/${ios}/LaunchScreen.storyboard`).includes(`text="${expected}"`));
  });
}
