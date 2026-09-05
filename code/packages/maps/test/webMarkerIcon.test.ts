import { colorFor, markerIconUrl } from '../src/providers/web/markerIcon';

describe('markerIcon (fournisseur web, L6-18)', () => {
  it('reprend exactement les couleurs du fournisseur natif, par catégorie', () => {
    expect(colorFor('driver')).toBe('#0A7D3D');
    expect(colorFor('client')).toBe('#1D4ED8');
    expect(colorFor('pickup')).toBe('#0A7D3D');
    expect(colorFor('dropoff')).toBe('#B91C1C');
    expect(colorFor('reticle')).toBe('#6B7280');
  });

  it('produit une donnée-URI SVG colorée par catégorie', () => {
    const url = markerIconUrl('dropoff');

    expect(url).toMatch(/^data:image\/svg\+xml;charset=UTF-8,/);
    expect(decodeURIComponent(url)).toContain('#B91C1C');
  });
});
