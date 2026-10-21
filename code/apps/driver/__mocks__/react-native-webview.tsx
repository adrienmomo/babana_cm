import React, { forwardRef, useImperativeHandle } from 'react';
import { View } from 'react-native';

/**
 * Double de test pour `react-native-webview` : un `View` qui garde ses props (le test lit `source`,
 * `onMessage`...) et expose `injectJavaScript` sous forme de `jest.fn()` partagé -- c'est par ce
 * canal que l'app pilote la carte Leaflet après le premier rendu.
 */
export const mockInjectJavaScript = jest.fn();

const MockWebView = forwardRef<{ injectJavaScript: (code: string) => void }, { testID?: string }>(
  function MockWebViewImpl({ testID }, ref) {
    useImperativeHandle(ref, () => ({ injectJavaScript: mockInjectJavaScript }));
    return <View testID={testID ?? 'mock-webview'} />;
  }
);

export const WebView = MockWebView;
export default MockWebView;
