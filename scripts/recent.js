// Show recently added/modified content in the brain
// Usage: npm run recent               — last 7 days
//        npm run recent -- --days 14  — last N days

import fs from "fs";
import path from "path";
import { getPaths } from "./paths.js";
const _p = getPaths();

const args = process.argv.slice(2);
const daysFlag = args.indexOf("--days");
const DAYS = daysFlag !== -1 ? parseInt(args[daysFlag + 1]) || 7 : 7;
const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;

// ANSI
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

function pad(n) { return String(n).padStart(2, "0"); }
function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function scanDir(dir, label, color) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const fp = path.join(dir, f);
    const stat = fs.statSync(fp);
    if (stat.mtimeMs >= cutoff) {
      results.push({ label, name: f, mtime: stat.mtimeMs, color });
    }
  }
  return results;
}

const entries = [
  ...scanDir(_p.notes, "note", cyan),
  ...scanDir(_p.docs,  "doc",  yellow),
].sort((a, b) => b.mtime - a.mtime);

console.log(`\n${bold("🧠 Brain activity")} — last ${DAYS} day${DAYS === 1 ? "" : "s"}\n`);

if (!entries.length) {
  console.log(dim(`  Nothing added in the last ${DAYS} days.\n`));
  process.exit(0);
}

for (const e of entries) {
  const tag = e.color(`[${e.label}]`);
  console.log(`  ${tag} ${bold(e.name)}  ${dim(fmtDate(e.mtime))}`);
}

// Also show inbox pending
const inbox = _p.inbox;
if (fs.existsSync(inbox)) {
  const pending = fs.readdirSync(inbox).filter((f) => {
    const fp = path.join(inbox, f);
    return fs.statSync(fp).isFile() && !f.startsWith(".");
  });
  if (pending.length) {
    console.log(`\n  ${yellow("⚠️  Inbox")} ${pending.length} file(s) waiting to be converted:`);
    for (const f of pending) console.log(dim(`     ${f}`));
    console.log(dim("     Run: extrabrain convert"));
  }
}

console.log();
