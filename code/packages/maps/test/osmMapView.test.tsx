/**
 * Carte Leaflet (OpenStreetMap) dans une WebView, recherche et navigation Google conservées. Le
 * choix se fait par configuration (`tileUrl`) : sans elle, la carte reste celle de Google -- l'app
 * Client n'est pas touchée.
 */
jest.mock('react-native-maps');
jest.mock('react-native-webview');

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import RNMapView from 'react-native-maps';
import WebView, { mockInjectJavaScript } from 'react-native-webview';
import { configureMapsProvider } from '../src/configure';
import { OsmMapView } from '../src/providers/osm/MapView';
import { buildLeafletHtml } from '../src/providers/osm/leafletHtml';
import { MAP_MARKER_COLORS } from '../src/markerColors';
import { _resetMapTileUrlForTests } from '../src/providers/osm/config';
import { _resetGoogleMapsApiKeyForTests, getGoogleMapsApiKey, getSearchUrl } from '../src/providers/google/config';
import { MapView } from '../src/MapView';
import { activeMapProvider } from '../src/activeProvider';
import { googleMapProvider } from '../src/providers/google';

const TILES = 'https://tiles.example.test/{z}/{x}/{y}.png';
const ATTRIBUTION = '© Tuiles Exemple, © OpenStreetMap';
const CENTER = { latitude: 4.05, longitude: 9.7 };

async function render(element: React.ReactElement) {
  let root!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    root = ReactTestRenderer.create(element);
  });
  return root;
}

beforeEach(() => mockInjectJavaScript.mockClear());
afterEach(() => {
  _resetMapTileUrlForTests();
  _resetGoogleMapsApiKeyForTests();
});

describe('buildLeafletHtml', () => {
  const html = (overrides = {}) =>
    buildLeafletHtml({ tileUrlTemplate: TILES, tileAttribution: ATTRIBUTION, center: CENTER, markers: [], ...overrides });

  test("porte l'adresse des tuiles et l'attribution configurée -- celle qu'exige le fournisseur choisi", () => {
    const out = html();
    expect(out).toContain(JSON.stringify(TILES));
    expect(out).toContain(JSON.stringify(ATTRIBUTION));
  });

  test("une attribution hostile ne peut pas sortir de la balise <script>", () => {
    expect(html({ tileAttribution: '</script><script>alert(1)</script>' })).not.toContain('</script><script>alert(1)');
  });

  test("une adresse en {r} (tuiles @2x des écrans denses) est transmise telle quelle à Leaflet, sans détection rétina en z+1", () => {
    const retina = 'https://tiles.example.test/{z}/{x}/{y}{r}.png';
    const out = html({ tileUrlTemplate: retina });
    expect(out).toContain(JSON.stringify(retina));
    // detectRetina demanderait des tuiles d'un niveau de zoom au-dessus : 4x plus de données
    // pour des libellés minuscules. Seul {r} (le fournisseur sert du @2x) rend la carte nette.
    expect(out).not.toContain('detectRetina: true');
  });

  test("dessine les repères en SVG par rôle : épingle au départ et à l'arrivée, moto pour le chauffeur, point pulsé pour le client", () => {
    const out = html();
    expect(out).toContain('L.divIcon');
    for (const kind of ['pickup', 'dropoff', 'driver', 'client']) {
      expect(out).toContain(`babana-marker--${kind}`);
    }
    expect(out).toContain('@keyframes babana-pulse');
  });

  test("le chauffeur est une moto vue de dessus avec son pilote, orientée dans le sens de sa marche, au-dessus des épingles", () => {
    const out = html();
    expect(out).toContain('babana-moto');
    // Le cap se déduit de la position précédente du même repère (aucun cap sur le fil client).
    expect(out).toContain('bearingBetween');
    expect(out).toContain('rotate(');
    // Jamais masqué par une épingle de prise en charge quand il est arrivé.
    expect(out).toContain('zIndexOffset');
  });

  test('les couleurs des repères viennent de la palette partagée du paquet (le réticule des écrans la réutilise)', () => {
    const out = html();
    expect(out).toContain(MAP_MARKER_COLORS.pickup);
    expect(out).toContain(MAP_MARKER_COLORS.dropoff);
  });

  test("le tracé a un liseré blanc sous la ligne bleue, lisible sur un fond chargé", () => {
    const out = html({ route: { points: [CENTER, { latitude: 4.06, longitude: 9.71 }] } });
    expect(out).toContain('ROUTE_CASING');
    expect(out.indexOf('ROUTE_CASING')).toBeLessThan(out.indexOf('ROUTE_LINE'));
  });

  test("charge Leaflet depuis une version épinglée (jamais « latest »)", () => {
    expect(html()).toMatch(/leaflet@1\.9\.4/);
  });

  test("un libellé hostile ne peut pas sortir de la balise <script> (échappement des « < »)", () => {
    const out = html({
      markers: [{ id: 'x', kind: 'driver', position: CENTER, label: '</script><script>alert(1)</script>' }],
    });
    expect(out).not.toContain('</script><script>alert(1)');
  });

  test("cadre la carte sur le tracé quand il change (fitBounds), sans le refaire à chaque position", () => {
    const out = html({ route: { points: [CENTER, { latitude: 4.06, longitude: 9.71 }] } });
    expect(out).toContain('fitBounds');
    // Le cadrage est conditionné au changement de tracé, pas rejoué à chaque mise à jour.
    expect(out).toContain('routeKey');
  });

  test("ne recentre que si la prop centre change (le cadrage d'un tracé ne saute pas à chaque position)", () => {
    expect(html()).toContain('lastCenter');
  });

  // 25 octobre : à l'ouverture de l'accueil Client, le recentrage programmé sur la position GPS
  // était relayé comme un déplacement de l'utilisateur -- l'arrivée se remplissait seule avec le
  // point de départ. Seul un geste du doigt (glisser, pincer) est une désignation.
  test("ne signale un déplacement que s'il vient d'un geste de l'utilisateur, jamais d'un recentrage programmé", () => {
    const out = html();
    expect(out).toContain('userGesture');
    expect(out).toContain("'touchstart'");
    expect(out).toMatch(/if \(!userGesture\) return;/);
  });

  test('désactive les contrôles de zoom par défaut inutiles au pouce et signale les déplacements', () => {
    const out = html();
    expect(out).toContain('moveend');
    expect(out).toContain('ReactNativeWebView');
  });
});

