// Show a summary of what's currently in the brain
import fs from "fs";
import path from "path";
import { getPaths, getActiveWorkspace } from "./paths.js";
const p = getPaths();

function countFiles(dir, ext) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => !ext || f.endsWith(ext)).length;
}

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) =>
    fs.statSync(path.join(dir, f)).isDirectory()
  );
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function humanSize(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

function lastModified(p) {
  try {
    const d = fs.statSync(p).mtime;
    return d.toLocaleDateString("no-NO", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return "unknown"; }
}

const repos = listDirs(p.processed);
const docs = countFiles(p.docs, ".md");
const notes = countFiles(p.notes, ".md");
const inbox = countFiles(p.inbox);
const vectorIndex = p.index;
const vectorExists = fs.existsSync(vectorIndex);
const vectorSize = humanSize(fileSize(vectorIndex));
const vectorUpdated = lastModified(vectorIndex);

let chunkCount = 0;
if (vectorExists) {
  try {
    const raw = fs.readFileSync(vectorIndex, "utf-8");
    chunkCount = JSON.parse(raw).length;
  } catch {}
}

console.log(`
╔══════════════════════════════════╗
║   🧠  Brain: ${getActiveWorkspace().padEnd(19)}║
╠══════════════════════════════════╣
║  Repos indexed   ${String(repos.length).padStart(4)}             ║
║  Docs            ${String(docs).padStart(4)}             ║
║  Notes           ${String(notes).padStart(4)}             ║
║  Inbox (pending) ${String(inbox).padStart(4)}             ║
╠══════════════════════════════════╣
║  Vector index    ${vectorExists ? `${String(chunkCount).padStart(4)} chunks` : " not built"}      ║
║  Index size      ${vectorExists ? vectorSize.padStart(7) : "       "}          ║
║  Last embedded   ${vectorExists ? vectorUpdated : "never"}         ║
╚══════════════════════════════════╝

Repos: ${repos.join(", ") || "none"}
`);
