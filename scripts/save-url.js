// Fetch a webpage and save it as markdown in sources/docs/
// Usage: npm run save -- "https://..."
//        npm run save -- "https://..." "Custom title"

import fs from "fs";
import path from "path";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { getPaths } from "./paths.js";
import { autotag } from "./autotag.js";
const DOCS_DIR = getPaths().docs;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function slugify(str) {
  return str.toLowerCase()
    .replace(/https?:\/\/(www\.)?/, "")
    .replace(/[^a-z0-9æøå]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

const args = process.argv.slice(2);
const url = args[0];
const customTitle = args.slice(1).join(" ").trim() || null;

if (!url || !url.startsWith("http")) {
  console.error('Usage: extrabrain save "https://..."');
  console.error('       extrabrain save "https://..." "Custom title"');
  process.exit(1);
}

console.log(`\n🌐 Fetching: ${url}`);

let html;
try {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; mcp-brain/1.0)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  html = await res.text();
} catch (err) {
  console.error(`Failed to fetch URL: ${err.message}`);
  process.exit(1);
}

// Extract page title from HTML if no custom title
let title = customTitle;
if (!title) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  title = match ? match[1].trim().replace(/\s+/g, " ") : url;
}

const markdown = NodeHtmlMarkdown.translate(html);

// Remove excessive blank lines
const cleaned = markdown.replace(/\n{3,}/g, "\n\n").trim();
const content = `# ${title}\n_Source: ${url}_\n\n${cleaned}\n`;

ensureDir(DOCS_DIR);
const filename = `${slugify(title)}.md`;
const outPath = path.join(DOCS_DIR, filename);
fs.writeFileSync(outPath, content, "utf-8");

console.log(`✅ Saved → sources/docs/${filename}`);
console.log(`   ${cleaned.split(" ").length} words captured`);
await autotag(outPath);
