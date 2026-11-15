import { useEffect } from 'react';
import { setScreenAwake } from './screenWake';

/**
 * L'écran ne s'éteint pas tant qu'un écran carte est ouvert (décision du 14 novembre) : le client
 * suit sa moto, la cherche des yeux, et ne doit pas avoir à déverrouiller son téléphone pour la
 * voir arriver. La différence de plateforme vit dans `screenWake(.web).ts`, jamais dans un écran.
 *
 * Compté, pas booléen : pendant une transition entre deux écrans carte, l'un prend le focus
 * avant que l'autre ne le rende -- un simple « allumé/éteint » éteindrait l'écran au mauvais
 * moment.
 */
let holders = 0;

export function holdScreenAwake(): () => void {
  holders += 1;
  if (holders === 1) setScreenAwake(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0) setScreenAwake(false);
  };
}

/** Ce que le hook lit de la navigation de l'écran (le `navigation` de ses props). */
export interface FocusSource {
  isFocused(): boolean;
  addListener(event: 'focus' | 'blur', callback: () => void): () => void;
}

/**
 * À appeler dans chaque écran qui affiche la carte : l'écran reste allumé tant qu'il a le focus
 * -- pas seulement tant qu'il est monté : l'accueil reste monté sous « Mon profil » ou
 * l'historique, qui n'ont pas de carte.
 */
export function useKeepScreenAwake(navigation: FocusSource): void {
  useEffect(() => {
    let release: (() => void) | null = null;
    const hold = () => {
      if (!release) release = holdScreenAwake();
    };
    const drop = () => {
      release?.();
      release = null;
    };
    if (navigation.isFocused()) hold();
    const unsubscribeFocus = navigation.addListener('focus', hold);
    const unsubscribeBlur = navigation.addListener('blur', drop);
    return () => {
      unsubscribeFocus();
      unsubscribeBlur();
      drop();
    };
  }, [navigation]);
}
