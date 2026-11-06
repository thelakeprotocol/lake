/**
 * Existing home loans and the "loyalty tax": Australian banks have charged borrowers who stay well above what they
 * offer new customers for the same loan (the ACCC's home loan price inquiry found the gap grew with the loan's age).
 * Four fictional incumbent banks, each with its advertised rate for new customers by loan-to-value; a borrower's own
 * rate is that plus whatever their bank has stopped passing on to them. Synthetic only.
 */
export interface Incumbent { name: string; newRates: [number, number][] }

export const INCUMBENTS: Record<string, Incumbent> = {
  harbour: { name: 'Harbour Bank', newRates: [[0.6, 5.64], [0.8, 5.79], [0.9, 6.09]] },
  granite: { name: 'Granite Bank', newRates: [[0.6, 5.69], [0.8, 5.84], [0.9, 6.14]] },
  lyrebird: { name: 'Lyrebird Bank', newRates: [[0.6, 5.59], [0.8, 5.74], [0.9, 6.04]] },
  magpie: { name: 'Magpie Bank', newRates: [[0.6, 5.74], [0.8, 5.89], [0.9, 6.19]] },
};

/** The rate a bank advertises to a new customer at this loan-to-value. */
export const newCustomerRate = (bank: string, lvr: number): number => {
  const rows = INCUMBENTS[bank]?.newRates ?? [];
  return (rows.find(([max]) => lvr <= max) ?? rows.at(-1) ?? [0, 0])[1];
};

/** How much more a year than a new customer would pay, in bands: what a secret count of a street's loans asks. */
export const OVERPAY_BANDS = ['under-1k', '1k-3k', '3k-6k', '6k-plus'] as const;
export const overpayBand = (aud: number): (typeof OVERPAY_BANDS)[number] => (aud < 1_000 ? 'under-1k' : aud < 3_000 ? '1k-3k' : aud < 6_000 ? '3k-6k' : '6k-plus');
/** Every bank and band, as one answer each: "harbour:3k-6k" (16 in all, as many as a secret count takes). */
export const LENDER_OVERPAY = Object.keys(INCUMBENTS).flatMap((b) => OVERPAY_BANDS.map((x) => `${b}:${x}`));
