// Retroactively tag all existing untagged docs and notes
// Usage: extrabrain commands retag              — tag all untagged files
//        extrabrain commands retag --notes      — notes only
//        extrabrain commands retag --docs       — docs only
//        extrabrain commands retag --dry-run    — preview what would be tagged

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { getPaths, BRAIN_ROOT } from "./paths.js";
import { autotag } from "./autotag.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const p = getPaths();

const args   = process.argv.slice(2);
const onlyNotes = args.includes("--notes");
const onlyDocs  = args.includes("--docs");
const dryRun    = args.includes("--dry-run");

const bold  = (s) => `\x1b[1m${s}\x1b[0m`;
const dim   = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const MIN_WORDS = 50;

function collectUntagged(dir, label) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const fp      = path.join(dir, f);
    const content = fs.readFileSync(fp, "utf-8");
    if (content.startsWith("---")) continue; // already tagged
    const words = content.trim().split(/\s+/).length;
    if (words < MIN_WORDS) continue; // too short
    results.push({ file: f, path: fp, words, label });
  }
  return results;
}

// Collect targets
const targets = [
  ...(!onlyDocs  ? collectUntagged(p.notes, "note") : []),
  ...(!onlyNotes ? collectUntagged(p.docs,  "doc")  : []),
];

if (!targets.length) {
  console.log("\n✅  All files already tagged.\n");
  process.exit(0);
}

const scope = onlyNotes ? "notes" : onlyDocs ? "docs" : "notes + docs";
console.log(`\n${bold("🏷   Retagging")} — ${targets.length} untagged file${targets.length === 1 ? "" : "s"} (${scope})\n`);

if (dryRun) {
  for (const t of targets) {
    console.log(`  ${dim(`[${t.label}]`)} ${t.file}  ${dim(`${t.words} words`)}`);
  }
  console.log(dim(`\n  Dry run — nothing changed. Remove --dry-run to apply.\n`));
  process.exit(0);
}

// Process with a small delay to avoid hammering Claude
let done = 0;
let skipped = 0;

for (const t of targets) {
  const pct    = Math.round(((done + skipped) / targets.length) * 100);
  const bar    = "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
  process.stdout.write(`\r[${bar}] ${pct}%  ${dim(t.file.slice(0, 40))}  `);

  const before = fs.readFileSync(t.path, "utf-8");
  await autotag(t.path);
  const after  = fs.readFileSync(t.path, "utf-8");

  if (after !== before) {
    done++;
  } else {
    skipped++;
  }

  // Small pause between calls so we don't rate-limit Claude
  await new Promise(r => setTimeout(r, 300));
}

process.stdout.write("\r" + " ".repeat(70) + "\r");

console.log(green(`✅  Tagged ${done} file${done === 1 ? "" : "s"}`));
if (skipped) console.log(dim(`   Skipped ${skipped} (too short or Claude unavailable)`));

// Re-embed everything now that frontmatter has changed
console.log("\n🔄  Re-embedding...");
try {
  execSync(`node ${path.join(__dirname, "embed.js")}`, {
    cwd: BRAIN_ROOT,
    stdio: "inherit",
  });
  console.log("✅  Done\n");
} catch (e) {
  console.error("Embed failed:", e.message);
}
