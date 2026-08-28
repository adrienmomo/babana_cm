import React from 'react';
import { Linking } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CallButton } from '../CallButton';

describe('CallButton (D42, côté chauffeur)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('absent, jamais inerte -- rien ne s\'affiche quand clientPhoneNumber est null (D30)', async () => {
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<CallButton clientPhoneNumber={null} />);
    });
    expect(root.root.findAllByProps({ testID: 'call-client-button' })).toHaveLength(0);
  });

  test('un appui compose le numéro du client', async () => {
    jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(<CallButton clientPhoneNumber="+237691234567" />);
    });

    await act(async () => {
      root.root.findByProps({ testID: 'call-client-button' }).props.onPress();
    });

    expect(Linking.openURL).toHaveBeenCalledWith('tel:+237691234567');
  });
});
