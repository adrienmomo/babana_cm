import type { MapProvider } from '../../types';
import { GoogleMapView } from './MapView';
import { openNavigation } from './navigation';
import { reverseGeocode, searchPlace } from './places';

export { configureGoogleMapsProvider } from './config';

export const googleMapProvider: MapProvider = {
  MapView: GoogleMapView,
  openNavigation,
  searchPlace,
  reverseGeocode,
};
