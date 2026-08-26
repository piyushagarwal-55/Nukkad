/** Hinglish quantity words that show up in real rashan orders. */
export const QUANTITY_WORDS: Record<string, number> = {
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, panch: 5, paanch: 5,
  chah: 6, cheh: 6, saat: 7, aath: 8, nau: 9, das: 10, dus: 10,
  gyarah: 11, barah: 12, pandrah: 15, bees: 20, pachees: 25, tees: 30,
  adha: 0.5, aadha: 0.5, dedh: 1.5, derh: 1.5, dhai: 2.5, sava: 1.25,
};

export const UNIT_ALIASES: Record<string, string> = {
  kilo: 'kg', kg: 'kg', kilogram: 'kg', kilos: 'kg',
  gram: 'g', g: 'g', gm: 'g', grams: 'g',
  litre: 'l', liter: 'l', l: 'l', ltr: 'l',
  ml: 'ml', packet: 'pkt', pkt: 'pkt', pack: 'pkt',
  dozen: 'dz', darjan: 'dz', dz: 'dz',
  piece: 'pc', pc: 'pc', pcs: 'pc', nag: 'pc',
  bottle: 'btl', botal: 'btl',
};
