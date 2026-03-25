// Terminal hybrid search — vector + BM25 keyword combined
// Usage: extrabrain search "your query"
//        extrabrain search "your query" --top 10
//        extrabrain search "your query" --all

import fs from "fs";
import path from "path";
import { embedQuery } from "./embed-query.js";
import { getPaths, getActiveWorkspace, listWorkspaces } from "./paths.js";
import { hybridSearch } from "./hybrid-search.js";
import { translateQuery } from "./translate-query.js";

const THRESHOLD   = 0.10;
const DEFAULT_TOP = 8;

const args    = process.argv.slice(2);
const topFlag = args.indexOf("--top");
const allFlag = args.includes("--all");
const top     = topFlag !== -1 ? parseInt(args[topFlag + 1]) || DEFAULT_TOP : DEFAULT_TOP;
const skipIdx = new Set(topFlag !== -1 ? [topFlag, topFlag + 1] : []);
const query   = args
  .filter((a, i) => a !== "--all" && !skipIdx.has(i))
  .join(" ").trim();

if (!query) {
  console.error("\nUsage: extrabrain search \"your query\"");
  console.error("       extrabrain search \"your query\" --top 10");
  console.error("       extrabrain search \"your query\" --all\n");
  process.exit(1);
}

function loadWorkspace(ws) {
  const p = getPaths(ws);
  if (!fs.existsSync(p.index)) return null;
  const bm25Path = path.join(p.vectorDb, "bm25.json");
  try {
    const index = JSON.parse(fs.readFileSync(p.index, "utf-8"));
    const meta  = fs.existsSync(bm25Path) ? JSON.parse(fs.readFileSync(bm25Path, "utf-8")) : { N: index.length, avgdl: 100, df: {} };
    return { ws, index, meta };
  } catch { return null; }
}

const workspaces = (allFlag ? listWorkspaces() : [getActiveWorkspace()])
  .map(loadWorkspace).filter(Boolean);

if (!workspaces.length) {
  console.error("\n⚠️  No vector index found. Run: extrabrain embed\n");
  process.exit(1);
}

const bold  = (s) => `\x1b[1m${s}\x1b[0m`;
const dim   = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan  = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function scoreBar(score) {
  const filled = Math.round(score * 10);
  return green("█".repeat(filled)) + dim("░".repeat(10 - filled)) + ` ${(score * 100).toFixed(0)}%`;
}

const { query: searchQuery, translated } = await translateQuery(query);

const context = allFlag ? "all workspaces" : getActiveWorkspace();
console.log(`\n${bold("🔍 Searching")} ${dim(context)} ${dim(`— "${query}"`)}`);
if (translated) console.log(`${dim(`   → translated: "${searchQuery}"`)}`);
console.log();

const queryVec = await embedQuery(searchQuery);

// Search each workspace, tag results with workspace name when --all
let results = [];
for (const { ws, index, meta } of workspaces) {
  const hits = hybridSearch(searchQuery, queryVec, index, meta, { top, threshold: THRESHOLD });
  for (const h of hits) {
    results.push(allFlag ? { ...h, source: `[${ws}] ${h.source}` } : h);
  }
}

// Re-sort and trim if searching across multiple workspaces
results = results.sort((a, b) => b.score - a.score).slice(0, top);

if (!results.length) {
  console.log(dim("  No results above threshold. Try a different query.\n"));
  process.exit(0);
}

console.log(`${bold(`${results.length} result${results.length === 1 ? "" : "s"}`)}\n`);

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const vec     = (r.vecScore     * 100).toFixed(0);
  const bm25    = (r.bm25Score    * 100).toFixed(0);
  const recency = r.recencyScore > 0.005 ? `  ${yellow(`⏱ +${(r.recencyScore * 100).toFixed(0)}%`)}` : "";
  console.log(`${bold(`${i + 1}.`)} ${cyan(r.source)}`);
  console.log(`   ${scoreBar(r.score)}  ${dim(`vec ${vec}%  kw ${bm25}%`)}${recency}`);
  const preview = r.text.replace(/\s+/g, " ").trim().slice(0, 200);
  console.log(`   ${dim(preview + (r.text.length > 200 ? "…" : ""))}`);
  console.log();
}
