// Crawl a website and save every page as markdown in sources/docs/
// Stays within the same domain. Skips nav/footer noise pages.
// Usage: npm run scrape -- "https://docs.example.com"
//        npm run scrape -- "https://docs.example.com" --max 200
//        npm run scrape -- "https://docs.example.com" --delay 500

import fs from "fs";
import path from "path";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { getPaths } from "./paths.js";
const DOCS_DIR = getPaths().docs;

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const maxFlag      = args.indexOf("--max");
const delayFlag    = args.indexOf("--delay");
const selectorFlag = args.indexOf("--selector");
const MAX_PAGES = maxFlag      !== -1 ? parseInt(args[maxFlag + 1])   || 100  : 100;
const DELAY_MS  = delayFlag    !== -1 ? parseInt(args[delayFlag + 1]) || 300  : 300;
const SELECTOR  = selectorFlag !== -1 ? args[selectorFlag + 1]        || null : null;
const rootUrl   = args.find((a) => a.startsWith("http"));

if (!rootUrl) {
  console.error('\nUsage: extrabrain scrape "https://docs.example.com"');
  console.error('       extrabrain scrape "https://..." --max 200 --delay 500');
  console.error('       extrabrain scrape "https://..." --selector main\n');
  process.exit(1);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/https?:\/\/(www\.)?/, "")
    .replace(/[^a-z0-9æøå]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Normalize URL: strip fragment, trailing slash, query strings for dedup
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    let p = u.pathname.replace(/\/$/, "") || "/";
    return `${u.origin}${p}`;
  } catch {
    return url;
  }
}

// Skip URLs that are likely not content pages
const SKIP_PATTERNS = [
  /\.(png|jpg|jpeg|gif|svg|ico|pdf|zip|css|js|woff|woff2|ttf|mp4|mp3)(\?|$)/i,
  /\/(login|logout|signin|signout|auth|oauth|register|signup|404|500)(\/|$|\?)/i,
  /\/(search|tag|tags|category|categories|feed|rss|sitemap)(\/|$|\?)/i,
  /#/,
  /mailto:/,
  /javascript:/,
];

function shouldSkip(url) {
  return SKIP_PATTERNS.some((p) => p.test(url));
}

// Extract all same-domain links from HTML
function extractLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const links = [];
  const matches = html.matchAll(/href=["']([^"']+)["']/gi);
  for (const [, href] of matches) {
    try {
      const abs = new URL(href, baseUrl).href;
      const u = new URL(abs);
      if (u.origin === base.origin && !shouldSkip(abs)) {
        links.push(normalizeUrl(abs));
      }
    } catch {}
  }
  return links;
}

// Extract title from HTML
function extractTitle(html, fallback) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim().replace(/\s+/g, " ") : fallback;
}

// Extract only the content within a CSS selector (tag, .class, #id, tag.class)
// Falls back to full HTML if selector not found
function extractBySelector(html, selector) {
  if (!selector) return html;

  // Parse selector into tag + optional attribute filter
  let tag = null, attrName = null, attrVal = null;
  if (selector.startsWith("#")) {
    attrName = "id"; attrVal = selector.slice(1);
  } else if (selector.startsWith(".")) {
    attrName = "class"; attrVal = selector.slice(1);
  } else if (selector.includes(".")) {
    [tag, attrVal] = selector.split(".");  attrName = "class";
  } else if (selector.includes("#")) {
    [tag, attrVal] = selector.split("#"); attrName = "id";
  } else {
    tag = selector;
  }

  // Build pattern to find the opening tag
  let openPat;
  const t = tag || "[a-z][a-z0-9]*";
  if (attrName && attrVal) {
    openPat = new RegExp(`<(${t})[^>]*${attrName}=["'][^"']*\\b${attrVal}\\b[^"']*["'][^>]*>`, "i");
  } else {
    openPat = new RegExp(`<(${t})(\\s[^>]*)?>`, "i");
  }

  const match = openPat.exec(html);
  if (!match) return html; // selector not found — use full page

  const openTag = match[1].toLowerCase();
  let depth = 1;
  let pos = match.index + match[0].length;
  const contentStart = pos;
  const openRe  = new RegExp(`<${openTag}(\\s[^>]*)?>`, "gi");
  const closeRe = new RegExp(`<\\/${openTag}>`, "gi");

  while (depth > 0 && pos < html.length) {
    openRe.lastIndex  = pos;
    closeRe.lastIndex = pos;
    const nextOpen  = openRe.exec(html);
    const nextClose = closeRe.exec(html);
    if (!nextClose) break;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      pos = nextOpen.index + nextOpen[0].length;
    } else {
      depth--;
      pos = nextClose.index + (depth === 0 ? 0 : nextClose[0].length);
    }
  }

  return html.slice(contentStart, pos) || html;
}

