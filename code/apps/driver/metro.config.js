const path = require('node:path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Configuration Metro pour un monorepo npm workspaces (L0-03, "le point qui casse le plus
 * souvent" -- amoa/specs/L0-socle.md). Metro doit :
 * 1. surveiller la racine du monorepo (watchFolders), pas seulement ce dossier, pour voir
 *    packages/contracts, packages/ui, packages/maps, packages/api-client ;
 * 2. résoudre les modules à la fois depuis node_modules local et depuis node_modules à la
 *    racine, où npm hisse la plupart des dépendances partagées.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = {
  watchFolders: [monorepoRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(monorepoRoot, 'node_modules'),
    ],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
