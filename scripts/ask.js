// Quick Q&A against the brain — answers a question directly in the terminal
// Uses semantic search + Claude. Session history kept for 30 min of inactivity.
// Usage: extrabrain ask "what did we decide about kafka consumer groups?"
//        extrabrain ask "show me fetch calls" --repo my-repo
//        extrabrain ask "what is the endpoint for member lookup?" --sources
//        extrabrain ask "follow up question"   — continues the current session
//        extrabrain ask --new                  — start a fresh session

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import readline from "readline";
import { fileURLToPath } from "url";
import { embedQuery } from "./embed-query.js";
import { getPaths, BRAIN_ROOT } from "./paths.js";
import { hybridSearch } from "./hybrid-search.js";
import { translateQuery } from "./translate-query.js";
import { stream } from "./ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args        = process.argv.slice(2);
const showSources = args.includes("--sources");
const newSession  = args.includes("--new");
const doSave      = args.includes("--save");
const repoIdx     = args.indexOf("--repo");
const repoFilter  = repoIdx !== -1 ? args[repoIdx + 1] : null;
const skipIdx     = new Set([
  ...(repoIdx !== -1 ? [repoIdx, repoIdx + 1] : []),
  ...args.map((a, i) => ["--sources", "--new", "--save"].includes(a) ? i : -1).filter(i => i !== -1),
]);
const question    = args.filter((_, i) => !skipIdx.has(i)).join(" ").trim();

if (!question && !newSession) {
  console.error('\nUsage: extrabrain ask "your question"');
  console.error('       extrabrain ask "your question" --sources');
  console.error('       extrabrain ask "your question" --save');
  console.error('       extrabrain ask "your question" --repo my-repo');
  console.error('       extrabrain ask --new            — clear session and start fresh\n');
  process.exit(1);
}

const p = getPaths();

// ── Session (multi-turn) ───────────────────────────────────────────────────
const SESSION_FILE    = path.join(p.base, ".ask-session.json");
const SESSION_TTL_MS  = 3 * 60 * 60 * 1000; // 3 hours of inactivity

function loadSession() {
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    if (Date.now() - s.updatedAt > SESSION_TTL_MS) return { history: [] };
    return s;
  } catch { return { history: [] }; }
}

function saveSession(history) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ updatedAt: Date.now(), history }, null, 2));
}

function clearSession() {
  try { fs.unlinkSync(SESSION_FILE); } catch {}
}

if (newSession) {
  clearSession();
  if (!question) {
    console.error("  Session cleared.\n");
    process.exit(0);
  }
}

// Tip: embedder daemon check
try {
  await fetch("http://localhost:7071/embed", { method: "POST", body: JSON.stringify({ text: "test" }), headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(300) });
} catch {
  console.log(`\x1b[2m  💡 Tip: run 'extrabrain watch' for instant responses (loads embedding model once)\x1b[0m\n`);
}

if (!fs.existsSync(p.index)) {
  console.error("\n⚠️  No vector index found. Run: extrabrain embed\n");
  process.exit(1);
}

function safeRead(fp) {
  try { return fs.readFileSync(fp, "utf-8"); } catch { return null; }
}

function getFullContent(source) {
  const noteMatch = source.match(/^\[note\] (.+)$/);
  if (noteMatch) return safeRead(path.join(p.notes, noteMatch[1]));

  const docMatch = source.match(/^\[doc\] (.+)$/);
  if (docMatch) return safeRead(path.join(p.docs, docMatch[1]));

  const repoMatch = source.match(/^\[repo:(.+?)\] (.+)$/);
  if (repoMatch) {
    const [, repo, filepath] = repoMatch;
    if (filepath === "_overview") return safeRead(path.join(p.processed, repo, "overview.md"));
    if (filepath === "_files") return safeRead(path.join(p.processed, repo, "code_map.json"));
    const raw = safeRead(path.join(p.processed, repo, "file_contents.json"));
    if (!raw) return null;
    return JSON.parse(raw)[filepath] || null;
  }
  return null;
}

