// Hybrid search — combines vector (semantic) + BM25 (keyword) scoring
// Exported and used by search.js, ask.js, brief.js, server/index.js

// ── Tokeniser ─────────────────────────────────────────────────────────────────

export function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9æøåéèêëàâùûüîïôœç\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

// ── BM25 meta (built over full index after each embed) ────────────────────────

export function buildBM25Meta(entries) {
  const df = {};
  let totalLen = 0;

  for (const entry of entries) {
    const tokens = new Set(tokenize(entry.text));
    totalLen += tokens.size;
    for (const token of tokens) {
      df[token] = (df[token] || 0) + 1;
    }
  }

  return { N: entries.length, avgdl: totalLen / (entries.length || 1), df };
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function bm25Score(queryTokens, docText, df, N, avgdl, k1 = 1.5, b = 0.75) {
  const tokens = tokenize(docText);
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  const dl = tokens.length;

  let score = 0;
  for (const term of queryTokens) {
    const dfTerm = df[term];
    if (!dfTerm) continue;
    const idf = Math.log((N - dfTerm + 0.5) / (dfTerm + 0.5) + 1);
    const termTf = tf[term] || 0;
    score += idf * (termTf * (k1 + 1)) / (termTf + k1 * (1 - b + b * dl / avgdl));
  }
  return score;
}

// ── Main export ───────────────────────────────────────────────────────────────

// ── Recency ───────────────────────────────────────────────────────────────────

const MS_PER_DAY   = 86_400_000;
const HALF_LIFE    = 60;  // days — score halves every 60 days
const DECAY        = Math.LN2 / HALF_LIFE;

/**
 * Recency boost: 0.15 for a file modified today, ~0.075 at 60 days, ~0.01 at 6 months.
 * mtime is epoch milliseconds; absent/0 → no boost.
 */
function recencyBoost(mtime, weight = 0.15) {
  if (!mtime) return 0;
  const ageDays = (Date.now() - mtime) / MS_PER_DAY;
  return weight * Math.exp(-DECAY * ageDays);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Hybrid search over a vector index.
 *
 * @param {string}   query       Raw query string
 * @param {number[]} queryVec    Pre-computed embedding of the query
 * @param {Array}    index       Vector index entries [{source, text, vector, mtime?}]
 * @param {object}   meta        BM25 meta {N, avgdl, df} from bm25.json
 * @param {object}   opts
 * @param {number}   opts.top            Max results (default 8)
 * @param {number}   opts.threshold      Min combined score (default 0.1)
 * @param {number}   opts.vectorWeight   0-1, weight for vector score (default 0.6)
 * @param {number}   opts.recencyWeight  Max recency boost, 0 to disable (default 0.15)
 * @param {string[]} opts.boostSources   Source strings from prior session turns to boost (+0.10)
 */
export function hybridSearch(query, queryVec, index, meta, opts = {}) {
  const { top = 8, threshold = 0.1, vectorWeight = 0.6, recencyWeight = 0.15, boostSources = [] } = opts;
  const boostSet = new Set(boostSources);
  const bm25Weight = 1 - vectorWeight;
  const queryTokens = tokenize(query);

  // Score every chunk
  const raw = index.map((entry) => ({
    source: entry.source,
    text:   entry.text,
    mtime:  entry.mtime || 0,
    vec:    cosineSimilarity(queryVec, entry.vector),
    bm25:   bm25Score(queryTokens, entry.text, meta.df, meta.N, meta.avgdl),
  }));

  // Normalise BM25 to [0, 1] using max in this result set
  const maxBM25 = Math.max(...raw.map((r) => r.bm25), 1e-9);
  const scored = raw.map((r) => {
    const base    = vectorWeight * r.vec + bm25Weight * (r.bm25 / maxBM25);
    const recency = recencyBoost(r.mtime, recencyWeight);
    const session = boostSet.has(r.source) ? 0.10 : 0;
    return {
      source:       r.source,
      text:         r.text,
      mtime:        r.mtime,
      score:        base + recency + session,
      vecScore:     r.vec,
      bm25Score:    r.bm25 / maxBM25,
      recencyScore: recency,
      sessionBoost: session,
    };
  });

  // Deduplicate — keep best-scoring chunk per source
  const seen = new Map();
  for (const r of scored) {
    if (r.score < threshold) continue;
    if (!seen.has(r.source) || seen.get(r.source).score < r.score) {
      seen.set(r.source, r);
    }
  }

  return [...seen.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}
