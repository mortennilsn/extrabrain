// feedback.js — review and manage verified Q&As and corrections
//
// Usage: extrabrain feedback --review               — list all verified Q&As
//        extrabrain feedback --review --corrections — list corrections instead
//        extrabrain feedback --review --all         — list both
//        extrabrain feedback --unverify <filename>  — remove verified tag, re-embed
//        extrabrain feedback --audit                — show MCP write audit log

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { getPaths, BRAIN_ROOT } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const p = getPaths();

const args       = process.argv.slice(2);
const doReview   = args.includes("--review");
const doAudit    = args.includes("--audit");
const doUnverify = args.includes("--unverify");
const showCorr   = args.includes("--corrections");
const showAll    = args.includes("--all");
const filename   = doUnverify ? args[args.indexOf("--unverify") + 1] : null;

const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red    = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan   = (s) => `\x1b[36m${s}\x1b[0m`;

function pad(n) { return String(n).padStart(2, "0"); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function readNote(fp) {
  try { return fs.readFileSync(fp, "utf-8"); } catch { return null; }
}

function hasFrontmatterTag(content, tag) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return false;
  return match[1].includes(tag);
}

function getQuestion(content) {
  const m = content.match(/\*\*Q(?:uestion)?:\*\*\s*(.+)/);
  return m ? m[1].trim() : null;
}

function getAnswerPreview(content) {
  // Strip frontmatter and header, get first substantive line
  const body = content.replace(/^---[\s\S]*?---\n/, "").replace(/^#.*\n/, "").trim();
  const lines = body.split("\n").filter(l => l.trim() && !l.startsWith("**Q") && !l.startsWith("**Sources"));
  return lines[0]?.slice(0, 120) || "(no preview)";
}

function getWhatWasWrong(content) {
  const m = content.match(/\*\*What was wrong:\*\*\n([\s\S]+?)(?:\n\n|$)/);
  return m ? m[1].trim().slice(0, 150) : null;
}

// ── Review verified Q&As ──────────────────────────────────────────────────────

function reviewVerified() {
  if (!fs.existsSync(p.notes)) { console.log("\n⚠️  No notes directory.\n"); return; }

  const files = fs.readdirSync(p.notes).filter(f => f.includes("-qa-") && f.endsWith(".md"));
  const verified = [];
  const corrections = [];

  for (const f of files) {
    const content = readNote(path.join(p.notes, f));
    if (!content) continue;
    if (hasFrontmatterTag(content, "verified"))   verified.push({ f, content });
    if (hasFrontmatterTag(content, "correction")) corrections.push({ f, content });
  }

  const showVerified    = !showCorr || showAll;
  const showCorrections = showCorr  || showAll;

  console.log(`\n${bold("🔍 Feedback review")}\n`);

  if (showVerified) {
    console.log(bold(`✅ Verified Q&As (${verified.length})`));
    if (!verified.length) {
      console.log(dim("  None yet. Answer a question and hit [y] to save one.\n"));
    } else {
      for (const { f, content } of verified) {
        const q       = getQuestion(content) || f;
        const preview = getAnswerPreview(content);
        console.log(`\n  ${cyan(f)}`);
        console.log(`  Q: ${bold(q)}`);
        console.log(dim(`  A: ${preview}`));
        console.log(dim(`     extrabrain feedback --unverify ${f}`));
      }
      console.log();
    }
  }

  if (showCorrections) {
    console.log(bold(`📝 Corrections (${corrections.length})`));
    if (!corrections.length) {
      console.log(dim("  None yet. Answer a question and hit [n] to file a correction.\n"));
    } else {
      for (const { f, content } of corrections) {
        const q    = getQuestion(content) || f;
        const what = getWhatWasWrong(content);
        console.log(`\n  ${yellow(f)}`);
        console.log(`  Q: ${bold(q)}`);
        if (what) console.log(red(`  Wrong: ${what}`));
        console.log(dim(`     extrabrain feedback --unverify ${f}  (to remove)`));
      }
      console.log();
    }
  }

  if (!showVerified && !showCorrections) {
    console.log(dim("  Use --review, --review --corrections, or --review --all\n"));
  }
}

// ── Unverify ──────────────────────────────────────────────────────────────────

function unverify(fname) {
  const fp = path.join(p.notes, path.basename(fname));
  if (!fs.existsSync(fp)) {
    console.error(`\n⚠️  File not found: ${fname}\n`);
    process.exit(1);
  }

  const content = readNote(fp);
  // Remove verified/correction tags from frontmatter
  const updated = content
    .replace(/^(---\n[\s\S]*?)\n---/, (_, front) =>
      front
        .replace(/,?\s*verified/g, "")
        .replace(/,?\s*correction/g, "")
        .replace(/,?\s*feedback/g, "")
        .replace(/tags:\s*\[\s*,/, "tags: [")
        .replace(/tags:\s*\[\s*\]/, "tags: [qa]")
      + "\n---"
    );

  fs.writeFileSync(fp, updated, "utf-8");
  try {
    execSync(`node ${path.join(__dirname, "embed.js")}`, { cwd: BRAIN_ROOT, stdio: "pipe" });
  } catch {}

  console.log(green(`\n✅  Removed verified/correction tag from ${path.basename(fname)}`));
  console.log(dim("  Re-embedded — this note will no longer carry extra weight in searches.\n"));
}

// ── Audit log ─────────────────────────────────────────────────────────────────

function showAuditLog() {
  const logPath = path.join(BRAIN_ROOT, ".mcp-audit.log");
  if (!fs.existsSync(logPath)) {
    console.log(dim("\n  No MCP audit log yet. Writes via Claude Desktop will appear here.\n"));
    return;
  }

  const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
  if (!lines.length) {
    console.log(dim("\n  Audit log is empty.\n"));
    return;
  }

  console.log(`\n${bold("🔒 MCP audit log")} — last ${Math.min(lines.length, 20)} writes\n`);

  const recent = lines.slice(-20).reverse();
  for (const line of recent) {
    try {
      const { ts, tool, summary } = JSON.parse(line);
      const d   = new Date(ts);
      const time = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      console.log(`  ${dim(time)}  ${cyan(tool)}  ${summary}`);
    } catch {
      console.log(dim(`  (malformed line)`));
    }
  }
  console.log();
  console.log(dim(`  Full log: ${logPath}\n`));
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (!doReview && !doAudit && !doUnverify) {
  console.log(`
${bold("extrabrain feedback")} — manage Q&A quality

  ${cyan("--review")}                    list all verified Q&As
  ${cyan("--review --corrections")}      list corrections
  ${cyan("--review --all")}              list both
  ${cyan("--unverify <filename>")}       remove verified tag and re-embed
  ${cyan("--audit")}                     show MCP write audit log
`);
  process.exit(0);
}

if (doReview)              reviewVerified();
if (doAudit)               showAuditLog();
if (doUnverify && filename) unverify(filename);
else if (doUnverify)       { console.error("\n⚠️  Usage: extrabrain feedback --unverify <filename>\n"); process.exit(1); }