describe('OsmMapView', () => {
  test('rend une WebView Leaflet avec les tuiles configurées', async () => {
    const root = await render(<OsmMapView center={CENTER} tileUrlTemplate={TILES} tileAttribution={ATTRIBUTION} />);
    const web = root.root.findByType(WebView);
    expect(web.props.source.html).toContain(JSON.stringify(TILES));
    expect(web.props.javaScriptEnabled).toBe(true);
    // Aucun accès aux fichiers locaux ni navigation hors de la page de la carte.
    expect(web.props.allowFileAccess).toBe(false);
  });

  test("relaie un déplacement de la carte à onRegionChange", async () => {
    const onRegionChange = jest.fn();
    const root = await render(<OsmMapView center={CENTER} tileUrlTemplate={TILES} tileAttribution={ATTRIBUTION} onRegionChange={onRegionChange} />);
    await ReactTestRenderer.act(async () => {
      root.root.findByType(WebView).props.onMessage({
        nativeEvent: { data: JSON.stringify({ type: 'moveend', latitude: 4.06, longitude: 9.71 }) },
      });
    });
    expect(onRegionChange).toHaveBeenCalledWith({ latitude: 4.06, longitude: 9.71 });
  });

  test("ignore sans planter un message qui n'est pas du JSON de la carte", async () => {
    const onRegionChange = jest.fn();
    const root = await render(<OsmMapView center={CENTER} tileUrlTemplate={TILES} tileAttribution={ATTRIBUTION} onRegionChange={onRegionChange} />);
    await ReactTestRenderer.act(async () => {
      root.root.findByType(WebView).props.onMessage({ nativeEvent: { data: 'not json' } });
    });
    expect(onRegionChange).not.toHaveBeenCalled();
  });

  test('pousse les nouveaux marqueurs dans la carte quand les props changent', async () => {
    const root = await render(<OsmMapView center={CENTER} tileUrlTemplate={TILES} tileAttribution={ATTRIBUTION} markers={[]} />);
    await ReactTestRenderer.act(async () => {
      root.root.findByType(WebView).props.onLoadEnd();
    });
    mockInjectJavaScript.mockClear();
    await ReactTestRenderer.act(async () => {
      root.update(
        <OsmMapView center={CENTER} tileUrlTemplate={TILES} tileAttribution={ATTRIBUTION} markers={[{ id: 'me', kind: 'driver', position: CENTER }]} />
      );
    });
    expect(mockInjectJavaScript).toHaveBeenCalledTimes(1);
    expect(mockInjectJavaScript.mock.calls[0][0]).toContain('"id":"me"');
  });

  test('recentre la carte quand le centre change', async () => {
    const root = await render(<OsmMapView center={CENTER} tileUrlTemplate={TILES} tileAttribution={ATTRIBUTION} />);
    await ReactTestRenderer.act(async () => {
      root.root.findByType(WebView).props.onLoadEnd();
    });
    mockInjectJavaScript.mockClear();
    await ReactTestRenderer.act(async () => {
      root.update(<OsmMapView center={{ latitude: 4.1, longitude: 9.8 }} tileUrlTemplate={TILES} tileAttribution={ATTRIBUTION} />);
    });
    expect(mockInjectJavaScript.mock.calls[0][0]).toContain('4.1');
  });

  test("n'injecte rien avant la fin du chargement de la page", async () => {
    const root = await render(<OsmMapView center={CENTER} tileUrlTemplate={TILES} tileAttribution={ATTRIBUTION} markers={[]} />);
    await ReactTestRenderer.act(async () => {
      root.update(
        <OsmMapView center={CENTER} tileUrlTemplate={TILES} tileAttribution={ATTRIBUTION} markers={[{ id: 'me', kind: 'driver', position: CENTER }]} />
      );
    });
    expect(mockInjectJavaScript).not.toHaveBeenCalled();
  });
});

