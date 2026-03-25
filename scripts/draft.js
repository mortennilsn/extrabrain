// Draft a document using your brain as context
// Usage: extrabrain draft "write a proposal for migrating to Kafka"
//        extrabrain draft "email to John about the API delay" --format email
//        extrabrain draft "retrospective for Q1" --format report --save
//        extrabrain draft "explain our auth architecture" --format memo --open
//
// Formats (auto-detected if not specified):
//   proposal  — structured proposal with background, options, recommendation
//   email     — professional email ready to send
//   report    — formal report with executive summary and sections
//   memo      — internal memo, concise
//   summary   — plain summary document
//   doc       — generic document (default)

import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { hybridSearch } from "./hybrid-search.js";
import { embedQuery } from "./embed-query.js";
import { translateQuery } from "./translate-query.js";
import { getPaths, BRAIN_ROOT } from "./paths.js";
import { stream } from "./ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const p = getPaths();

// ── Args ──────────────────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const formatIdx  = args.indexOf("--format");
const formatArg  = formatIdx !== -1 ? args[formatIdx + 1]?.toLowerCase() : null;
const doSave     = args.includes("--save");
const doOpen     = args.includes("--open");
const skipIdx    = new Set([
  ...(formatIdx !== -1 ? [formatIdx, formatIdx + 1] : []),
  ...args.map((a, i) => ["--save", "--open"].includes(a) ? i : -1).filter(i => i !== -1),
]);
const prompt = args.filter((_, i) => !skipIdx.has(i)).join(" ").trim();

if (!prompt) {
  console.error('\nUsage: extrabrain draft "write a proposal for X"');
  console.error('       extrabrain draft "email to John about Y" --format email');
  console.error('       extrabrain draft "document Z" --format report --save --open\n');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, "0"); }
function safeRead(fp) { try { return fs.readFileSync(fp, "utf-8"); } catch { return null; } }

const bold  = (s) => `\x1b[1m${s}\x1b[0m`;
const dim   = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan  = (s) => `\x1b[36m${s}\x1b[0m`;

function fileLink(label, filePath) {
  return `\x1b]8;;file://${filePath}\x07${label}\x1b]8;;\x07`;
}

// ── Format detection ──────────────────────────────────────────────────────────

const FORMAT_PATTERNS = [
  { format: "email",    patterns: /\b(email|mail|message to|write to|send to)\b/i },
  { format: "proposal", patterns: /\b(proposal|propose|pitching|pitch|business case)\b/i },
  { format: "report",   patterns: /\b(report|retrospective|retro|post-mortem|review)\b/i },
  { format: "memo",     patterns: /\b(memo|internal|announce|announcement)\b/i },
  { format: "summary",  patterns: /\b(summary|summarise|summarize|overview|tldr|tl;dr)\b/i },
];

function detectFormat(text) {
  if (formatArg) return formatArg;
  for (const { format, patterns } of FORMAT_PATTERNS) {
    if (patterns.test(text)) return format;
  }
  return "doc";
}

// ── Format instructions ───────────────────────────────────────────────────────

const FORMAT_INSTRUCTIONS = {
  email: `Write a professional email. Include:
- Subject line (prefix with "Subject: ")
- Greeting
- Clear, concise body (2-4 paragraphs max)
- Call to action or next step
- Professional sign-off
Keep it direct and action-oriented.`,

  proposal: `Write a structured proposal document. Include:
- Executive summary (2-3 sentences)
- Background / problem statement
- Proposed approach / solution
- Options considered (if relevant)
- Recommendation
- Next steps
- Open questions or risks
Use headers for each section.`,

  report: `Write a formal report. Include:
- Executive summary
- Introduction / context
- Findings / analysis
- Conclusions
- Recommendations
- Appendix references (if sources warrant it)
Use clear headers and bullet points where appropriate.`,

  memo: `Write a concise internal memo. Include:
- To / From / Date / Re: header block
- Purpose (one sentence)
- Key points (3-5 bullets)
- Action required (if any)
Keep it under one page.`,

  summary: `Write a clear summary document. Include:
- A one-paragraph overview
- Key points as bullet list
- Conclusion or takeaway
Be concise — no filler.`,

  doc: `Write a clear, well-structured document appropriate to the request.
Use headers, bullet points, and tables where they add clarity.
Lead with the most important information.`,
};

// ── Source loading ────────────────────────────────────────────────────────────

