// Get a query embedding — tries the local daemon first, falls back to direct Xenova load
// This avoids the 2-3s model cold-start when the embedder daemon is running.

import { pipeline } from "@xenova/transformers";

const DAEMON_URL = "http://localhost:7071/embed";
const MODEL      = "Xenova/all-mpnet-base-v2";

let _localEmbedder = null;

async function tryDaemon(text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 500); // fast timeout — daemon is local
  try {
    const res = await fetch(DAEMON_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const { vector } = await res.json();
    return vector;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function localEmbed(text) {
  if (!_localEmbedder) {
    process.stderr.write("🔄 Loading embedding model... ");
    _localEmbedder = await pipeline("feature-extraction", MODEL);
    process.stderr.write("ready\n\n");
  }
  const output = await _localEmbedder(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

/**
 * Embed a query string.
 * Uses the local daemon if running (instant), otherwise loads Xenova directly.
 */
export async function embedQuery(text) {
  const vec = await tryDaemon(text);
  if (vec) return vec;
  return localEmbed(text);
}
