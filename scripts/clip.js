// Save clipboard content as a note in the brain
// Usage: npm run clip                  — saves clipboard as timestamped note
//        npm run clip -- "My title"    — saves with a specific title

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { getPaths } from "./paths.js";
import { autotag } from "./autotag.js";
const NOTES_DIR = getPaths().notes;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function pad(n) { return String(n).padStart(2, "0"); }

const title = process.argv.slice(2).join(" ").trim() || null;

// Read clipboard (macOS)
let content;
try {
  content = execSync("pbpaste", { encoding: "utf-8" }).trim();
} catch {
  console.error("Could not read clipboard.");
  process.exit(1);
}

if (!content) {
  console.error("Clipboard is empty.");
  process.exit(1);
}

const d = new Date();
const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const slug = title
  ? title.toLowerCase().replace(/[^a-z0-9æøå]+/g, "-").replace(/^-|-$/g, "")
  : "clip";
const filename = `${date}-${slug}.md`;
const filePath = path.join(NOTES_DIR, filename);

const header = title
  ? `# ${title}\n_${date} ${time}_\n\n`
  : `# Clip — ${date} ${time}\n\n`;

const isNew = !fs.existsSync(filePath);
const body = isNew
  ? `${header}${content}\n`
  : `\n---\n_${date} ${time}_\n\n${content}\n`;

ensureDir(NOTES_DIR);
fs.appendFileSync(filePath, body, "utf-8");
console.log(`✅ Clipboard saved → sources/notes/${filename}`);
if (isNew) await autotag(filePath);