// ── crawler ───────────────────────────────────────────────────────────────────

ensureDir(DOCS_DIR);

const origin = new URL(rootUrl).origin;
const queue = [normalizeUrl(rootUrl)];
const saved = [];
let failed = 0;

// Load already-scraped URLs — tracked separately from visited
// We still fetch these pages to extract their links, we just don't re-save them
const alreadySaved = new Set();
for (const f of fs.readdirSync(DOCS_DIR)) {
  if (!f.endsWith(".md")) continue;
  const content = fs.readFileSync(path.join(DOCS_DIR, f), "utf-8");
  const m = content.match(/^_Source: (.+)_$/m);
  if (m) {
    try {
      const url = normalizeUrl(m[1].trim());
      if (new URL(url).origin === origin) alreadySaved.add(url);
    } catch {}
  }
}

const alreadyScraped = alreadySaved.size;
console.log(`\n🕷  Crawling: ${origin}`);
console.log(`   Max new pages: ${MAX_PAGES} | Delay: ${DELAY_MS}ms | Selector: ${SELECTOR || "full page"}`);
if (alreadyScraped > 0) {
  console.log(`   Resuming — ${alreadyScraped} pages already saved, fetching their links to find the rest`);
}
console.log();

// visited = don't process the same URL twice this run
const visited = new Set();

while (queue.length && saved.length < MAX_PAGES) {
  const url = queue.shift();
  if (visited.has(url)) continue;
  visited.add(url);

  const isOld = alreadySaved.has(url);

  if (!isOld) {
    process.stdout.write(`  [${saved.length + 1}/${MAX_PAGES}] ${url.replace(origin, "")} `);
  }

  let html;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; mcp-brain/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      if (!isOld) { console.log(`→ HTTP ${res.status} (skipped)`); failed++; }
      continue;
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("html")) {
      if (!isOld) console.log(`→ not HTML (skipped)`);
      continue;
    }
    html = await res.text();
  } catch (err) {
    if (!isOld) { console.log(`→ ${err.message.split("\n")[0]} (skipped)`); failed++; }
    continue;
  }

  // Always extract links so we can discover new pages
  for (const link of extractLinks(html, url)) {
    if (!visited.has(link) && !queue.includes(link)) {
      queue.push(link);
    }
  }

  // Skip saving if already on disk
  if (isOld) continue;

  const title = extractTitle(html, url);
  const body = extractBySelector(html, SELECTOR);
  const markdown = NodeHtmlMarkdown.translate(body);
  const cleaned = markdown.replace(/\n{3,}/g, "\n\n").trim();

  if (cleaned.split(" ").length < 30) {
    console.log(`→ too short (skipped)`);
    continue;
  }

  const content = `# ${title}\n_Source: ${url}_\n\n${cleaned}\n`;
  const filename = `${slugify(url)}.md`;
  fs.writeFileSync(path.join(DOCS_DIR, filename), content, "utf-8");
  saved.push(filename);
  console.log(`→ ✅ saved`);

  if (queue.length && DELAY_MS > 0) await sleep(DELAY_MS);
}

const total = alreadyScraped + saved.length;
console.log(`\n✅ Done — ${saved.length} new pages saved, ${alreadyScraped} already existed, ${failed} failed`);
if (queue.length) console.log(`   ${queue.length} pages still in queue — run again with --max ${total + MAX_PAGES} to continue`);
if (saved.length) console.log(`   Files in sources/docs/ — watch mode will auto-embed them\n`);
