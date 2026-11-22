// Display helpers for counterparties (design.md §17: plain, short, specific).
// Bank statements shout ("SBI CARDS AND PAYMENT SER", "SPOTIFY INDIA MUMBAI IN",
// "Swiggy (UPI)"). These turn them into names a person would say. Display
// only: filters and rules always use the original value.

const ACRONYMS = new Set([
  "SBI", "ATM", "HDFC", "ICICI", "UPI", "NEFT", "IMPS", "RTGS", "BMRCL", "BESCOM", "EMI",
  "PVR", "KFC", "LIC", "IRCTC", "NACH", "MF", "SIP", "CRED", "BBMP", "IDFC", "HPCL", "BPCL",
  "IOCL", "BSNL", "ACT", "DTH", "GST", "POS", "LPG", "PNB", "BOB", "AU", "RBL",
]);
const SMALL = new Set(["and", "of", "the", "for", "to", "in", "on", "at", "by"]);
const CITIES = "mumbai|bangalore|bengaluru|delhi|new delhi|gurgaon|gurugram|noida|pune|chennai|hyderabad|kolkata";

function titleWord(w: string, i: number): string {
  if (!/[A-Za-z]/.test(w) || /\d/.test(w)) return w;
  const up = w.toUpperCase();
  if (ACRONYMS.has(up.replace(/[^A-Z]/g, ""))) return up;
  const low = w.toLowerCase();
  if (i > 0 && SMALL.has(low)) return low;
  return low.charAt(0).toUpperCase() + low.slice(1);
}

/** "SPOTIFY INDIA MUMBAI IN" → "Spotify", "Swiggy (UPI)" → "Swiggy". */
export function cleanName(raw: string | null | undefined): string {
  let n = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!n) return "";
  n = n
    .replace(/\s*\((upi|pos|neft|imps|ach)\)\s*$/i, "")
    .replace(new RegExp(`\\s+(${CITIES})(\\s+in)?$`, "i"), "")
    .replace(/\s+(private limited|pvt\.? ltd\.?|pvt|limited|ltd\.?)$/i, "")
    .replace(/\s+(private limited|pvt\.? ltd\.?|pvt|limited|ltd\.?)$/i, "")
    .replace(/\s+india$/i, "")
    .trim();
  if (!n) n = (raw ?? "").trim();
  // Only re-case names the bank printed in capitals; leave mixed case alone.
  if (n === n.toUpperCase() && /[A-Z]{2}/.test(n)) {
    n = n.split(" ").map(titleWord).join(" ");
  }
  return n;
}

/** The name a ledger row leads with. */
export function txnName(t: { merchant_name?: string | null; description: string }): string {
  return cleanName(t.merchant_name) || cleanName(t.description) || "Unknown";
}

/** First letter for an avatar. */
export function initial(name: string): string {
  const m = /[A-Za-z0-9]/.exec(name);
  return m ? m[0].toUpperCase() : "?";
}
