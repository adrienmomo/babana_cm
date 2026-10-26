import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import type { MapViewProps } from '../../types';
import { buildLeafletHtml, updateScript } from './leafletHtml';

/**
 * Carte Leaflet / OpenStreetMap dans une WebView -- aucun SDK Google Maps, donc aucune clé pour la
 * carte elle-même. Même contrat que `GoogleMapView` (`MapViewProps`) : aucun écran ne change. La
 * recherche de lieu et la navigation restent celles du fournisseur Google (`activeProvider.ts`).
 *
 * Importe `react-native-webview` : autorisé par le lint sous `providers/` uniquement.
 *
 * La page n'est chargée qu'une fois (`source.html` figé au premier rendu, `useMemo` sans
 * dépendance) : ce sont les mises à jour de props qui sont injectées ensuite -- recharger la page à
 * chaque position du chauffeur referait télécharger Leaflet et les tuiles sur un forfait compté.
 */
export interface OsmMapViewProps extends MapViewProps {
  tileUrlTemplate: string;
  tileAttribution: string;
}

export function OsmMapView({ center, markers = [], route, onRegionChange, style, tileUrlTemplate, tileAttribution }: OsmMapViewProps) {
  const webViewRef = useRef<{ injectJavaScript: (script: string) => void } | null>(null);
  const loaded = useRef(false);

  // Figé au premier rendu, volontairement.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const html = useMemo(() => buildLeafletHtml({ tileUrlTemplate, tileAttribution, center, markers, route }), []);

  const push = useCallback(() => {
    if (!loaded.current) return;
    webViewRef.current?.injectJavaScript(updateScript({ center, markers, route }));
  }, [center, markers, route]);

  // Premier rendu : la page porte déjà l'état initial. Ensuite, chaque changement est poussé.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    push();
  }, [push]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: { type?: string; latitude?: number; longitude?: number };
      try {
        message = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      if (message.type === 'moveend' && typeof message.latitude === 'number' && typeof message.longitude === 'number') {
        onRegionChange?.({ latitude: message.latitude, longitude: message.longitude });
      }
    },
    [onRegionChange]
  );

  return (
    <View style={[styles.fill, style]}>
      <WebView
        ref={(instance) => {
          webViewRef.current = instance;
        }}
        originWhitelist={['https://*', 'about:*']}
        source={{ html, baseUrl: 'https://localhost/' }}
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false}
        onLoadEnd={() => {
          loaded.current = true;
          push();
        }}
        onMessage={onMessage}
        style={styles.fill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
