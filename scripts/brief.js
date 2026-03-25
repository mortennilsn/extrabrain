// Generate a pre-meeting intelligence briefing on any topic
// Searches the brain, loads full content of top sources, synthesizes with Claude
// Usage: npm run brief -- "topic"

import fs from "fs";
import path from "path";
import { complete } from "./ai.js";
import { hybridSearch } from "./hybrid-search.js";
import { embedQuery } from "./embed-query.js";
import { translateQuery } from "./translate-query.js";

import { getPaths } from "./paths.js";
const _p = getPaths();
const VECTOR_INDEX   = _p.index;
const DOCS_PATH      = _p.docs;
const NOTES_PATH     = _p.notes;
const PROCESSED_PATH = _p.processed;
const BRIEFS_PATH    = _p.notes;

const topic = process.argv.slice(2).join(" ").trim();
if (!topic) {
  console.error('Usage: extrabrain brief "topic"');
  process.exit(1);
}

function pad(n) { return String(n).padStart(2, "0"); }
function safeRead(p) { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } }
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

// Terminal hyperlinks (OSC 8) — works in iTerm2, VS Code terminal, modern macOS Terminal
function fileLink(label, filePath) {
  return `\x1b]8;;file://${filePath}\x07${label}\x1b]8;;\x07`;
}

function sourceToPath(source) {
  const noteMatch = source.match(/^\[note\] (.+)$/);
  if (noteMatch) return path.join(NOTES_PATH, noteMatch[1]);

  const docMatch = source.match(/^\[doc\] (.+)$/);
  if (docMatch) return path.join(DOCS_PATH, docMatch[1]);

  const repoMatch = source.match(/^\[repo:(.+?)\] (.+)$/);
  if (repoMatch && repoMatch[2] !== "_overview" && repoMatch[2] !== "_files") {
    try {
      const cfg = JSON.parse(fs.readFileSync(_p.config, "utf-8"));
      for (const entry of cfg.repos || []) {
        const base = typeof entry === "string" ? entry : entry.path;
        const candidate = path.join(base, repoMatch[1], repoMatch[2]);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {}
  }
  return null;
}

function getFullContent(source) {
  // [note] filename.md
  const noteMatch = source.match(/^\[note\] (.+)$/);
  if (noteMatch) return safeRead(path.join(NOTES_PATH, noteMatch[1]));

  // [doc] filename.md
  const docMatch = source.match(/^\[doc\] (.+)$/);
  if (docMatch) return safeRead(path.join(DOCS_PATH, docMatch[1]));

  // [repo:name] filepath
  const repoMatch = source.match(/^\[repo:(.+?)\] (.+)$/);
  if (repoMatch) {
    const contentsPath = path.join(PROCESSED_PATH, repoMatch[1], "file_contents.json");
    const raw = safeRead(contentsPath);
    if (!raw) return null;
    const files = JSON.parse(raw);
    return files[repoMatch[2]] || null;
  }

  return null;
}

async function run() {
  if (!fs.existsSync(VECTOR_INDEX)) {
    console.error("No vector index found. Run `extrabrain sync` first.");
    process.exit(1);
  }

  const { query: searchTopic, translated } = await translateQuery(topic);
  console.log(`\n🔍 Searching brain for: "${topic}"...`);
  if (translated) console.log(`   → translated: "${searchTopic}"`);

  const index    = JSON.parse(fs.readFileSync(VECTOR_INDEX, "utf-8"));
  const bm25Path = path.join(_p.vectorDb, "bm25.json");
  const meta     = fs.existsSync(bm25Path) ? JSON.parse(fs.readFileSync(bm25Path, "utf-8")) : { N: index.length, avgdl: 100, df: {} };

  const queryVec = await embedQuery(searchTopic);

  const topResults = hybridSearch(searchTopic, queryVec, index, meta, { top: 8, threshold: 0.08 });
  const top = topResults.map(r => [r.source, r.score]);

  if (!top.length) {
    console.log(`\nNothing relevant found for "${topic}". Try different wording.`);
    process.exit(0);
  }

  console.log(`📚 Found ${top.length} relevant source(s). Loading content...\n`);

  // Load full content for each source
  const sections = [];
  for (const [source, score] of top) {
    const content = getFullContent(source);
    if (!content) continue;
    // Truncate very large files to avoid overwhelming Claude
    const truncated = content.length > 6000 ? content.slice(0, 6000) + "\n\n[...truncated]" : content;
    sections.push(`### Source: ${source} (relevance: ${score.toFixed(2)})\n\n${truncated}`);
  }

  if (!sections.length) {
    console.log("Could not load content for relevant sources.");
    process.exit(1);
  }

  const prompt = `You are a knowledgeable assistant helping someone prepare for a meeting or conversation.

Generate a concise intelligence briefing on the topic: "${topic}"

Use ONLY the source material below. Structure the briefing as follows:
1. **Current State** — where things stand right now
2. **Key Decisions Made** — relevant decisions and who made them
3. **Technical Context** — architecture, systems, and implementation details
4. **Open Issues / Risks** — unresolved problems or risks to be aware of
5. **Useful Context** — anything else worth knowing going into a conversation on this topic

Be concise, factual, and practical. Skip anything not relevant to the topic. Write in English.

---

${sections.join("\n\n---\n\n")}`;

  console.log("🤖 Generating briefing with Claude...\n");
  const brief = await complete(prompt);

  // Save briefing as a note
  const d = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const slug = topic.toLowerCase().replace(/[^a-z0-9æøå]+/g, "-").replace(/^-|-$/g, "");
  const filename = `${date}-brief-${slug}.md`;
  const outPath = path.join(BRIEFS_PATH, filename);

  const saved = `# Briefing: ${topic}\n_${date}_\n\n${brief}`;
  fs.writeFileSync(outPath, saved, "utf-8");

  // Print to terminal
  console.log("═".repeat(60));
  console.log(brief);
  console.log("═".repeat(60));

  // Sources used
  console.log(`\n${dim("Sources:")}`);
  for (const [source, score] of top) {
    const filePath = sourceToPath(source);
    const label = filePath ? fileLink(source, filePath) : source;
    console.log(dim(`  ${(score * 100).toFixed(0)}%  `) + label);
  }

  const savedPath = path.join(BRIEFS_PATH, filename);
  console.log(`\n✅ Saved → ` + fileLink(`sources/notes/${filename}`, savedPath) + `\n`);
}

run();
