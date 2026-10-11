/**
 * Single source of truth for store/business information.
 * Used by every receipt, invoice, and print component in the system.
 * Update here once and it propagates everywhere.
 */
export const STORE_INFO = {
  name: "Pawesome Retreat Inc.",
  address: "Aldana Street, San Isidro\nVillage, Las Piñas City,\nPhilippines 1740",
  email: "pawesomeretreat24@gmail.com",
  phone: "(02) 8XXX-XXXX",
  tagline: "Professional Veterinary & Pet Hotel Services",
  vatRate: 0.12, // 12% VAT (VAT-inclusive pricing)
};

/**
 * Computes VAT-inclusive breakdown for a given total amount.
 * @param {number} total - The VAT-inclusive total
 * @returns {{ vatRate: number, vatAmount: number, subtotalExVat: number, total: number }}
 */
export function computeVatBreakdown(total) {
  const t = Number(total) || 0;
  const vatAmount = (t * STORE_INFO.vatRate) / (1 + STORE_INFO.vatRate);
  const subtotalExVat = t - vatAmount;
  return {
    vatRate: STORE_INFO.vatRate,
    vatAmount: Math.round(vatAmount * 100) / 100,
    subtotalExVat: Math.round(subtotalExVat * 100) / 100,
    total: t,
  };
}