// ANSI
const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan   = (s) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

// Terminal hyperlinks (OSC 8) — works in iTerm2, VS Code terminal, modern macOS Terminal
function fileLink(label, filePath) {
  return `\x1b]8;;file://${filePath}\x07${label}\x1b]8;;\x07`;
}

function sourceToPath(source) {
  const noteMatch = source.match(/^\[note\] (.+)$/);
  if (noteMatch) return path.join(p.notes, noteMatch[1]);

  const docMatch = source.match(/^\[doc\] (.+)$/);
  if (docMatch) return path.join(p.docs, docMatch[1]);

  const repoMatch = source.match(/^\[repo:(.+?)\] (.+)$/);
  if (repoMatch && repoMatch[2] !== "_overview" && repoMatch[2] !== "_files") {
    try {
      const cfg = JSON.parse(fs.readFileSync(p.config, "utf-8"));
      for (const entry of cfg.repos || []) {
        const base = typeof entry === "string" ? entry : entry.path;
        const candidate = path.join(base, repoMatch[1], repoMatch[2]);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {}
  }
  return null;
}

const session  = loadSession();
const history  = session.history; // [{q, a}, ...]

const { query: searchQuestion, translated } = await translateQuery(question);

const repoLabel     = repoFilter ? ` in ${cyan(repoFilter)}` : "";
const sessionLabel  = history.length ? dim(` (session: ${history.length} prior turn${history.length > 1 ? "s" : ""})`) : "";
console.log(`\n${bold("🧠 Thinking...")} ${dim(`"${question}"`)}${repoLabel}${sessionLabel}`);
if (translated) console.log(dim(`   → translated: "${searchQuestion}"`));
console.log();

let index = JSON.parse(fs.readFileSync(p.index, "utf-8"));
const bm25Path = path.join(p.vectorDb, "bm25.json");
let meta = fs.existsSync(bm25Path) ? JSON.parse(fs.readFileSync(bm25Path, "utf-8")) : { N: index.length, avgdl: 100, df: {} };

// Filter index to specific repo if --repo flag given
if (repoFilter) {
  const prefix = `[repo:${repoFilter}]`;
  index = index.filter(e => e.source.startsWith(prefix));
  if (!index.length) {
    console.error(`\n⚠️  No indexed content found for repo: ${repoFilter}`);
    console.error(`    Available repos are shown by: extrabrain search --all\n`);
    process.exit(1);
  }
  meta = { N: index.length, avgdl: meta.avgdl, df: meta.df };
}

const queryVec = await embedQuery(searchQuestion);

// Collect sources used in recent session turns to boost in this search
const recentSources = history.flatMap(h => h.sources || []);

const top = hybridSearch(searchQuestion, queryVec, index, meta, { top: 8, threshold: 0.05, boostSources: recentSources })
  .map(r => [r.source, { score: r.score, text: r.text, sessionBoost: r.sessionBoost }]);

if (!top.length) {
  console.log(dim("  Nothing relevant found. Try rephrasing the question.\n"));
  process.exit(0);
}

// Load full content — prefer full file, but fall back to chunk text if file is tiny or missing
const sections = [];
for (const [source, { score, text }] of top) {
  const full    = getFullContent(source);
  // Only use full file if it meaningfully expands on the chunk (>20% more content)
  const content = (full && full.length > text.length * 1.2)
    ? (full.length > 4000 ? full.slice(0, 4000) + "\n[...truncated]" : full)
    : text;
  sections.push(`[${source}]\n${content}`);
}

const historyBlock = history.length
  ? `Previous conversation:\n${history.map(h => `Q: ${h.q}\nA: ${h.a}`).join("\n\n")}\n\n---\n\n`
  : "";

const prompt = `You are a knowledgeable assistant with access to a personal knowledge base. Answer the following question concisely and directly based only on the source material provided. If the answer isn't in the sources, say so clearly.

${historyBlock}Current question: ${question}

---

${sections.join("\n\n---\n\n")}`;

const answer = await stream(prompt, (chunk) => process.stdout.write(chunk));
process.stdout.write("\n");

// Save turn to session — include sources so follow-ups can boost them
const turnSources = top.map(([source]) => source);
history.push({ q: question, a: answer, sources: turnSources });
saveSession(history.slice(-6)); // keep last 6 turns

if (showSources) {
  console.log(`\n${dim("Sources:")}`);
  for (const [source, { score, sessionBoost }] of top) {
    const boost = sessionBoost > 0 ? yellow(" ↑session") : "";
    const filePath = sourceToPath(source);
    const label = filePath ? fileLink(source, filePath) : source;
    console.log(dim(`  ${(score * 100).toFixed(0)}%  `) + label + boost);
  }
}

const d = new Date();
const pad = (n) => String(n).padStart(2, "0");
const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function saveQA(note) {
  const slug = question.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/-$/, "");
  const filename = `${date}-qa-${slug}.md`;
  const filePath = path.join(p.notes, filename);
  fs.writeFileSync(filePath, note, "utf-8");
  try { execSync(`node ${path.join(__dirname, "embed.js")}`, { cwd: BRAIN_ROOT, stdio: "pipe" }); } catch {}
  return { filename, filePath };
}

if (doSave) {
  const sourcesBlock = turnSources.length
    ? `\n**Sources:** ${turnSources.map(s => `\`${s}\``).join(", ")}\n`
    : "";
  const content = `# Q&A — ${date} ${time}\n\n**Q:** ${question}\n${sourcesBlock}\n${answer}\n`;
  const { filename, filePath } = saveQA(content);
  console.log(dim(`\n  Saved → `) + fileLink(`notes/${filename}`, filePath) + `\n`);
}

