// Points de prise en charge propres à chaque scénario : la course part au chauffeur disponible le
// plus proche, dans un rayon réduit pendant les tests (../../support/dispatch-radius.ts). Chaque
// scénario pose son chauffeur à son point, à ~110 m du suivant -- hors de portée de tout autre
// chauffeur resté en ligne. Chaque fichier part de sa propre base, à plus d'un kilomètre de celles
// des autres fichiers, lancés en parallèle.

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** Renvoie une fonction qui donne, à chaque appel, un nouveau point à ~110 m à l'ouest du précédent. */
export function spotSequence(base: LatLng): () => LatLng {
  let index = 0;
  return () => {
    index += 1;
    return { latitude: base.latitude, longitude: Number((base.longitude - index * 0.001).toFixed(6)) };
  };
}
