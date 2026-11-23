import { getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

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

/**
 * Guess the user's region from the most common calling code among E.164 handles. Counts by calling code
 * (not by validity), so numbers libphonenumber rejects still vote. Returns undefined if unknown.
 */
export function inferDefaultRegion(handles: Iterable<string>): Region | undefined {
  const counts = new Map<string, { n: number; country?: Region }>();
  for (const h of handles) {
    if (!h || !h.startsWith('+')) continue;
    const p = parsePhoneNumberFromString(h);
    const cc = p?.countryCallingCode;
    if (!cc) continue;
    const e = counts.get(cc) ?? { n: 0 };
    e.n++;
    e.country ??= p?.country;
    counts.set(cc, e);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [cc, e] of counts) if (e.n > bestN) { best = cc; bestN = e.n; }
  if (!best) return undefined;
  const hit = counts.get(best)!;
  if (hit.country) return hit.country;
  if (best === '1') return 'US';
  return getCountries().find((c) => getCountryCallingCode(c) === best);
}