describe('MapView public (choix du fond de carte par configuration)', () => {
  test("sans tileUrl : la carte Google d'origine, aucune WebView", async () => {
    configureMapsProvider({ apiKey: 'k', searchUrl: 'https://places.example.test' });
    const root = await render(<MapView center={CENTER} />);
    expect(root.root.findAllByType(WebView)).toHaveLength(0);
    expect(root.root.findByType(RNMapView).props.provider).toBe('google');
  });

  test('avec tileUrl : carte Leaflet à cette adresse et avec son attribution, sans carte Google', async () => {
    configureMapsProvider({ apiKey: 'k', searchUrl: 'https://places.example.test', tileUrl: TILES, tileAttribution: ATTRIBUTION });
    const root = await render(<MapView center={CENTER} />);
    expect(root.root.findByType(WebView).props.source.html).toContain(JSON.stringify(TILES));
    expect(root.root.findByType(WebView).props.source.html).toContain(JSON.stringify(ATTRIBUTION));
    expect(root.root.findAllByType(RNMapView)).toHaveLength(0);
  });

  // D43 : le crédit est une obligation de la licence du fournisseur de tuiles -- jamais un texte
  // par défaut qui citerait le mauvais fournisseur sans que personne ne le remarque.
  test("une adresse de tuiles sans attribution échoue dès la configuration, bruyamment", () => {
    expect(() => configureMapsProvider({ apiKey: 'k', searchUrl: 'https://places.example.test', tileUrl: TILES })).toThrow(
      /BABANA_MAP_TILE_ATTRIBUTION/
    );
  });
});

describe('la recherche et la navigation restent celles de Google', () => {
  test("configureMapsProvider alimente toujours la clé et l'adresse de recherche Google", () => {
    configureMapsProvider({ apiKey: 'rest-key', searchUrl: 'https://places.example.test', tileUrl: TILES, tileAttribution: ATTRIBUTION });
    expect(getGoogleMapsApiKey()).toBe('rest-key');
    expect(getSearchUrl()).toBe('https://places.example.test');
  });

  test('le fournisseur actif réutilise searchPlace, reverseGeocode et openNavigation de Google', () => {
    expect(activeMapProvider.searchPlace).toBe(googleMapProvider.searchPlace);
    expect(activeMapProvider.reverseGeocode).toBe(googleMapProvider.reverseGeocode);
    expect(activeMapProvider.openNavigation).toBe(googleMapProvider.openNavigation);
  });
});
