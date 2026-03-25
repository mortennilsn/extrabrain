// Remove duplicate chunks from the vector index.
// Pass 1: exact text dedup (hash-based, O(n))
// Pass 2: cosine near-dedup among [doc] chunks only (O(docs²))
// Run after extrabrain embed: extrabrain dedup
//
// Usage: extrabrain dedup
//        extrabrain dedup --dry-run   (show what would be removed without changing index)

import fs from "fs";
import { getPaths } from "./paths.js";

const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Dedup the index in-place for a given workspace paths object.
 * @param {object} p        getPaths() result
 * @param {object} opts
 * @param {boolean} opts.dryRun   preview only, don't write
 * @param {boolean} opts.quiet    suppress per-pass output (used when called from embed)
 */
export function dedupIndex(p, { dryRun = false, quiet = false } = {}) {
  if (!fs.existsSync(p.index)) return;

  const index = JSON.parse(fs.readFileSync(p.index, "utf-8"));
  const toRemove = new Set();

  // Pass 1: exact text dedup
  const seen = new Map();
  for (let i = 0; i < index.length; i++) {
    const key = index[i].text.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) { toRemove.add(i); } else { seen.set(key, i); }
  }
  if (!quiet) console.log(`  Pass 1 (exact):    ${toRemove.size} duplicate(s)`);

  // Pass 2: cosine near-dedup for [doc] chunks
  const docChunks = index
    .map((e, i) => ({ ...e, _i: i }))
    .filter(e => e.source.startsWith("[doc]") && !toRemove.has(e._i));

  if (!quiet) process.stdout.write(`  Pass 2 (cosine):   comparing ${docChunks.length} doc chunks...`);

  let nearDups = 0;
  for (let i = 0; i < docChunks.length; i++) {
    if (toRemove.has(docChunks[i]._i)) continue;
    for (let j = i + 1; j < docChunks.length; j++) {
      if (toRemove.has(docChunks[j]._i)) continue;
      if (cosine(docChunks[i].vector, docChunks[j].vector) > 0.97) {
        const keepI = (docChunks[i].mtime || 0) >= (docChunks[j].mtime || 0);
        toRemove.add(keepI ? docChunks[j]._i : docChunks[i]._i);
        nearDups++;
      }
    }
  }
  if (!quiet) console.log(` ${nearDups} near-duplicate(s)`);

  if (!toRemove.size) {
    if (!quiet) console.log(green("  ✅ Index is already clean\n"));
    return;
  }

  if (dryRun) {
    console.log(dim("  Sources that would be deduplicated:"));
    [...toRemove].slice(0, 20).forEach(i => console.log(dim(`    ${index[i].source}`)));
    if (toRemove.size > 20) console.log(dim(`    ... and ${toRemove.size - 20} more`));
    console.log();
    return;
  }

  const clean = index.filter((_, i) => !toRemove.has(i));
  fs.writeFileSync(p.index, JSON.stringify(clean));
  if (!quiet) {
    console.log(`\n  ${bold("Total:")} removed ${toRemove.size} — index now ${clean.length} chunks`);
  } else {
    console.log(`  🧹 Dedup: ${index.length} → ${clean.length} chunks (removed ${toRemove.size})`);
  }
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (process.argv[1].endsWith("dedup.js")) {
  const dryRun = process.argv.includes("--dry-run");
  const p = getPaths();

  console.log(`\n${bold("🧹 Deduplicating index")}${dryRun ? yellow(" (dry run)") : ""}\n`);
  const index = JSON.parse(fs.readFileSync(p.index, "utf-8"));
  console.log(`  Index: ${index.length} chunks\n`);

  dedupIndex(p, { dryRun });
  if (!dryRun) console.log(green("  ✅ Done\n"));
}
