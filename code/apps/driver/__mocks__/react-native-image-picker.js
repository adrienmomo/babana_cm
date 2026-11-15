// Sélecteur de photo natif (15 novembre) : jamais ouvert dans les tests -- les écrans reçoivent un
// `ImageSource` double ; `imageSource.test.ts` pilote ces deux fonctions.
module.exports = {
  launchCamera: jest.fn(),
  launchImageLibrary: jest.fn(),
};
