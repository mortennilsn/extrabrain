// pii-scrub.js — strip personal identifiable information before saving to brain
//
// Handles common PII patterns:
//   - Email addresses
//   - Phone numbers (international formats)
//   - Credit card numbers
//   - Social security / national ID numbers (common formats)

const REDACTED = "[REDACTED]";

const PATTERNS = [
  // Email addresses
  { re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, label: "email" },

  // Phone numbers — international format +XX XXXXXXXXXX or (XXX) XXX-XXXX
  { re: /\+\d{1,3}[\s\-]?\d{6,14}/g, label: "phone" },
  { re: /\(\d{3}\)[\s\-]?\d{3}[\s\-]?\d{4}/g, label: "phone" },

  // Credit card numbers (4 groups of 4 digits)
  { re: /\b\d{4}[\s\-]\d{4}[\s\-]\d{4}[\s\-]\d{4}\b/g, label: "card" },

  // Social Security / national ID — 9-11 digit sequences common in ID numbers
  { re: /\b\d{3}[\s\-]\d{2}[\s\-]\d{4}\b/g, label: "ssn" },
];

/**
 * Scrub PII from a string. Returns { text, redactions } where redactions
 * is a count of replacements made per label.
 */
export function scrubPII(text) {
  if (!text || typeof text !== "string") return { text, redactions: {} };

  let result = text;
  const redactions = {};

  for (const { re, label } of PATTERNS) {
    const matches = result.match(re);
    if (matches) {
      redactions[label] = (redactions[label] || 0) + matches.length;
      result = result.replace(re, REDACTED);
    }
  }

  return { text: result, redactions };
}

/**
 * Scrub an object's string fields recursively.
 * Safe to call on arbitrary JSON from external APIs.
 */
export function scrubObject(obj, fieldsToScrub = ["notes", "text", "description"]) {
  if (!obj || typeof obj !== "object") return { obj, totalRedactions: 0 };

  let totalRedactions = 0;
  const result = Array.isArray(obj) ? [...obj] : { ...obj };

  for (const key of Object.keys(result)) {
    if (typeof result[key] === "string" && fieldsToScrub.includes(key)) {
      const { text, redactions } = scrubPII(result[key]);
      result[key] = text;
      totalRedactions += Object.values(redactions).reduce((a, b) => a + b, 0);
    } else if (typeof result[key] === "object" && result[key] !== null) {
      const { obj: nested, totalRedactions: n } = scrubObject(result[key], fieldsToScrub);
      result[key] = nested;
      totalRedactions += n;
    }
  }

  return { obj: result, totalRedactions };
}
