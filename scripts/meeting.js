// Create a structured meeting note, open it in VS Code, auto-embed on close
// Usage: npm run meeting -- "Meeting title"

import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { getPaths } from "./paths.js";
import { autotag } from "./autotag.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = getPaths().notes;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function pad(n) { return String(n).padStart(2, "0"); }

function now() {
  const d = new Date();
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    display: `${d.getDate()}. ${d.toLocaleString("no-NO", { month: "long" })} ${d.getFullYear()}`,
  };
}

const title = process.argv.slice(2).join(" ").trim();
if (!title) {
  console.error('Usage: extrabrain meeting "Meeting title"');
  process.exit(1);
}

const { date, time, display } = now();
const slug = title.toLowerCase().replace(/[^a-z0-9æøå]+/g, "-").replace(/^-|-$/g, "");
const filename = `${date}-meeting-${slug}.md`;
const filePath = path.join(NOTES_DIR, filename);

const template = `# ${title}
📅 ${display} · ${time}

## Attendees
-

## Context / Background


## Agenda


## Decisions
-

## Actions
| Action | Owner | Due |
|--------|-------|-----|
|  |  |  |

## Notes


---
_Meeting note saved to mcp-brain_
`;

ensureDir(NOTES_DIR);
fs.writeFileSync(filePath, template, "utf-8");
console.log(`\n📝 Created: sources/notes/${filename}`);
console.log("   Opening in VS Code — fill it in, save, and close the tab to auto-embed.\n");

// Open in VS Code and wait for the file to be closed
const vscode = spawnSync("code", ["--wait", filePath], { stdio: "inherit" });

// Auto-tag after VS Code closes (content is now filled in)
await autotag(filePath);

// Auto-embed after VS Code closes the file
console.log("\n🔄 Embedding note...");
try {
  execSync("node " + path.join(__dirname, "embed.js"), {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
  });
} catch (e) {
  console.error("Embed failed:", e.message);
}
