// extrabrain watch — background daemon
// Watches sources/ for new notes/docs/inbox files, and repos for git pulls
// Usage: node scripts/watch.js        (foreground)
//        node scripts/watch.js &      (background, managed by extrabrain shell script)

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

import { getPaths, BRAIN_ROOT } from "./paths.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.join(BRAIN_ROOT, ".watch.pid");

// Resolve paths at startup from active workspace
let _p = getPaths();
let NOTES_DIR = _p.notes;
let DOCS_DIR  = _p.docs;
let INBOX_DIR = _p.inbox;
const CONFIG_PATH = _p.config;

// ── helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  const t = new Date().toTimeString().slice(0, 5);
  console.log(`\x1b[2m[${t}]\x1b[0m ${msg}`);
}

function run(label, cmd) {
  try {
    log(`⚙️  ${label}`);
    execSync(cmd, { cwd: BRAIN_ROOT, stdio: "pipe" });
    log(`✅ ${label} done`);
  } catch (err) {
    log(`⚠️  ${label} failed: ${err.message.split("\n")[0]}`);
  }
}

// Debounce: collect rapid-fire events and fire once after quiet period
const timers = {};
function debounce(key, ms, fn) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(fn, ms);
}

// ── actions ──────────────────────────────────────────────────────────────────

function onSourceChanged(type) {
  debounce("embed", 2000, () => {
    run("Embedding changes", `node scripts/embed.js`);
  });
}

function onInboxChanged() {
  // Only trigger if there are actual files waiting (not subfolders like processed/)
  const pending = fs.existsSync(INBOX_DIR)
    ? fs.readdirSync(INBOX_DIR).filter((f) => {
        const fp = path.join(INBOX_DIR, f);
        return fs.statSync(fp).isFile() && !f.startsWith(".");
      })
    : [];

  if (!pending.length) return;

  debounce("inbox", 3000, () => {
    log(`📥 Inbox: ${pending.length} file(s) detected`);
    run("Converting inbox", `node scripts/convert-inbox.js`);
    run("Embedding changes", `node scripts/embed.js`);
  });
}

function onRepoPulled(repoPath) {
  const name = path.basename(repoPath);
  debounce(`repo:${name}`, 5000, () => {
    log(`📦 Repo pulled: ${name}`);
    run(`Extracting ${name}`, `node scripts/index.js`);
    run("Embedding changes", `node scripts/embed.js`);
  });
}

// ── resolve repos from config ─────────────────────────────────────────────────

function resolveRepos() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    const filters = config.repoNameFilter
      ? (Array.isArray(config.repoNameFilter) ? config.repoNameFilter : [config.repoNameFilter])
      : [];

    const repos = [];
    for (const entry of config.repos || []) {
      const dir = typeof entry === "string" ? entry : entry.path;
      if (!fs.existsSync(dir)) continue;
      const stat = fs.statSync(dir);
      if (stat.isDirectory()) {
        const gitDir = path.join(dir, ".git");
        if (fs.existsSync(gitDir)) {
          repos.push(dir);
        } else {
          // scan subdirectories
          for (const sub of fs.readdirSync(dir)) {
            const subPath = path.join(dir, sub);
            if (fs.statSync(subPath).isDirectory() && fs.existsSync(path.join(subPath, ".git"))) {
              if (!filters.length || filters.some((f) => sub.toLowerCase().includes(f.toLowerCase()))) {
                repos.push(subPath);
              }
            }
          }
        }
      }
    }
    return repos;
  } catch {
    return [];
  }
}

// ── watchers ─────────────────────────────────────────────────────────────────

function watchDir(dir, label, onChange) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.watch(dir, { recursive: false }, (event, filename) => {
    if (!filename || filename.startsWith(".")) return;
    onChange(filename);
  });
  log(`👁  Watching ${label}`);
}

function watchRepos(repos) {
  for (const repoPath of repos) {
    const fetchHead = path.join(repoPath, ".git", "FETCH_HEAD");
    // Watch the .git dir — FETCH_HEAD is updated on every fetch/pull
    const gitDir = path.join(repoPath, ".git");
    fs.watch(gitDir, { recursive: false }, (event, filename) => {
      if (filename === "FETCH_HEAD") {
        onRepoPulled(repoPath);
      }
    });
    log(`👁  Watching repo: ${path.basename(repoPath)}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

// Write PID so `extrabrain watch stop` can kill this process
fs.writeFileSync(PID_FILE, String(process.pid));

process.on("exit", () => {
  try { fs.unlinkSync(PID_FILE); } catch {}
});
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

console.log("\n\x1b[1m🧠 extrabrain watch\x1b[0m — listening for changes\n");

watchDir(NOTES_DIR, "sources/notes", () => onSourceChanged("note"));
watchDir(DOCS_DIR,  "sources/docs",  () => onSourceChanged("doc"));
watchDir(INBOX_DIR, "sources/inbox", () => onInboxChanged());

const repos = resolveRepos();
if (repos.length) {
  watchRepos(repos);
} else {
  log("⚠️  No repos found to watch (check config/sources.json)");
}

console.log(`\n\x1b[2mPID ${process.pid} — run 'extrabrain watch stop' to quit\x1b[0m\n`);
