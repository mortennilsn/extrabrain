// Auto-translate non-English queries to English before searching.
// Only fires when the query contains non-ASCII characters (not just guessing language).

import { complete } from "./ai.js";

const NON_ASCII = /[^\x00-\x7F]/;

/**
 * Returns { query, translated } where `query` is the search string to use
 * and `translated` is true if the query was changed.
 */
export async function translateQuery(query) {
  if (!NON_ASCII.test(query)) return { query, translated: false };

  try {
    const result = await complete(
      `Translate the following search query to English for searching a knowledge base. Return ONLY the English translation — no explanation, no quotes, nothing else. If it is already English, return it unchanged.\n\nQuery: ${query}`,
      { maxTokens: 64 }
    );
    if (result && result.trim() !== query) return { query: result.trim(), translated: true };
  } catch {}

  return { query, translated: false };
}
