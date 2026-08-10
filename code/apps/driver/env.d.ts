/**
 * Déclaration minimale pour `process.env`, utilisé par config.ts (babel-plugin-transform-
 * inline-environment-variables substitue ces accès au moment du bundle). Volontairement pas
 * `@types/node` complet : ça exposerait toute l'API Node (fs, path, Buffer...) comme si elle
 * existait sur React Native, ce qui masquerait exactement le genre d'erreur de plateforme que
 * le typage strict est censé attraper (CLAUDE.md).
 */
declare const process: { env: Record<string, string | undefined> };
