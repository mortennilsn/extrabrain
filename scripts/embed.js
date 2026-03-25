// Generate embeddings incrementally — only re-embeds new or changed content
// Stores vectors in vector-db/index.json, tracks state in vector-db/manifest.json
// Usage: npm run embed
// Run this after: npm run convert, npm run extract, or npm run note

import fs from "fs";
import path from "path";
import { pipeline } from "@xenova/transformers";
import { buildBM25Meta } from "./hybrid-search.js";
import { dedupIndex } from "./dedup.js";

import { getPaths } from "./paths.js";
const p = getPaths();
const VECTOR_DB      = p.vectorDb;
const INDEX_FILE     = p.index;
const MANIFEST_FILE  = p.manifest;
const BM25_FILE      = path.join(p.vectorDb, "bm25.json");
const DOCS_PATH      = p.docs;
const NOTES_PATH     = p.notes;
const PROCESSED_PATH = p.processed;

const CHUNK_SIZE = 400; // max words per chunk

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeRead(p) {
  try { return fs.readFileSync(p, "utf-8"); } catch { return null; }
}

function mtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

function listFiles(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(ext) && fs.statSync(path.join(dir, f)).isFile())
    .map((f) => path.join(dir, f));
}

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => fs.statSync(path.join(dir, f)).isDirectory())
    .map((f) => path.join(dir, f));
}

// ── Smarter chunking ──────────────────────────────────────────────────────────

function wordCount(str) {
  return str.split(/\s+/).filter(Boolean).length;
}

// True for markdown notes/docs and .md repo files
function isMarkdown(source) {
  return /^\[(note|doc)\]/.test(source) || /\.md$/i.test(source);
}

// Extract file extension from source string like "[repo:name] src/foo.tsx"
function sourceExt(source) {
  const m = source.match(/\.(\w+)$/);
  return m ? m[1].toLowerCase() : "";
}

const TS_DECL  = /^(export\s+)?(default\s+)?(async\s+)?(function\*?|class|const|let|var|type|interface|enum|abstract\s+class)\s+\w/;
const RUST_DECL = /^(pub(\s*\([^)]*\))?\s+)?(async\s+)?(fn|impl|struct|enum|mod|trait|type|use|static|const)\s+/;

