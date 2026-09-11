/**
 * @file format.ts
 *
 * Exact BigInt monetary formatting for eCash (XEC) sats representation.
 *
 * Requirements:
 * - Integer part: sats / 100n
 * - Fraction part: sats % 100n
 * - Exactly two decimal digits (zero-padded)
 * - Zero usage of Number / floating point arithmetic
 * - Zero scientific notation
 * - Zero rounding
 * - Exact byte-semantic fidelity with canonical amountSats
 */

const POSITIVE_SATS_REGEX = /^[1-9][0-9]*$/;

/**
 * Formats a canonical amountSats string into an exact XEC string representation.
 *
 * @param amountSats Canonical non-empty decimal string representing positive integer satoshis.
 * @returns Formatted exact string "${whole}.${fraction} XEC"
 * @throws Error if amountSats does not conform to canonical positive sats regex.
 */
export function formatSatsToExactXEC(amountSats: string): string {
  if (!POSITIVE_SATS_REGEX.test(amountSats)) {
    throw new Error(`[formatSatsToExactXEC] Invalid canonical amountSats: "${amountSats}"`);
  }

  const sats = BigInt(amountSats);
  const whole = sats / 100n;
  const fraction = sats % 100n;
  const fractionStr = fraction.toString().padStart(2, "0");

  return `${whole.toString()}.${fractionStr} XEC`;
}
