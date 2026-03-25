// Weekly digest — summarise everything captured in the last N days
// Usage: extrabrain digest             ← last 7 days
//        extrabrain digest --days 14   ← last N days
//        extrabrain digest --save      ← save digest as a note

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { getPaths, BRAIN_ROOT } from "./paths.js";
import { stream } from "./ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const p = getPaths();

const args     = process.argv.slice(2);
const daysFlag = args.indexOf("--days");
const DAYS     = daysFlag !== -1 ? parseInt(args[daysFlag + 1]) || 7 : 7;
const doSave   = args.includes("--save");
const cutoff   = Date.now() - DAYS * 24 * 60 * 60 * 1000;

function pad(n) { return String(n).padStart(2, "0"); }
function safeRead(fp) { try { return fs.readFileSync(fp, "utf-8"); } catch { return null; } }

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim  = (s) => `\x1b[2m${s}\x1b[0m`;

function getRecentNotes(dir, cutoff) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    // Skip digests, briefs, and actions summaries to avoid recursion
    if (f.includes("-digest-") || f.includes("-brief-") || f.includes("-actions-")) continue;
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
const docs  = getRecentNotes(p.docs,  cutoff);
const all   = [...notes, ...docs].sort((a, b) => a.mtime - b.mtime);

if (!all.length) {
  console.log(`\n⚠️  Nothing captured in the last ${DAYS} days.\n`);
  process.exit(0);
}

console.log(`\n${bold("🧠 Generating digest")} — last ${DAYS} day${DAYS === 1 ? "" : "s"} (${all.length} file${all.length === 1 ? "" : "s"})\n`);

// Truncate large files to stay within context limits
const MAX_CHARS = 4000;
const sections = all.map(({ file, content }) => {
  const trimmed = content.length > MAX_CHARS
    ? content.slice(0, MAX_CHARS) + "\n[...truncated]"
    : content;
  const isJournal = file.includes("-journal");
  const label = isJournal ? `### [JOURNAL] ${file}` : `### ${file}`;
  return `${label}\n\n${trimmed}`;
});

// ── Ask Claude ────────────────────────────────────────────────────────────────

const d = new Date();
const today = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const periodLabel = DAYS === 7 ? "this week" : `the last ${DAYS} days`;

const prompt = `You are summarising a personal knowledge base for the week.

Files marked [JOURNAL] are personal daily reflections — pay special attention to intentions, moods, frustrations, and personal commitments written there. These often contain the most honest signal about what actually happened vs what was planned.

Generate a digest for ${periodLabel}. Structure it as:

## What got done
Bullet points of the main work completed or topics covered.

## Key decisions & outcomes
Any decisions made, conclusions reached, or important outcomes.

## Themes & patterns
2-3 observations about recurring themes or patterns across the week. If journal entries reveal a mood or energy pattern, include that.

## Open threads
Things that seem unresolved, ongoing, or worth following up on. Include anything flagged in journal entries as unfinished or worrying.

## Suggested focus
1-2 sentence recommendation for what to prioritise next based on what you see.

Be concrete and specific — use names, project names, and details from the notes. Skip generic filler.

---

${sections.join("\n\n---\n\n")}`;

console.log("🤖 Generating digest...\n");
const digest = await stream(prompt, (chunk) => process.stdout.write(chunk));
process.stdout.write("\n");

// ── Output ────────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(60));
console.log(digest);
console.log("═".repeat(60) + "\n");

// ── Optionally save ───────────────────────────────────────────────────────────

if (doSave) {
  const filename = `${today}-digest-${DAYS}d.md`;
  const outPath  = path.join(p.notes, filename);
  const content  = `# Digest — ${periodLabel}\n_${today}_\n\n${digest}\n`;
  fs.writeFileSync(outPath, content, "utf-8");

  try {
    execSync(`node ${path.join(__dirname, "embed.js")}`, {
      cwd: BRAIN_ROOT,
      stdio: "pipe",
    });
  } catch {}

  console.log(dim(`Saved → sources/notes/${filename}\n`));
}
