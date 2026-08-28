import React from 'react';
import { Linking } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CallButton } from '../CallButton';

describe('CallButton (D42)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('absent, jamais inerte -- rien ne s\'affiche quand phoneNumber est null (D30)', async () => {
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<CallButton phoneNumber={null} />);
    });
    expect(root.root.findAllByProps({ testID: 'call-button' })).toHaveLength(0);
  });

  test('un appui compose le numéro du chauffeur', async () => {
    jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<CallButton phoneNumber="+237691234567" />);
    });

    await act(async () => {
      root.root.findByProps({ testID: 'call-button' }).props.onPress();
    });

    expect(Linking.openURL).toHaveBeenCalledWith('tel:+237691234567');
  });
});
