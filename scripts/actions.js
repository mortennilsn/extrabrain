// Surface action items, todos, and follow-ups from recent notes
// Usage: extrabrain actions            ← last 7 days
//        extrabrain actions --days 14  ← last N days
//        extrabrain actions --save     ← save extracted actions as a note
//        extrabrain actions --all      ← scan all notes ever

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { getPaths, BRAIN_ROOT } from "./paths.js";
import { complete } from "./ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const p = getPaths();

const args     = process.argv.slice(2);
const daysFlag = args.indexOf("--days");
const DAYS     = daysFlag !== -1 ? parseInt(args[daysFlag + 1]) || 7 : 7;
const doSave   = args.includes("--save");
const scanAll  = args.includes("--all");
const cutoff   = scanAll ? 0 : Date.now() - DAYS * 24 * 60 * 60 * 1000;

function pad(n) { return String(n).padStart(2, "0"); }
function safeRead(fp) { try { return fs.readFileSync(fp, "utf-8"); } catch { return null; } }

const bold  = (s) => `\x1b[1m${s}\x1b[0m`;
const dim   = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const cyan  = (s) => `\x1b[36m${s}\x1b[0m`;

function getRecentNotes(dir, cutoff) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    // Skip previously generated action summaries
    if (f.includes("-actions-")) continue;
    const fp   = path.join(dir, f);
    const stat = fs.statSync(fp);
    if (stat.mtimeMs >= cutoff) {
      const content = safeRead(fp);
      if (content) results.push({ file: f, path: fp, content, mtime: stat.mtimeMs });
    }
  }
  return results;
}

// ── Gather content ────────────────────────────────────────────────────────────

const notes = getRecentNotes(p.notes, cutoff);

if (!notes.length) {
  const rangeLabel = scanAll ? "ever" : `the last ${DAYS} days`;
  console.log(`\n⚠️  No notes found from ${rangeLabel}.\n`);
  process.exit(0);
}

const rangeLabel = scanAll ? "all time" : `last ${DAYS} day${DAYS === 1 ? "" : "s"}`;
console.log(`\n${bold("✅  Extracting actions")} — ${rangeLabel} (${notes.length} note${notes.length === 1 ? "" : "s"})\n`);

const MAX_CHARS = 3000;
const sections = notes.map(({ file, content }) => {
  const trimmed = content.length > MAX_CHARS
    ? content.slice(0, MAX_CHARS) + "\n[...truncated]"
    : content;
  return `### Source: ${file}\n\n${trimmed}`;
});

// ── Ask Claude ────────────────────────────────────────────────────────────────

const prompt = `You are extracting action items from a personal knowledge base.

Files marked [JOURNAL] are personal daily reflections. In these, also extract:
- Personal intentions ("I want to...", "I should...")
- Things the person said they'd follow up on
- Worries or blockers that imply an action
- Morning plans or evening resolutions

Extract ALL action items, todos, follow-ups, and unresolved things from all files. These can be:
- Explicit tasks ("I need to...", "TODO:", "Action:", checkbox items)
- Implicit commitments ("I will...", "we agreed to...", "I should...")
- Open questions that need resolution
- Things flagged as unfinished

Return ONLY a valid JSON array. No markdown, no explanation. Each item:
{
  "action": "<the action in plain language>",
  "owner": "<person responsible, or 'me' if unclear>",
  "source": "<filename>",
  "priority": "high" | "medium" | "low",
  "due": "<date or timeframe if mentioned, else null>"
}

If there are no actions, return an empty array [].

---

${sections.join("\n\n---\n\n")}`;

process.stdout.write("⠋  Scanning for actions...\r");
const raw = (await complete(prompt, { maxTokens: 4096 })).trim();

// Strip code fences if present
const json = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "").trim();

let actions = [];
try {
  actions = JSON.parse(json);
} catch {
  console.error("⚠️  Could not parse actions response. Raw output:\n");
  console.error(raw);
  process.exit(1);
}

// ── Display ───────────────────────────────────────────────────────────────────

if (!actions.length) {
  console.log(dim("  No action items found.\n"));
  process.exit(0);
}

// Group by priority
const high   = actions.filter(a => a.priority === "high");
const medium = actions.filter(a => a.priority === "medium");
const low    = actions.filter(a => a.priority === "low");

function printGroup(label, color, items) {
  if (!items.length) return;
  console.log(color(`\n${label} (${items.length})`));
  for (const a of items) {
    const due    = a.due    ? dim(` · due: ${a.due}`)    : "";
    const owner  = a.owner && a.owner !== "me" ? dim(` · ${a.owner}`) : "";
    const source = dim(` ← ${a.source}`);
    console.log(`  ${bold("·")} ${a.action}${owner}${due}${source}`);
  }
}

console.log(`\n${bold("Action items")} — ${rangeLabel}\n${"─".repeat(50)}`);
printGroup("🔴  High priority", (s) => `\x1b[31m${s}\x1b[0m`, high);
printGroup("🟡  Medium priority", (s) => `\x1b[33m${s}\x1b[0m`, medium);
printGroup("⚪  Low priority", dim, low);
console.log();

// ── Optionally save ───────────────────────────────────────────────────────────

if (doSave) {
  const d = new Date();
  const today    = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const filename = `${today}-actions-${rangeLabel.replace(/\s+/g, "-")}.md`;
  const outPath  = path.join(p.notes, filename);

  function mdGroup(label, items) {
    if (!items.length) return "";
    const rows = items.map(a => {
      const due   = a.due   || "";
      const owner = a.owner || "me";
      return `| ${a.action} | ${owner} | ${due} | ${a.source} |`;
    }).join("\n");
    return `## ${label}\n\n| Action | Owner | Due | Source |\n|--------|-------|-----|--------|\n${rows}\n`;
  }

  const content = [
    `# Actions — ${rangeLabel}\n_${today}_\n`,
    mdGroup("High priority", high),
    mdGroup("Medium priority", medium),
    mdGroup("Low priority", low),
  ].filter(Boolean).join("\n");

  fs.writeFileSync(outPath, content, "utf-8");

  try {
    execSync(`node ${path.join(__dirname, "embed.js")}`, {
      cwd: BRAIN_ROOT,
      stdio: "pipe",
    });
  } catch {}

  console.log(dim(`Saved → sources/notes/${filename}\n`));
}
