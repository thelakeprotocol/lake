import type { ShopExample } from '@thelakeprotocol/core';

/**
 * Three invented shops that answer wants (SPEC §6.8): someone's AI says what they're looking for, from a photo, and each
 * shop offers its closest item, at its price, with its delivery. Names, items and prices are made up.
 */
const SHOWER = (sku: string, label: string, price: number, props: Record<string, string>) => ({ sku, label, price, props, keywords: ['shower', 'head', 'rose', 'bathroom'] });

export const SHOPS: ShopExample[] = [
  {
    name: 'Puddle Lane Bathrooms (demo)', domain: 'puddlelane.lake.local', currency: 'AUD', regions: ['AU'], delivery: { days: 3, fee: 9.95 },
    description: 'Bathroom fittings, cheap and cheerful. A demo shop: it answers wants on the Lake from a made-up catalogue.',
    items: [
      SHOWER('pl-hand-3', 'Handheld shower head, 3 spray modes, chrome', 24.9, { Type: 'Handheld', 'Spray modes': '3', Finish: 'Chrome', Connection: '1/2 inch BSP', 'Face diameter': '100 mm', Material: 'ABS plastic' }),
      SHOWER('pl-hand-5', 'Handheld shower head, 5 spray modes, matte black', 32.0, { Type: 'Handheld', 'Spray modes': '5', Finish: 'Matte black', Connection: '1/2 inch BSP', 'Face diameter': '110 mm', Material: 'ABS plastic' }),
      SHOWER('pl-fixed-200', 'Fixed rain shower head, 200 mm, chrome', 39.0, { Type: 'Fixed', 'Spray modes': '1', Finish: 'Chrome', Connection: '1/2 inch BSP', 'Face diameter': '200 mm', Material: 'Stainless steel' }),
      { sku: 'pl-hose-15', label: 'Shower hose, 1.5 m, stainless', price: 14.5, props: { Length: '1.5 m', Connection: '1/2 inch BSP', Finish: 'Chrome' }, keywords: ['hose', 'shower'] },
      { sku: 'pl-washers', label: 'Tap washer kit, 30 pieces', price: 6.95, props: { Pieces: '30' }, keywords: ['tap', 'washer', 'leak', 'drip'] },
    ],
  },
  {
    name: 'Washer & Wrench (demo)', domain: 'washerwrench.lake.local', currency: 'AUD', regions: ['AU'], delivery: { days: 2, fee: 0 },
    description: 'Plumbing and hardware, free delivery. A demo shop: it answers wants on the Lake from a made-up catalogue.',
    items: [
      SHOWER('ww-hand-3', 'Handheld shower head, 3 sprays, chrome, water saving', 34.0, { Type: 'Handheld', 'Spray modes': '3', Finish: 'Chrome', Connection: '1/2 inch BSP', 'Face diameter': '100 mm', 'Flow rate': '7.5 L/min', Material: 'Brass' }),
      SHOWER('ww-hand-1', 'Handheld shower head, single spray, chrome', 19.0, { Type: 'Handheld', 'Spray modes': '1', Finish: 'Chrome', Connection: '1/2 inch BSP', 'Face diameter': '80 mm', Material: 'ABS plastic' }),
      SHOWER('ww-fixed-250', 'Fixed rain shower head, 250 mm, brushed nickel', 69.0, { Type: 'Fixed', 'Spray modes': '1', Finish: 'Brushed nickel', Connection: '1/2 inch BSP', 'Face diameter': '250 mm', Material: 'Stainless steel' }),
      { sku: 'ww-bulb-e27', label: 'LED light bulb, E27, warm white, 4 pack', price: 12.0, props: { Base: 'E27', Colour: 'Warm white', Pack: '4' }, keywords: ['bulb', 'light', 'led', 'lamp'] },
      { sku: 'ww-seat', label: 'Toilet seat, soft close, white', price: 45.0, props: { Colour: 'White', Close: 'Soft close' }, keywords: ['toilet', 'seat'] },
    ],
  },
  {
    name: 'Brightwater Home (demo)', domain: 'brightwater.lake.local', currency: 'AUD', regions: ['AU'], delivery: { days: 1, fee: 12.0 },
    description: 'Better fittings, next-day delivery. A demo shop: it answers wants on the Lake from a made-up catalogue.',
    items: [
      SHOWER('bw-hand-3', 'Handheld shower head, 3 spray modes, polished chrome, metal', 49.0, { Type: 'Handheld', 'Spray modes': '3', Finish: 'Chrome', Connection: '1/2 inch BSP', 'Face diameter': '105 mm', Material: 'Brass', 'Flow rate': '9 L/min' }),
      SHOWER('bw-hand-6', 'Handheld shower head, 6 spray modes, chrome, with hose', 59.0, { Type: 'Handheld', 'Spray modes': '6', Finish: 'Chrome', Connection: '1/2 inch BSP', 'Face diameter': '120 mm', Material: 'Brass' }),
      { sku: 'bw-mixer', label: 'Basin mixer tap, chrome', price: 89.0, props: { Finish: 'Chrome', Type: 'Mixer' }, keywords: ['tap', 'basin', 'mixer', 'faucet'] },
      { sku: 'bw-bulb-b22', label: 'LED light bulb, B22, daylight, 4 pack', price: 16.0, props: { Base: 'B22', Colour: 'Daylight', Pack: '4' }, keywords: ['bulb', 'light', 'led', 'lamp'] },
    ],
  },
];
