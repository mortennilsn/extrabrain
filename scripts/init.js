// init.js — first-run setup wizard
// Creates the data directory structure and walks through configuration

import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { BRAIN_ROOT, setActiveWorkspace, workspaceDir } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const bold  = (s) => `\x1b[1m${s}\x1b[0m`;
const dim   = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const cyan  = (s) => `\x1b[36m${s}\x1b[0m`;
const red   = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

// ── Shell profile detection ────────────────────────────────────────────────────

function detectShellProfile() {
  const shell = process.env.SHELL || "";
  if (shell.includes("zsh")) return path.join(os.homedir(), ".zshrc");
  if (shell.includes("fish")) return path.join(os.homedir(), ".config", "fish", "config.fish");
  const bashrc = path.join(os.homedir(), ".bashrc");
  const bash_profile = path.join(os.homedir(), ".bash_profile");
  return fs.existsSync(bashrc) ? bashrc : bash_profile;
}

function appendToProfile(profilePath, line) {
  const content = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, "utf-8") : "";
  if (content.includes(line.trim())) return false; // already there
  fs.appendFileSync(profilePath, `\n${line}\n`, "utf-8");
  return true;
}

// ── Pull config template ───────────────────────────────────────────────────────

const PULL_TEMPLATE = {
  slack: [],
  slackNames: {},
  jiraProjects: {},
  _instructions: {
    slack: "Add Slack channel IDs (e.g. C0123456789). Find them in Slack: right-click channel → View channel details → scroll to bottom.",
    slackNames: "Map channel ID to readable name: { \"C0123456789\": \"general\" }",
    jiraProjects: "Map Jira project key to name: { \"MYPROJ\": \"My Project\" }. Find project keys in the Jira URL."
  }
};

// ── Directory structure ────────────────────────────────────────────────────────

function createWorkspace(ws, repos = []) {
  const base = workspaceDir(ws);
  ensureDir(path.join(base, "sources", "notes"));
  ensureDir(path.join(base, "sources", "docs"));
  ensureDir(path.join(base, "sources", "inbox"));
  ensureDir(path.join(base, "processed"));
  ensureDir(path.join(base, "vector-db"));
  ensureDir(path.join(base, "config"));

  const configPath = path.join(base, "config", "pull.json");
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(PULL_TEMPLATE, null, 2), "utf-8");
  }

  const sourcesConfig = path.join(base, "config", "sources.json");
  fs.writeFileSync(sourcesConfig, JSON.stringify({
    repos,
    scan: repos.length > 0,
    repoNameFilter: [],
  }, null, 2), "utf-8");
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n${bold("🧠  extrabrain setup")}\n`);
console.log(`Data directory: ${cyan(BRAIN_ROOT)}\n`);

// Re-run guard
const existing = fs.existsSync(BRAIN_ROOT);
if (existing) {
  const answer = await ask(`  Already set up. Re-run setup? ${dim("[y/N]")}  `);
  if (!answer.trim().toLowerCase().startsWith("y")) {
    console.log(dim("\n  Setup cancelled.\n"));
    rl.close();
    process.exit(0);
  }
}

// ── Step 1: Workspace name ────────────────────────────────────────────────────

const wsAnswer = await ask(`  Workspace name ${dim("(Enter for \"default\")")}:  `);
const ws = wsAnswer.trim().replace(/[^a-z0-9_-]/gi, "-").toLowerCase() || "default";

// ── Step 2: Claude CLI check ──────────────────────────────────────────────────

console.log(`\n  ${bold("Claude CLI")}`);
try {
  execSync("which claude", { stdio: "pipe" });
  console.log(green("  ✅  Claude CLI found — you're good to go"));
} catch {
  console.log(red("  ⚠️  Claude CLI not found"));
  console.log(dim("  Install it: npm install -g @anthropic-ai/claude-code"));
  console.log(dim("  If you have Claude Desktop or Claude Code, you're already set up.\n"));
}

// ── Step 3: Repo paths ────────────────────────────────────────────────────────

console.log(`\n  ${bold("Code repositories")} ${dim("(optional — for indexing your codebases)")}`);
console.log(dim("  You can add a folder containing multiple repos, or a single repo path."));
console.log(dim("  Press Enter with no input when done.\n"));

const repos = [];
let repoIndex = 1;
while (true) {
  const repoAnswer = await ask(`  Repo path ${repoIndex} ${dim("(Enter to finish)")}:  `);
  const repoPath = repoAnswer.trim().replace(/^~/, os.homedir());
  if (!repoPath) break;
  if (!fs.existsSync(repoPath)) {
    console.log(yellow(`  ⚠️  Path not found: ${repoPath} — skipping`));
  } else {
    repos.push(repoPath);
    console.log(green(`  ✅  Added`));
    repoIndex++;
  }
}

// ── Create workspace ──────────────────────────────────────────────────────────

ensureDir(BRAIN_ROOT);
createWorkspace(ws, repos);
setActiveWorkspace(ws);

console.log(green(`\n  ✅  Workspace "${ws}" created`));
if (repos.length) console.log(dim(`     ${repos.length} repo path(s) configured`));

// ── Step 4: First sync ────────────────────────────────────────────────────────

if (repos.length > 0) {
  console.log();
  const syncAnswer = await ask(`  Run first sync now? Indexes repos + builds search ${dim("[Y/n]")}  `);
  if (!syncAnswer.trim().toLowerCase().startsWith("n")) {
    console.log();
    try {
      execSync(`node ${path.join(__dirname, "index.js")} && node ${path.join(__dirname, "embed.js")}`, {
        cwd: BRAIN_ROOT,
        stdio: "inherit",
      });
      console.log(green("\n  ✅  Sync complete"));
    } catch {
      console.log(yellow("\n  ⚠️  Sync failed — run 'extrabrain sync' manually"));
    }
  }
}

// ── Step 5: Pull connectors (optional mention) ────────────────────────────────

console.log(`\n  ${bold("Pull connectors")} ${dim("(optional — Slack, Jira, custom APIs)")}`);
console.log(dim(`  Edit: ${path.join(workspaceDir(ws), "config", "pull.json")}`));
console.log(dim("  Requires the Claude CLI for MCP tool access.\n"));

// ── Done ──────────────────────────────────────────────────────────────────────

console.log(green(`  ✅  Setup complete!\n`));
console.log(`  ${bold("Next steps:")}`);
console.log(`  ${cyan("extrabrain note \"first thought\"")}  — save a note`);
console.log(`  ${cyan("extrabrain ask \"...\"")}            — ask a question`);
console.log(`  ${cyan("extrabrain add <file>")}             — add a PDF or doc`);
if (!repos.length) {
  console.log(`  ${cyan("extrabrain sync")}                   — index repos (configure sources.json first)`);
}
console.log();

rl.close();
