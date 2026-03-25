// Quick note CLI — adds a timestamped note to sources/notes/
// Usage: npm run note "your note text"
// Or with a title: npm run note -- --title "Meeting" "your note text"

import fs from "fs";
import path from "path";
import { getPaths } from "./paths.js";
import { autotag } from "./autotag.js";
const NOTES_DIR = getPaths().notes;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function datetimeHeader() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const args = process.argv.slice(2);

if (!args.length) {
  console.error("Usage: npm run note \"your note text\"");
  console.error('       npm run note -- --title "My Title" "your note text"');
  process.exit(1);
}

let title = null;
let noteText = null;

const titleIdx = args.indexOf("--title");
if (titleIdx !== -1) {
  title = args[titleIdx + 1];
  noteText = args.filter((_, i) => i !== titleIdx && i !== titleIdx + 1).join(" ");
} else {
  noteText = args.join(" ");
}

const slug = title
  ? title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  : "note";

const date = timestamp();
const filename = `${date}-${slug}.md`;
const filePath = path.join(NOTES_DIR, filename);

// If file exists, append to it
const header = title ? `# ${title}\n_${datetimeHeader()}_\n\n` : `# Note — ${datetimeHeader()}\n\n`;
const content = fs.existsSync(filePath)
  ? `\n---\n_${datetimeHeader()}_\n\n${noteText}\n`
  : `${header}${noteText}\n`;

const isNew = !fs.existsSync(filePath);
ensureDir(NOTES_DIR);
fs.appendFileSync(filePath, content, "utf-8");
console.log(`✅ Note saved → sources/notes/${filename}`);
if (isNew) await autotag(filePath);