// Split source code into logical top-level declaration blocks
function splitCodeBlocks(text, source) {
  const ext = sourceExt(source);
  const isTS   = ["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext);
  const isRust = ext === "rs";
  if (!isTS && !isRust) return null;

  const declPattern = isRust ? RUST_DECL : TS_DECL;
  const lines  = text.split("\n");
  const blocks = [];
  let current  = [];

  for (const line of lines) {
    if (declPattern.test(line) && current.join("").trim()) {
      blocks.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.join("").trim()) blocks.push(current.join("\n"));

  return blocks.length > 1 ? blocks : null; // fall through if no boundaries found
}

// Split markdown into [{heading, body}] sections by h1-h3 headings
function splitMarkdownSections(text) {
  const lines = text.split("\n");
  const sections = [];
  let heading = null;
  let body = [];

  for (const line of lines) {
    if (/^#{1,3}\s/.test(line)) {
      if (heading !== null || body.join("\n").trim()) {
        sections.push({ heading, body: body.join("\n").trim() });
      }
      heading = line.trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  if (heading !== null || body.join("\n").trim()) {
    sections.push({ heading, body: body.join("\n").trim() });
  }
  return sections.length ? sections : [{ heading: null, body: text.trim() }];
}

// Pack paragraphs into chunks ≤ CHUNK_SIZE words.
// Re-prepends heading when a section overflows into a new chunk (preserves context).
function packChunks(paragraphs, heading, source) {
  const chunks = [];
  const prefixWords = heading ? wordCount(heading) + 1 : 0;
  let current = [];
  let count = prefixWords;

  for (const para of paragraphs) {
    if (!para.trim()) continue;
    const pw = wordCount(para);

    // Single paragraph larger than limit — split by words as fallback
    if (pw > CHUNK_SIZE) {
      if (current.length) {
        chunks.push({ text: [heading, ...current].filter(Boolean).join("\n\n"), source });
        current = [];
        count = prefixWords;
      }
      const words = para.split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i += CHUNK_SIZE) {
        const slice = words.slice(i, i + CHUNK_SIZE).join(" ");
        chunks.push({ text: i === 0 && heading ? `${heading}\n\n${slice}` : slice, source });
      }
      continue;
    }

    if (count + pw > CHUNK_SIZE && current.length) {
      chunks.push({ text: [heading, ...current].filter(Boolean).join("\n\n"), source });
      current = [];
      count = prefixWords; // heading re-prepended for context
    }

    current.push(para);
    count += pw;
  }

  if (current.length) {
    chunks.push({ text: [heading, ...current].filter(Boolean).join("\n\n"), source });
  }

  return chunks;
}

// Split an OpenAPI spec into one chunk per endpoint path.
// Returns null if the file doesn't look like an OpenAPI spec.
function splitOpenApi(text, source) {
  try {
    const ext = sourceExt(source);
    let spec;
    if (ext === "json") {
      spec = JSON.parse(text);
    } else {
      // Minimal YAML parse: only handle simple key: value and nested blocks
      // Use JSON.parse as fallback after rough conversion — skip complex YAML
      return null;
    }

    // Must have openapi/swagger version and paths
    if ((!spec.openapi && !spec.swagger) || !spec.paths) return null;

    const chunks = [];
    const title = spec.info?.title || "API";
    const version = spec.info?.version || "";
    const header = `# ${title}${version ? ` v${version}` : ""}`;

    // One chunk per path (all methods combined)
    for (const [pathKey, pathItem] of Object.entries(spec.paths)) {
      const methods = ["get", "post", "put", "patch", "delete", "head", "options"]
        .filter(m => pathItem[m]);

      const lines = [`${header}\n\nEndpoint: ${pathKey}`];
      for (const method of methods) {
        const op = pathItem[method];
        const summary = op.summary || op.description || "";
        const opId = op.operationId || "";
        lines.push(`\n${method.toUpperCase()} ${pathKey}${opId ? ` (${opId})` : ""}${summary ? `\n${summary}` : ""}`);

        // Parameters
        const params = [...(pathItem.parameters || []), ...(op.parameters || [])];
        if (params.length) {
          lines.push("Parameters: " + params.map(p => `${p.name} (${p.in}${p.required ? ", required" : ""})`).join(", "));
        }

        // Request body schema summary
        const body = op.requestBody?.content?.["application/json"]?.schema;
        if (body?.$ref) lines.push(`Request body: ${body.$ref.split("/").pop()}`);

        // Response codes
        const codes = Object.keys(op.responses || {}).join(", ");
        if (codes) lines.push(`Responses: ${codes}`);
      }

      chunks.push({ text: lines.join("\n"), source });
    }

    return chunks.length > 1 ? chunks : null;
  } catch {
    return null;
  }
}

function chunkText(text, source) {
  if (!text || !text.trim()) return [];

  if (isMarkdown(source)) {
    const sections = splitMarkdownSections(text);
    const chunks = [];

    for (const { heading, body } of sections) {
      const paragraphs = body.split(/\n\n+/);
      const sectionChunks = packChunks(paragraphs, heading, source);
      // If a heading had no body, fold it into the next section's first chunk
      if (!sectionChunks.length && heading) continue;
      chunks.push(...sectionChunks);
    }

    if (chunks.length) return chunks;
  }

  // Code files — split on top-level declarations (functions, classes, impls)
  const codeBlocks = splitCodeBlocks(text, source);
  if (codeBlocks) {
    const chunks = packChunks(codeBlocks, null, source);
    if (chunks.length) return chunks;
  }

  // OpenAPI JSON/YAML — split per endpoint path
  const ext = sourceExt(source);
  if (ext === "json" || ext === "yaml" || ext === "yml") {
    const openApiChunks = splitOpenApi(text, source);
    if (openApiChunks) return openApiChunks;

    // Multi-document YAML (Kubernetes etc.) — split on --- separator
    if ((ext === "yaml" || ext === "yml") && text.includes("\n---")) {
      const docs = text.split(/\n---\s*\n/).filter(d => d.trim());
      if (docs.length > 1) {
        const chunks = packChunks(docs, null, source);
        if (chunks.length) return chunks;
      }
    }
  }

  // Plain text / JSON / other — split on blank lines
  const blocks = text.split(/\n\n+/);
  const chunks = packChunks(blocks, null, source);
  return chunks.length ? chunks : [{ text: text.slice(0, 200), source }];
}

// Returns all current sources with their mtimes and chunks
function collectSources() {
  const sources = [];

  listFiles(NOTES_PATH, ".md").forEach((f) => {
    sources.push({ key: `note:${path.basename(f)}`, sourcePrefix: `[note] ${path.basename(f)}`, file: f });
  });

  listFiles(DOCS_PATH, ".md").forEach((f) => {
    sources.push({ key: `doc:${path.basename(f)}`, sourcePrefix: `[doc] ${path.basename(f)}`, file: f });
  });

  listDirs(PROCESSED_PATH).forEach((repoDir) => {
    const repo = path.basename(repoDir);
    const contentsFile = path.join(repoDir, "file_contents.json");
    sources.push({ key: `repo:${repo}`, sourcePrefix: `[repo:${repo}]`, file: contentsFile, isRepo: true, repo });

    // Also embed repo overview and file tree for structural queries
    const overviewFile = path.join(repoDir, "overview.md");
    if (fs.existsSync(overviewFile)) {
      sources.push({ key: `repo-overview:${repo}`, sourcePrefix: `[repo:${repo}] _overview`, file: overviewFile, isRepoOverview: true, repo });
    }
    const codeMapFile = path.join(repoDir, "code_map.json");
    if (fs.existsSync(codeMapFile)) {
      sources.push({ key: `repo-files:${repo}`, sourcePrefix: `[repo:${repo}] _files`, file: codeMapFile, isRepoFiles: true, repo });
    }
  });

  return sources;
}

async function embedChunks(chunks, embedder, fileMtime = 0) {
  const results = [];
  for (const chunk of chunks) {
    const output = await embedder(chunk.text, { pooling: "mean", normalize: true });
    results.push({ source: chunk.source, text: chunk.text, vector: Array.from(output.data), mtime: chunk.mtime || fileMtime });
  }
  return results;
}

const LOCK_FILE = path.join(VECTOR_DB, ".embed.lock");

async function run() {
  ensureDir(VECTOR_DB);

  // Prevent concurrent embed runs corrupting the index
  if (fs.existsSync(LOCK_FILE)) {
    const lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
    if (lockAge < 30 * 60 * 1000) { // ignore stale locks older than 30 min
      console.error("⚠️  Another embed is already running. Wait for it to finish.\n");
      process.exit(1);
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  const releaseLock = () => { try { fs.unlinkSync(LOCK_FILE); } catch {} };
  process.on("exit", releaseLock);
  process.on("SIGINT", () => { releaseLock(); process.exit(1); });

  // Load existing index and manifest
  let index = [];
  let manifest = {};
  if (fs.existsSync(INDEX_FILE)) {
    try { index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8")); } catch {}
  }
  if (fs.existsSync(MANIFEST_FILE)) {
    try { manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf-8")); } catch {}
  }

  const sources = collectSources();
  const currentKeys = new Set(sources.map((s) => s.key));

  // Remove chunks for sources that no longer exist
  const removedKeys = Object.keys(manifest).filter((k) => !currentKeys.has(k));
  if (removedKeys.length) {
    for (const key of removedKeys) {
      const prefix = manifest[key].sourcePrefix;
      index = index.filter((e) => !e.source.startsWith(prefix));
      delete manifest[key];
      console.log(`  🗑  Removed: ${key}`);
    }
  }

  // Find changed or new sources
  const toEmbed = sources.filter((s) => {
    const fileMtime = mtime(s.file);
    return !manifest[s.key] || manifest[s.key].mtime !== fileMtime;
  });

  if (!toEmbed.length) {
    console.log("✅ Everything up to date — nothing to embed");
    return;
  }

  console.log("🔄 Loading embedding model...");
  const embedder = await pipeline("feature-extraction", "Xenova/all-mpnet-base-v2");
  console.log(`✅ Model ready\n`);
  console.log(`📚 ${toEmbed.length} source(s) changed, ${sources.length - toEmbed.length} unchanged\n`);

  let totalNew = 0;

  for (const source of toEmbed) {
    // Remove old chunks for this source
    index = index.filter((e) => !e.source.startsWith(source.sourcePrefix));

    // Build new chunks
    const chunks = [];
    const fileMtimeMs = mtime(source.file);

    if (source.isRepo) {
      const raw = safeRead(source.file);
      if (raw) {
        const files = JSON.parse(raw);
        Object.entries(files).forEach(([filepath, content]) => {
          if (content && content.trim()) {
            chunks.push(...chunkText(content, `[repo:${source.repo}] ${filepath}`));
          }
        });
      }
    } else if (source.isRepoOverview) {
      const content = safeRead(source.file);
      if (content) chunks.push(...chunkText(content, `[repo:${source.repo}] _overview`));
    } else if (source.isRepoFiles) {
      const raw = safeRead(source.file);
      if (raw) {
        // Flatten file tree into a readable list for embedding
        const tree = JSON.parse(raw);
        const lines = [`# File tree for ${source.repo}`];
        if (Array.isArray(tree)) {
          tree.forEach((entry) => {
            if (entry.path) lines.push(entry.type === "dir" ? `${entry.path}/` : entry.path);
          });
        }
        chunks.push({ text: lines.join("\n"), source: `[repo:${source.repo}] _files` });
      }
    } else {
      const content = safeRead(source.file);
      if (content) chunks.push(...chunkText(content, source.sourcePrefix));
    }

    if (!chunks.length) continue;

    process.stdout.write(`  Embedding ${source.key} (${chunks.length} chunks)...`);
    const embedded = await embedChunks(chunks, embedder, fileMtimeMs);
    index.push(...embedded);
    totalNew += embedded.length;

    manifest[source.key] = { mtime: mtime(source.file), sourcePrefix: source.sourcePrefix };
    console.log(" ✅");
  }

  fs.writeFileSync(INDEX_FILE, JSON.stringify(index), "utf-8");
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), "utf-8");

  // Rebuild BM25 meta over full index (needed for accurate IDF across all chunks)
  process.stdout.write("  Building BM25 index...");
  const bm25Meta = buildBM25Meta(index);
  fs.writeFileSync(BM25_FILE, JSON.stringify(bm25Meta), "utf-8");
  console.log(` ✅ (${Object.keys(bm25Meta.df).length.toLocaleString()} terms)`);

  console.log(`\n✅ Done — added ${totalNew} new chunks, index now has ${index.length} total`);

  // Auto-dedup to keep the index clean
  console.log();
  dedupIndex(p, { quiet: true });
}

run();
