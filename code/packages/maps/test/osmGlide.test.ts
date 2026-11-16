import vm from 'node:vm';
import { buildLeafletHtml } from '../src/providers/osm/leafletHtml';

// 14 novembre : la moto glisse d'une position à la suivante au lieu de sauter. Le script de la
// page est exécuté tel quel, contre une imitation minimale de Leaflet et une horloge pilotée.

type Point = { lat: number; lng: number };

function runPage() {
  let clock = 0;
  const frames: Array<() => void> = [];
  const markers: Array<{ latlng: Point; removed: boolean; style: { transform?: string } }> = [];
  const pans: Array<{ to: [number, number]; options: { duration: number } }> = [];
  const setViews: Array<[number, number]> = [];

  const toPoint = (at: [number, number]) => ({ lat: at[0], lng: at[1] });
  const L = {
    map: () => {
      const map = {
        setView: (at: [number, number]) => {
          setViews.push(at);
          return map;
        },
        attributionControl: { setPrefix: () => undefined },
        getContainer: () => ({ addEventListener: () => undefined }),
        on: () => undefined,
        getZoom: () => 15,
        getCenter: () => ({ lat: 0, lng: 0 }),
        panTo: (to: [number, number], options: { duration: number }) => pans.push({ to, options }),
        fitBounds: () => undefined,
      };
      return map;
    },
    tileLayer: () => ({ addTo: () => undefined }),
    layerGroup: () => {
      const group = {
        addTo: () => group,
        clearLayers: () => undefined,
        removeLayer: (marker: { record: { removed: boolean } }) => {
          marker.record.removed = true;
        },
      };
      return group;
    },
    divIcon: (options: unknown) => options,
    polyline: () => ({ addTo: () => ({ getBounds: () => undefined }) }),
    marker: (at: [number, number]) => {
      const record = { latlng: toPoint(at), removed: false, style: {} as { transform?: string } };
      markers.push(record);
      const marker = {
        record,
        setLatLng: (next: [number, number]) => {
          record.latlng = toPoint(next);
        },
        getLatLng: () => record.latlng,
        bindTooltip: () => undefined,
        unbindTooltip: () => undefined,
        addTo: () => marker,
        getElement: () => ({ querySelector: () => ({ style: record.style }) }),
      };
      return marker;
    },
  };
  const window: Record<string, unknown> = {
    performance: { now: () => clock },
    requestAnimationFrame: (f: () => void) => frames.push(f),
  };

  const html = buildLeafletHtml({
    tileUrlTemplate: 'https://tiles.example.test/{z}/{x}/{y}.png',
    tileAttribution: '© Test',
    center: { latitude: 4.05, longitude: 9.7 },
    markers: [],
  });
  const script = html.split('<script>\n')[1]!.split('</script>')[0]!;
  const document = { documentElement: { className: '' } };
  vm.runInNewContext(script, { window, document, L, Date, Math, JSON, setTimeout });

  const babana = window.babana as { update: (state: unknown) => void };
  const update = (at: { latitude: number; longitude: number }) =>
    babana.update({ center: at, markers: [{ id: 'driver', kind: 'driver', position: at }], colors: { driver: '#1A9E5C' } });
  const runFrames = () => {
    const pending = frames.splice(0);
    pending.forEach((frame) => frame());
  };
  return {
    update,
    runFrames,
    advance: (ms: number) => {
      clock += ms;
    },
    markers,
    pans,
    setViews,
    remove: () => babana.update({ center: { latitude: 4.05, longitude: 9.7 }, markers: [], colors: {} }),
    document,
    updateState: (state: Record<string, unknown>) => babana.update(state),
  };
}

test('la moto glisse vers sa nouvelle position, sur la durée écoulée depuis la précédente', () => {
  const page = runPage();
  page.update({ latitude: 4.05, longitude: 9.7 });
  expect(page.markers).toHaveLength(1);

  page.advance(3_000);
  page.update({ latitude: 4.051, longitude: 9.701 });
  expect(page.markers).toHaveLength(1); // le même repère, jamais redessiné

  page.advance(1_500);
  page.runFrames();
  expect(page.markers[0]!.latlng.lat).toBeCloseTo(4.0505, 6);
  expect(page.markers[0]!.latlng.lng).toBeCloseTo(9.7005, 6);

  page.advance(1_500);
  page.runFrames();
  expect(page.markers[0]!.latlng).toEqual({ lat: 4.051, lng: 9.701 });
});

test('la carte qui suit la moto glisse avec elle, au même rythme', () => {
  const page = runPage();
  page.update({ latitude: 4.05, longitude: 9.7 });
  page.advance(3_000);
  page.update({ latitude: 4.051, longitude: 9.701 });
  expect(page.pans).toHaveLength(1);
  expect(page.pans[0]!.options.duration).toBeCloseTo(3, 3);
});

test('une position plus récente reprend la main depuis l’endroit où la moto se trouve', () => {
  const page = runPage();
  page.update({ latitude: 4.05, longitude: 9.7 });
  page.advance(3_000);
  page.update({ latitude: 4.051, longitude: 9.7 });
  page.advance(1_500);
  page.runFrames(); // à mi-chemin : 4.0505

  page.update({ latitude: 4.052, longitude: 9.7 });
  page.advance(750);
  page.runFrames();
  // Nouveau glissement de 4.0505 vers 4.052 sur 1,5 s : à mi-durée, 4.05125.
  expect(page.markers[0]!.latlng.lat).toBeCloseTo(4.05125, 6);
});

test('au-delà d’environ 500 m (reprise après coupure), la moto saute au lieu de traverser la ville', () => {
  const page = runPage();
  page.update({ latitude: 4.05, longitude: 9.7 });
  page.advance(3_000);
  page.update({ latitude: 4.07, longitude: 9.7 });
  expect(page.markers[0]!.latlng).toEqual({ lat: 4.07, lng: 9.7 });
});

test('une moto qui disparaît des repères est retirée de la carte', () => {
  const page = runPage();
  page.update({ latitude: 4.05, longitude: 9.7 });
  page.remove();
  expect(page.markers[0]!.removed).toBe(true);
});

test('15 novembre : thème sombre ou noir de l’app, la page assombrit ses tuiles (classe sur la racine)', () => {
  const page = runPage();
  const at = { latitude: 4.05, longitude: 9.7 };
  page.updateState({ center: at, markers: [], colors: {}, appearance: 'dark' });
  expect(page.document.documentElement.className).toBe('appearance-dark');
  page.updateState({ center: at, markers: [], colors: {}, appearance: 'black' });
  expect(page.document.documentElement.className).toBe('appearance-black');
  page.updateState({ center: at, markers: [], colors: {} });
  expect(page.document.documentElement.className).toBe('appearance-light');
});

test('la feuille de style de la page porte les filtres sombre et noir', () => {
  const html = buildLeafletHtml({ tileUrlTemplate: 'https://t/{z}/{x}/{y}.png', tileAttribution: '©', center: { latitude: 4, longitude: 9 }, markers: [] });
  expect(html).toContain('html.appearance-dark .leaflet-tile-pane{filter:invert(1)');
  expect(html).toContain('html.appearance-black .leaflet-tile-pane{filter:invert(1)');
});
