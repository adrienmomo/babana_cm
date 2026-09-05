/**
 * Surface minimale de l'API Google Maps JavaScript réellement utilisée par ce fournisseur --
 * pas `@types/google.maps` (paquet de types complet, poids que CLAUDE.md demande de signaler
 * avant d'ajouter pour une poignée de méthodes). `providers/web/` entier est exclu de
 * tsconfig.json (natif) et inclus par tsconfig.web.json -- ce fichier n'est donc jamais vu par
 * la compilation native.
 */
interface GoogleLatLngLiteral {
  lat: number;
  lng: number;
}

interface GoogleMapOptions {
  center: GoogleLatLngLiteral;
  zoom: number;
  disableDefaultUI?: boolean;
  clickableIcons?: boolean;
}

interface GoogleMapsEventListener {
  remove(): void;
}

interface GoogleMap {
  getCenter(): { lat(): number; lng(): number } | undefined;
  addListener(eventName: string, handler: () => void): GoogleMapsEventListener;
  setCenter(position: GoogleLatLngLiteral): void;
}

interface GoogleMarkerOptions {
  position: GoogleLatLngLiteral;
  map: GoogleMap;
  title?: string;
  icon?: { url: string; scaledSize?: { width: number; height: number } } | string;
}

interface GoogleMarker {
  setMap(map: GoogleMap | null): void;
}

interface GooglePolylineOptions {
  path: GoogleLatLngLiteral[];
  map: GoogleMap;
  strokeColor?: string;
  strokeWeight?: number;
}

interface GooglePolyline {
  setMap(map: GoogleMap | null): void;
}

interface GoogleMapsNamespace {
  Map: new (container: Element, options: GoogleMapOptions) => GoogleMap;
  Marker: new (options: GoogleMarkerOptions) => GoogleMarker;
  Polyline: new (options: GooglePolylineOptions) => GooglePolyline;
}

interface Window {
  google?: {
    maps: GoogleMapsNamespace;
  };
}
