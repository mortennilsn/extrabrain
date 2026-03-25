// Workspace management — create, switch, list workspaces
// Usage: node scripts/workspace.js create <name>
//        node scripts/workspace.js use <name>
//        node scripts/workspace.js list
//        node scripts/workspace.js current

import fs from "fs";
import path from "path";
import {
  BRAIN_ROOT,
  getActiveWorkspace,
  setActiveWorkspace,
  listWorkspaces,
  workspaceDir,
  getPaths,
} from "./paths.js";

const bold  = (s) => `\x1b[1m${s}\x1b[0m`;
const dim   = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const cyan  = (s) => `\x1b[36m${s}\x1b[0m`;

const DEFAULT_CONFIG = (name) => JSON.stringify({
  repos: [],
  scan: false,
  repoNameFilter: [],
  notes: [],
  docs: [],
}, null, 2);

function scaffoldWorkspace(name) {
  const p = getPaths(name);
  [p.notes, p.docs, p.inbox, p.processed, p.vectorDb, path.join(p.base, "config")].forEach((d) => {
    fs.mkdirSync(d, { recursive: true });
  });
  if (!fs.existsSync(p.config)) {
    fs.writeFileSync(p.config, DEFAULT_CONFIG(name), "utf-8");
  }
}

const [,, cmd, arg] = process.argv;
const active = getActiveWorkspace();

switch (cmd) {

  case "create": {
    if (!arg) { console.error("Usage: extrabrain workspace create <name>"); process.exit(1); }
    const name = arg.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const dir = workspaceDir(name);
    if (fs.existsSync(dir)) {
      console.log(`\n⚠️  Workspace "${name}" already exists.\n`);
      process.exit(0);
    }
    scaffoldWorkspace(name);
    console.log(`\n✅ Workspace "${bold(name)}" created`);
    console.log(dim(`   ${dir}`));
    console.log(`\n   Next steps:`);
    console.log(`   1. Edit ${dim(`workspaces/${name}/config/sources.json`)} to set repos/filters`);
    console.log(`   2. Run ${cyan(`extrabrain workspace use ${name}`)}`);
    console.log(`   3. Drop docs in ${dim(`workspaces/${name}/sources/docs/`)} and run ${cyan("extrabrain sync")}\n`);
    break;
  }

  case "use": {
    if (!arg) { console.error("Usage: extrabrain workspace use <name>"); process.exit(1); }
    const name = arg.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const dir = workspaceDir(name);
    if (!fs.existsSync(dir)) {
      console.error(`\n⚠️  Workspace "${name}" does not exist. Run: extrabrain workspace create ${name}\n`);
      process.exit(1);
    }
    setActiveWorkspace(name);
    const p = getPaths(name);
    let chunks = 0;
    try { chunks = JSON.parse(fs.readFileSync(p.index, "utf-8")).length; } catch {}
    console.log(`\n✅ Switched to workspace: ${bold(name)}`);
    if (chunks) console.log(`   Vector index: ${chunks} chunks`);
    else console.log(`   ${dim("No vector index yet — run: extrabrain sync")}`);
    console.log();
    break;
  }

  case "list": {
    const workspaces = listWorkspaces();
    console.log(`\n${bold("🧠 Workspaces")}\n`);
    if (!workspaces.length) {
      console.log(dim("  No workspaces found. Run: extrabrain workspace create <name>\n"));
      break;
    }
    for (const ws of workspaces) {
      const p = getPaths(ws);
      let chunks = 0;
      try { chunks = JSON.parse(fs.readFileSync(p.index, "utf-8")).length; } catch {}
      const isActive = ws === active;
      const marker = isActive ? green("▶ ") : "  ";
      const label  = isActive ? bold(green(ws)) : ws;
      const info   = chunks ? dim(` — ${chunks} chunks`) : dim(" — not indexed");
      console.log(`${marker}${label}${info}`);
    }
    console.log(`\n${dim(`Active: ${active}`)}\n`);
    break;
  }

  case "current": {
    console.log(active);
    break;
  }

  default:
    console.log(`\nUsage:`);
    console.log(`  extrabrain workspace create <name>  — create a new workspace`);
    console.log(`  extrabrain workspace use <name>     — switch active workspace`);
    console.log(`  extrabrain workspace list           — show all workspaces`);
    console.log(`  extrabrain workspace current        — print active workspace name\n`);
}
