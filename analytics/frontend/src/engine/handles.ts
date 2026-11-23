// Handle normalization: international-aware E.164 for phone numbers, lowercase for emails.
export interface NormalizeOptions {
  /** Country calling code (digits only) assumed for national-format numbers. Default "1". */
  defaultCountryCode?: string;
}

export function normalizeHandle(raw: string, opts: NormalizeOptions = {}): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (s.includes("@")) return s.toLowerCase();
  const cc = opts.defaultCountryCode ?? "1";
  const hasPlus = s.startsWith("+");
  let digits = s.replace(/\D/g, "");
  if (!digits) return s.toLowerCase(); // business ids with no digits
  if (hasPlus) return "+" + digits;
  if (digits.startsWith("00")) return "+" + digits.slice(2); // international dialing prefix
  if (digits.length <= 6) return digits; // short code, leave as is
  if (cc === "1") {
    if (digits.length === 10) return "+1" + digits;
    if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  }
  digits = digits.replace(/^0+/, ""); // national trunk prefix
  if (digits.startsWith(cc) && digits.length > 10) return "+" + digits;
  return "+" + cc + digits;
}