function getFullContent(source) {
  const noteMatch = source.match(/^\[note\] (.+)$/);
  if (noteMatch) return safeRead(path.join(p.notes, noteMatch[1]));

  const docMatch = source.match(/^\[doc\] (.+)$/);
  if (docMatch) return safeRead(path.join(p.docs, docMatch[1]));

  const repoMatch = source.match(/^\[repo:(.+?)\] (.+)$/);
  if (repoMatch) {
    const contentsPath = path.join(p.processed, repoMatch[1], "file_contents.json");
    const raw = safeRead(contentsPath);
    if (!raw) return null;
    return JSON.parse(raw)[repoMatch[2]] || null;
  }
  return null;
}

function sourceToPath(source) {
  const noteMatch = source.match(/^\[note\] (.+)$/);
  if (noteMatch) return path.join(p.notes, noteMatch[1]);

  const docMatch = source.match(/^\[doc\] (.+)$/);
  if (docMatch) return path.join(p.docs, docMatch[1]);

  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (!fs.existsSync(p.index)) {
  console.error("\n⚠️  No vector index found. Run: extrabrain commands sync\n");
  process.exit(1);
}

const format = detectFormat(prompt);
const formatLabel = format === "doc" ? "document" : format;

console.log(`\n${bold("✍️  Drafting")} ${dim(`"${prompt}"`)}`);
if (formatArg || format !== "doc") console.log(dim(`   Format: ${formatLabel}`));
console.log();

// Search for relevant context — use more sources than brief since we need depth
const { query: searchQuery, translated } = await translateQuery(prompt);
if (translated) console.log(dim(`   → translated query: "${searchQuery}"\n`));

const index    = JSON.parse(fs.readFileSync(p.index, "utf-8"));
const bm25Path = path.join(p.vectorDb, "bm25.json");
const meta     = fs.existsSync(bm25Path)
  ? JSON.parse(fs.readFileSync(bm25Path, "utf-8"))
  : { N: index.length, avgdl: 100, df: {} };

const queryVec = await embedQuery(searchQuery);
const results  = hybridSearch(searchQuery, queryVec, index, meta, { top: 12, threshold: 0.05 });

if (!results.length) {
  console.log(dim("  Nothing relevant found in the brain — drafting from the prompt alone.\n"));
}

// Load full file content for each result
const MAX_CHARS = 5000;
const sections  = [];
for (const r of results) {
  const full    = getFullContent(r.source);
  const content = full && full.length > r.text.length * 1.2
    ? (full.length > MAX_CHARS ? full.slice(0, MAX_CHARS) + "\n[...truncated]" : full)
    : r.text;
  sections.push(`[${r.source}]\n${content}`);
}

const contextBlock = sections.length
  ? `Use the following knowledge base content as context and source material:\n\n${sections.join("\n\n---\n\n")}`
  : "No specific context found — use your general knowledge.";

const claudePrompt = `You are a skilled writer helping draft professional documents. Match the language of the request.

Request: ${prompt}

Format instructions:
${FORMAT_INSTRUCTIONS[format] || FORMAT_INSTRUCTIONS.doc}

${contextBlock}

---

Draft the document now. Use only information from the context provided — do not invent facts, names, or details that aren't in the source material. If something is unclear, note it with [TODO: clarify X].`;

process.stdout.write("\n");
const draft = await stream(claudePrompt, (chunk) => process.stdout.write(chunk));
process.stdout.write("\n");

// ── Output ────────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(60));
console.log(draft);
console.log("═".repeat(60));

// Sources
if (results.length) {
  console.log(`\n${dim("Sources used:")}`);
  for (const r of results.slice(0, 6)) {
    const fp    = sourceToPath(r.source);
    const label = fp ? fileLink(r.source, fp) : r.source;
    console.log(dim(`  ${(r.score * 100).toFixed(0)}%  `) + label);
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────

if (doSave || doOpen) {
  const d    = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const slug = prompt.toLowerCase()
    .replace(/[^a-z0-9æøå]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  const filename = `${date}-draft-${slug}.md`;
  const outPath  = path.join(p.notes, filename);

  const content = `# Draft — ${prompt}\n_${date} · ${formatLabel}_\n\n${draft}\n`;
  fs.writeFileSync(outPath, content, "utf-8");

  if (doSave) {
    try {
      execSync(`node ${path.join(__dirname, "embed.js")}`, {
        cwd: BRAIN_ROOT,
        stdio: "pipe",
      });
    } catch {}
    console.log(`\n✅  Saved → ` + fileLink(`sources/notes/${filename}`, outPath) + "\n");
  }

  if (doOpen) {
    spawnSync("code", [outPath], { stdio: "inherit" });
  }
}

console.log();