console.log(`${dim("  (session active — follow up freely, or `extrabrain ask --new` to reset)")}\n`);

// ── Feedback loop ──────────────────────────────────────────────────────────────
// Only prompt when running interactively (not piped or scripted)
if (process.stdin.isTTY && !doSave) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.question(dim("  Was this helpful? [y]es · [n]o · Enter to skip  "), async (raw) => {
    const key = raw.trim().toLowerCase();
    rl.close();

    if (key === "y" || key === "yes") {
      const sourcesBlock = turnSources.length
        ? `\n**Sources:** ${turnSources.map(s => `\`${s}\``).join(", ")}\n`
        : "";
      const content = `---\ntags: [qa, verified]\n---\n# Q&A — ${date} ${time}\n\n**Q:** ${question}\n${sourcesBlock}\n${answer}\n`;
      const { filename, filePath } = saveQA(content);
      console.log(dim(`  ✅  Saved as verified Q&A → `) + fileLink(`notes/${filename}`, filePath) + "\n");

    } else if (key === "n" || key === "no") {
      const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl2.question(dim("  What was wrong or missing? "), (correction) => {
        rl2.close();
        if (!correction.trim()) { console.log(); return; }
        const sourcesBlock = turnSources.length
          ? `\n**Sources tried:** ${turnSources.map(s => `\`${s}\``).join(", ")}\n`
          : "";
        const content = `---\ntags: [qa, correction, feedback]\n---\n# Correction — ${date} ${time}\n\n**Question:** ${question}\n${sourcesBlock}\n**Answer given:**\n${answer}\n\n**What was wrong:**\n${correction.trim()}\n`;
        const { filename, filePath } = saveQA(content);
        console.log(dim(`  📝  Correction saved → `) + fileLink(`notes/${filename}`, filePath) + "\n");
        console.log(dim("  This will be used to improve future answers on this topic.\n"));
      });
    } else {
      console.log();
    }
  });
}
