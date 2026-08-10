module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // Injecte les variables d'environnement de build dans le bundle (BABANA_API_URL,
  // BABANA_REALTIME_WS_URL) -- critère d'acceptation 7 de L0-03 : aucune adresse de serveur
  // codée en dur, les apps lisent l'hôte depuis leur configuration de build.
  plugins: ['transform-inline-environment-variables'],
};
