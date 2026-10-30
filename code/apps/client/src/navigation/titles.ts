import { APP_NAME } from '../brand';
import type { ClientParamList } from './types';

/**
 * Titre affiché dans la barre de chaque écran. Un `Record` sur toutes les routes : ajouter un écran
 * sans lui donner de titre ne compile pas -- sinon la barre affiche le nom technique de la route
 * (« Home », « Quote »), en anglais, devant le client.
 */
export const SCREEN_TITLES: Record<keyof ClientParamList, string> = {
  Home: APP_NAME,
  Quote: 'Votre course',
  Waiting: 'Recherche d’un chauffeur',
  // L'écran affiche déjà l'étape (« Votre chauffeur arrive », « Course en cours ») : la barre ne la répète pas.
  Tracking: 'Suivi de course',
  RideSummary: 'Course terminée',
  History: 'Mes courses',
  Invoice: 'Facture',
};
