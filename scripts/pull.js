// pull.js — run configured connectors and save results as notes
//
// Usage: extrabrain pull                  — run all enabled connectors
//        extrabrain pull --only <name>    — run one connector by name
//        extrabrain pull --list           — show configured connectors
//        extrabrain pull --dry-run        — preview without saving
//        extrabrain pull --days 3         — passed as {{days}} in prompts
//
// Config: workspaces/<ws>/config/pull.json
//
// Each connector defines:
//   name        — identifier, used in filenames and --only flag
//   description — shown in --list output
//   enabled     — set to true to include in default pull
//   tags        — added to saved note frontmatter
//   tools       — comma-separated MCP tool names Claude may call
//   prompt      — what to ask Claude to do
//
// Prompt variables (replaced before sending):
//   {{date}}    — today's date (YYYY-MM-DD)
//   {{days}}    — value from --days flag (default: 1)
//   {{cutoff}}  — date N days ago (YYYY-MM-DD)

import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { getPaths, BRAIN_ROOT } from "./paths.js";
import { scrubPII } from "./pii-scrub.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const p = getPaths();

const args    = process.argv.slice(2);
const dryRun  = args.includes("--dry-run");
const doList  = args.includes("--list");
const onlyIdx = args.indexOf("--only");
const onlyName = onlyIdx !== -1 ? args[onlyIdx + 1] : null;
const daysIdx = args.indexOf("--days");
const DAYS    = daysIdx !== -1 ? parseInt(args[daysIdx + 1]) || 1 : 1;

const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan   = (s) => `\x1b[36m${s}\x1b[0m`;

function pad(n) { return String(n).padStart(2, "0"); }
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

// ── Config ────────────────────────────────────────────────────────────────────

const configFile = path.join(p.base, "config", "pull.json");

let config = { connectors: [] };
if (fs.existsSync(configFile)) {
  try { config = JSON.parse(fs.readFileSync(configFile, "utf-8")); } catch {}
}

if (!config.connectors?.length) {
  console.log(`\n${yellow("⚠️  No connectors configured.")}`);
  console.log(dim(`  Edit: ${configFile}`));
  console.log(dim(`  See the examples in that file to get started.\n`));
  process.exit(0);
}

// ── List ──────────────────────────────────────────────────────────────────────

if (doList) {
  console.log(`\n${bold("🔌 Pull connectors")}\n`);
  for (const c of config.connectors) {
    const status = c.enabled ? green("✅ enabled") : dim("○  disabled");
    console.log(`  ${status}  ${bold(c.name)}  ${dim(c.description || "")}`);
  }
  console.log();
  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolvePrompt(template, date) {
  return template
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{days\}\}/g, String(DAYS))
    .replace(/\{\{cutoff\}\}/g, daysAgo(DAYS));
}

function callClaude(prompt, tools) {
  const toolArgs = tools?.trim()
    ? ["--allowedTools", tools.trim()]
    : [];

  const result = spawnSync("claude", ["-p", ...toolArgs], {
    input: prompt,
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || "claude exited with error");
  return result.stdout.trim();
}

function saveNote(filename, content) {
  if (dryRun) return;
  const { text: clean, redactions } = scrubPII(content);
  const total = Object.values(redactions).reduce((a, b) => a + b, 0);
  if (total > 0) {
    const summary = Object.entries(redactions).map(([k, v]) => `${v} ${k}`).join(", ");
    console.log(yellow(`     🔒 Scrubbed ${total} PII item(s): ${summary}`));
  }
  fs.mkdirSync(p.notes, { recursive: true });
  fs.writeFileSync(path.join(p.notes, filename), clean, "utf-8");
}

function buildNote(connector, body, date) {
  const tags = ["pull", ...(connector.tags || [])].join(", ");
  return `---\ntags: [${tags}]\n---\n# ${connector.description || connector.name} — ${date}\n\n${body}\n`;
}

// ── Run connectors ────────────────────────────────────────────────────────────

const date = today();
const toRun = config.connectors.filter((c) => {
  if (onlyName) return c.name === onlyName;
  return c.enabled;
});

if (!toRun.length) {
  if (onlyName) {
    console.log(yellow(`\n⚠️  No connector named "${onlyName}". Run 'extrabrain pull --list' to see options.\n`));
  } else {
    console.log(dim("\n  No connectors enabled. Edit config/pull.json and set enabled: true.\n"));
  }
  process.exit(0);
}

console.log(`\n${bold("🔄 extrabrain pull")}${dryRun ? yellow("  [dry run — nothing will be saved]") : ""}  ${dim(`${toRun.length} connector${toRun.length === 1 ? "" : "s"}`)}\n`);

let saved = 0;

for (const connector of toRun) {
  process.stdout.write(`  ${cyan(connector.name)}  ${dim(connector.description || "")}  `);

  const prompt = resolvePrompt(connector.prompt, date);

  let output;
  try {
    output = callClaude(prompt, connector.tools);
  } catch (err) {
    process.stdout.write(yellow(`⚠️  failed: ${err.message.slice(0, 80)}\n`));
    continue;
  }

  if (!output) {
    process.stdout.write(dim("nothing returned\n"));
    continue;
  }

  const filename = `${date}-${connector.name}.md`;
  const note = buildNote(connector, output, date);
  saveNote(filename, note);

  process.stdout.write(green("✅\n"));
  if (!dryRun) process.stdout.write(dim(`         → notes/${filename}\n`));
  saved++;
}

if (saved > 0 && !dryRun) {
  process.stdout.write(dim("\n  Embedding..."));
  try {
    execSync(`node ${path.join(__dirname, "embed.js")}`, { cwd: BRAIN_ROOT, stdio: "pipe" });
    process.stdout.write(green(" ✅\n"));
  } catch {
    process.stdout.write(yellow(" skipped\n"));
  }
}

console.log(dim(`\n  Tip: run 'extrabrain pull --list' to see all connectors.\n`));
