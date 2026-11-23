import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

export type Region = CountryCode;
export const DEFAULT_REGION: Region = 'US';

/**
 * Normalize an iMessage / AddressBook handle.
 * - emails: trimmed + lowercased
 * - phones: E.164 (e.g. +14155551234), international aware
 * - anything else (short codes, junk): digits only, or lowercased trimmed text if no digits
 */
export function normalizeHandle(raw: string, defaultRegion: Region = DEFAULT_REGION): string {
  let s = (raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/^(mailto|tel|sms):/i, '').trim();
  if (s.includes('@')) return s.toLowerCase();
  if (!/^[+\d\s().\-]+$/.test(s)) return s.toLowerCase(); // not phone-shaped (business ids etc.)

  const parsed = parsePhoneNumberFromString(s, defaultRegion);
  if (parsed && parsed.isValid()) return parsed.number;

  const digits = s.replace(/\D/g, '');
  if (!digits) return s.toLowerCase();
  if (s.startsWith('+')) return `+${digits}`;
  if (s.startsWith('00') && digits.length > 4) return `+${digits.slice(2)}`;
  // Lenient NANP fallbacks for numbers libphonenumber rejects (e.g. fake 555 exchanges)
  if (defaultRegion === 'US' || defaultRegion === 'CA') {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  }
  return digits;
}

/** Guess the user's region from the most common calling country among E.164 handles. Returns undefined if unknown. */
export function inferDefaultRegion(handles: Iterable<string>): Region | undefined {
  const counts = new Map<string, number>();
  for (const h of handles) {
    if (!h || !h.startsWith('+')) continue;
    const country = parsePhoneNumberFromString(h)?.country;
    if (country) counts.set(country, (counts.get(country) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [c, n] of counts) if (n > bestN) { best = c; bestN = n; }
  return best as Region | undefined;
}
