// mcp-brain MCP server
// Exposes notes, docs, and processed repo data as MCP tools for Claude

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { getPaths, getActiveWorkspace, setActiveWorkspace, listWorkspaces, BRAIN_ROOT } from "../scripts/paths.js";
import { hybridSearch } from "../scripts/hybrid-search.js";
import { embedQuery } from "../scripts/embed-query.js";

// Paths are read fresh per request so switching workspace takes effect immediately
function p() { return getPaths(); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── In-memory cache ───────────────────────────────────────────────────────────

let vectorIndex  = null;
let bm25Meta     = null;
let indexMtime   = 0;

function getVectorIndex() {
  const { index, vectorDb } = p();
  if (!fs.existsSync(index)) return null;

  // Invalidate cache if index.json has been updated since last load
  const currentMtime = fs.statSync(index).mtimeMs;
  if (currentMtime !== indexMtime) {
    vectorIndex = null;
    bm25Meta    = null;
    indexMtime  = currentMtime;
  }

  if (!vectorIndex) {
    vectorIndex = JSON.parse(fs.readFileSync(index, "utf-8"));
    const bm25Path = path.join(vectorDb, "bm25.json");
    bm25Meta = fs.existsSync(bm25Path)
      ? JSON.parse(fs.readFileSync(bm25Path, "utf-8"))
      : { N: vectorIndex.length, avgdl: 100, df: {} };
  }
  return vectorIndex;
}

// Pre-warm index at startup
getVectorIndex();

// ── Audit log ─────────────────────────────────────────────────────────────────

const AUDIT_LOG = path.join(BRAIN_ROOT, ".mcp-audit.log");

function auditLog(tool, summary) {
  const line = JSON.stringify({
    ts:   new Date().toISOString(),
    tool,
    summary,
  }) + "\n";
  try { fs.appendFileSync(AUDIT_LOG, line, "utf-8"); } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function safeRead(filePath) {
  try { return fs.readFileSync(filePath, "utf-8"); } catch { return null; }
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
}

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isDirectory());
}

function pad(n) { return String(n).padStart(2, "0"); }
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function datetimeHeader() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "mcp-brain", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search",
      description: `Search the personal knowledge base using natural language or keywords.
Searches across notes, docs (PDFs, CSVs, spreadsheets), and repo source code.
Use for questions about decisions, architecture, APIs, data models, meetings, or any knowledge-base content.
Do NOT use this for listing repos, browsing file trees, or getting repo overviews — use list_repos, get_repo_files, get_repo_overview instead.
Returns ranked results with source location and a text preview. Follow up with read_doc, read_note, or get_file_content to get full content.`,
      inputSchema: {
        type: "object",
        properties: {
          query:     { type: "string", description: "What you're looking for — natural language works best" },
          limit:     { type: "number", description: "Number of results (default 8)" },
          workspace: { type: "string", description: "Workspace to search in (e.g. 'work', 'personal'). Use 'all' to search across every workspace. Defaults to active workspace." },
        },
        required: ["query"],
      },
    },
    {
      name: "list_workspaces",
      description: "List all available workspaces in the brain, showing which one is currently active.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "switch_workspace",
      description: "Switch the active workspace. All subsequent tool calls will use the new workspace until switched again.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Workspace name to switch to (e.g. 'work', 'personal')" },
        },
        required: ["name"],
      },
    },
    {
      name: "add_note",
      description: `Save a note to the knowledge base. Use this when the user says things like "remember this", "make a note", "save this", or "note that...".
Notes are stored with a timestamp and are immediately searchable.`,
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The note content to save" },
          title: { type: "string", description: "Optional title for the note" },
        },
        required: ["text"],
      },
    },
    {
      name: "read_doc",
      description: "Read the full content of a document from the knowledge base. Use after search() returns a [doc] result you need to read in full.",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Document filename (e.g. api-design-notes.md)" },
        },
        required: ["filename"],
      },
    },
    {
      name: "read_note",
      description: "Read the full content of a note from the knowledge base. Use after search() returns a [note] result you need to read in full.",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Note filename" },
        },
        required: ["filename"],
      },
    },
    {
      name: "get_file_content",
      description: "Read the full content of a specific source code file from a repo. Use after search() returns a [repo:name] result, or when you need to inspect a specific file.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Repository name (e.g. my-api)" },
          filepath: { type: "string", description: "Relative file path (e.g. src/index.js)" },
        },
        required: ["repo", "filepath"],
      },
    },
    {
      name: "list_repos",
      description: "List all repositories indexed in the brain. Use this first when the user asks which repos exist, what projects are tracked, or anything about repo names.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_repo_overview",
      description: "Get the README and overview for a specific repository. Use when the user asks what a repo does, its purpose, tech stack, or wants a summary of a specific project.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Repository name" },
        },
        required: ["name"],
      },
    },
    {
      name: "get_repo_files",
      description: "Get the full file tree for a repository. Use when the user asks to see files in a repo, browse the structure, or find where something is located in the codebase.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Repository name" },
        },
        required: ["name"],
      },
    },
    {
      name: "get_repo_commits",
      description: "Get recent git commit history for a repository. Useful for understanding recent changes or activity.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Repository name" },
          limit: { type: "number", description: "Max commits to return (default 20)" },
        },
        required: ["name"],
      },
    },
    {
      name: "list_docs",
      description: "List all documents in the knowledge base. Includes converted PDFs, CSVs, spreadsheets, and HTML files.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_notes",
      description: "List all notes in the knowledge base.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "search_diagrams",
      description: "Find Mermaid diagrams in the knowledge base. Returns raw mermaid code blocks with source context. Use when the user asks to see architecture diagrams, flow diagrams, data flows, or anything visual.",
      inputSchema: {
        type: "object",
        properties: {
          query:     { type: "string", description: "Keyword to filter diagrams by title, source, or diagram content. Omit to return all." },
          workspace: { type: "string", description: "Workspace to search ('work', 'personal', 'all'). Defaults to active workspace." },
          limit:     { type: "number", description: "Max diagrams to return (default 10)" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {

    case "list_workspaces": {
      const all    = listWorkspaces();
      const active = getActiveWorkspace();
      const lines  = all.map(w => w === active ? `${w} (active)` : w);
      return { content: [{ type: "text", text: lines.join("\n") || "No workspaces found." }] };
    }

    case "switch_workspace": {
      const all = listWorkspaces();
      if (!all.includes(args.name)) {
        return { content: [{ type: "text", text: `Workspace "${args.name}" not found. Available: ${all.join(", ")}` }] };
      }
      setActiveWorkspace(args.name);
      vectorIndex = null;
      bm25Meta    = null;
      return { content: [{ type: "text", text: `Switched to workspace: ${args.name}` }] };
    }

    case "search": {
      const query = args.query;
      const limit = args.limit || 8;
      const results = [];

      // Cross-workspace search — query all workspaces, merge by score
      if (args.workspace === "all") {
        const allWorkspaces = listWorkspaces();
        const queryVec = await embedQuery(query);
        const merged = [];
        for (const ws of allWorkspaces) {
          const wsPaths = getPaths(ws);
          if (!fs.existsSync(wsPaths.index)) continue;
          const idx = JSON.parse(fs.readFileSync(wsPaths.index, "utf-8"));
          const bm25Path = path.join(wsPaths.vectorDb, "bm25.json");
          const meta = fs.existsSync(bm25Path)
            ? JSON.parse(fs.readFileSync(bm25Path, "utf-8"))
            : { N: idx.length, avgdl: 100, df: {} };
          const hits = hybridSearch(query, queryVec, idx, meta, { top: limit, threshold: 0.1 });
          hits.forEach(r => merged.push({ ...r, ws }));
        }
        merged.sort((a, b) => b.score - a.score);
        const top = merged.slice(0, limit);
        if (!top.length) return { content: [{ type: "text", text: `Nothing relevant found for: "${query}" across any workspace.` }] };
        top.forEach((r) => results.push(`[${r.score.toFixed(3)}] [ws:${r.ws}] ${r.source}\n${r.text.slice(0, 300)}`));
        return { content: [{ type: "text", text: results.join("\n\n---\n\n") }] };
      }

      const searchPaths = args.workspace ? getPaths(args.workspace) : p();
      const index = (() => {
        if (!fs.existsSync(searchPaths.index)) return null;
        const currentMtime = fs.statSync(searchPaths.index).mtimeMs;
        if (!args.workspace) {
          if (currentMtime !== indexMtime) { vectorIndex = null; bm25Meta = null; indexMtime = currentMtime; }
          if (!vectorIndex) {
            vectorIndex = JSON.parse(fs.readFileSync(searchPaths.index, "utf-8"));
            const bm25Path = path.join(searchPaths.vectorDb, "bm25.json");
            bm25Meta = fs.existsSync(bm25Path) ? JSON.parse(fs.readFileSync(bm25Path, "utf-8")) : { N: vectorIndex.length, avgdl: 100, df: {} };
          }
          return vectorIndex;
        }
        // Specific workspace — load fresh, don't cache
        const idx = JSON.parse(fs.readFileSync(searchPaths.index, "utf-8"));
        const bm25Path = path.join(searchPaths.vectorDb, "bm25.json");
        bm25Meta = fs.existsSync(bm25Path) ? JSON.parse(fs.readFileSync(bm25Path, "utf-8")) : { N: idx.length, avgdl: 100, df: {} };
        return idx;
      })();

      // Semantic search (if index available)
      if (index) {
        const queryVec = await embedQuery(query);
        const top = hybridSearch(query, queryVec, index, bm25Meta, { top: limit, threshold: 0.1 });
        if (!top.length) return { content: [{ type: "text", text: `Nothing relevant found for: "${query}". Try different wording or run \`extrabrain sync\` if content was recently added.` }] };
        top.forEach((r) => results.push(`[${r.score.toFixed(3)}] ${r.source}\n${r.text.slice(0, 300)}`));
      } else {
        // Fallback: keyword search
        const { notes: np, docs: dp, processed: pp } = searchPaths;
        const q = query.toLowerCase();
        listFiles(np).forEach((f) => {
          const c = safeRead(path.join(np, f));
          if (c?.toLowerCase().includes(q)) results.push(`[note] ${f}`);
        });
        listFiles(dp).forEach((f) => {
          const c = safeRead(path.join(dp, f));
          if (c?.toLowerCase().includes(q)) results.push(`[doc] ${f}`);
        });
        listDirs(pp).forEach((repo) => {
          const raw = safeRead(path.join(pp, repo, "file_contents.json"));
          if (raw) {
            Object.entries(JSON.parse(raw)).forEach(([fp, c]) => {
              if (c?.toLowerCase().includes(q)) results.push(`[repo:${repo}] ${fp}`);
            });
          }
        });
        if (!results.length) return { content: [{ type: "text", text: `No results for: "${query}". Try running \`extrabrain embed\` to build the vector index.` }] };
      }

      return { content: [{ type: "text", text: results.join("\n\n---\n\n") || `No results for: "${query}"` }] };
    }

    case "add_note": {
      const { notes: np } = p();
      if (!fs.existsSync(np)) fs.mkdirSync(np, { recursive: true });
      const title = args.title || null;
      const slug = title
        ? title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
        : "note";
      const filename = `${timestamp()}-${slug}.md`;
      const filePath = path.join(np, filename);
      const header = title ? `# ${title}\n_${datetimeHeader()}_\n\n` : `# Note — ${datetimeHeader()}\n\n`;
      const content = fs.existsSync(filePath)
        ? `\n---\n_${datetimeHeader()}_\n\n${args.text}\n`
        : `${header}${args.text}\n`;
      fs.appendFileSync(filePath, content, "utf-8");
      auditLog("add_note", `${filename} — "${args.text.slice(0, 100).replace(/\n/g, " ")}${args.text.length > 100 ? "…" : ""}"`);
      vectorIndex = null;
      bm25Meta    = null;
      // Trigger incremental embed in the background — skip if one is already running
      const lockFile = path.join(p().vectorDb, ".embed.lock");
      const alreadyRunning = fs.existsSync(lockFile) && (() => {
        const lockAge = Date.now() - fs.statSync(lockFile).mtimeMs;
        return lockAge < 30 * 60 * 1000;
      })();
      if (!alreadyRunning) {
        const embedProc = spawn("node", [path.join(BRAIN_ROOT, "scripts/embed.js")], {
          detached: true,
          stdio: "ignore",
          cwd: BRAIN_ROOT,
        });
        embedProc.unref();
      }
      const embedMsg = alreadyRunning
        ? "Embed already running — note will be indexed when it finishes."
        : "Embedding in background — searchable in a few seconds.";
      return { content: [{ type: "text", text: `✅ Note saved → ${filename}\n\n${embedMsg}` }] };
    }

    case "read_doc": {
      const filePath = path.join(p().docs, path.basename(args.filename));
      const content = safeRead(filePath);
      if (!content) return { content: [{ type: "text", text: `Doc not found: ${args.filename}` }] };
      return { content: [{ type: "text", text: content }] };
    }

    case "read_note": {
      const filePath = path.join(p().notes, path.basename(args.filename));
      const content = safeRead(filePath);
      if (!content) return { content: [{ type: "text", text: `Note not found: ${args.filename}` }] };
      return { content: [{ type: "text", text: content }] };
    }

    case "get_file_content": {
      const contentsPath = path.join(p().processed, args.repo, "file_contents.json");
      const raw = safeRead(contentsPath);
      if (!raw) return { content: [{ type: "text", text: `No file contents indexed for repo: ${args.repo}. Run \`extrabrain sync\`.` }] };
      const contents = JSON.parse(raw);
      const normalised = args.filepath.replace(/\\/g, "/");
      const match = Object.entries(contents).find(([k]) => k.replace(/\\/g, "/") === normalised);
      if (!match) return { content: [{ type: "text", text: `File not found in index: ${args.filepath}` }] };
      return { content: [{ type: "text", text: match[1] }] };
    }

    case "list_repos": {
      const repos = listDirs(p().processed);
      if (!repos.length) return { content: [{ type: "text", text: "No repos indexed. Run `extrabrain sync`." }] };
      return { content: [{ type: "text", text: repos.join("\n") }] };
    }

    case "get_repo_overview": {
      const content = safeRead(path.join(p().processed, args.name, "overview.md"));
      if (!content) return { content: [{ type: "text", text: `No overview found for: ${args.name}` }] };
      return { content: [{ type: "text", text: content }] };
    }

    case "get_repo_files": {
      const content = safeRead(path.join(p().processed, args.name, "code_map.json"));
      if (!content) return { content: [{ type: "text", text: `No file tree found for: ${args.name}` }] };
      return { content: [{ type: "text", text: content }] };
    }

    case "get_repo_commits": {
      const content = safeRead(path.join(p().processed, args.name, "commits.json"));
      if (!content) return { content: [{ type: "text", text: `No commits found for: ${args.name}` }] };
      const commits = JSON.parse(content);
      return { content: [{ type: "text", text: JSON.stringify(commits.slice(0, args.limit || 20), null, 2) }] };
    }

    case "list_docs": {
      const files = listFiles(p().docs);
      if (!files.length) return { content: [{ type: "text", text: "No docs found. Drop files in sources/inbox/ and run `extrabrain convert`." }] };
      return { content: [{ type: "text", text: files.join("\n") }] };
    }

    case "list_notes": {
      const files = listFiles(p().notes);
      if (!files.length) return { content: [{ type: "text", text: "No notes yet. Use add_note or run `extrabrain note \"text\"`." }] };
      return { content: [{ type: "text", text: files.join("\n") }] };
    }

    case "search_diagrams": {
      const query = (args.query || "").toLowerCase().trim();
      const limit = args.limit || 10;

      function extractDiagrams(text, sourceName) {
        const results = [];
        const lines   = text.split("\n");
        let inBlock   = false, block = [], heading = null;
        for (const line of lines) {
          if (!inBlock && /^#{1,4}\s/.test(line)) heading = line.replace(/^#+\s*/, "").trim();
          if (!inBlock && /^```mermaid\s*$/i.test(line.trim())) { inBlock = true; block = []; }
          else if (inBlock && /^```\s*$/.test(line.trim())) {
            inBlock = false;
            const code = block.join("\n").trim();
            if (code) results.push({ source: sourceName, heading, code });
          } else if (inBlock) { block.push(line); }
        }
        return results;
      }

      function collectDiagrams(paths) {
        const diagrams = [];
        listFiles(paths.notes).forEach(f => diagrams.push(...extractDiagrams(safeRead(path.join(paths.notes, f)) || "", `[note] ${f}`)));
        listFiles(paths.docs).forEach(f =>  diagrams.push(...extractDiagrams(safeRead(path.join(paths.docs, f)) || "", `[doc] ${f}`)));
        listDirs(paths.processed).forEach(repo => {
          const raw = safeRead(path.join(paths.processed, repo, "file_contents.json"));
          if (!raw) return;
          try {
            for (const [fp, content] of Object.entries(JSON.parse(raw))) {
              if (content && /\.(md|mdx)$/i.test(fp))
                diagrams.push(...extractDiagrams(content, `[repo:${repo}] ${fp}`));
            }
          } catch {}
        });
        return diagrams;
      }

      let diagrams = [];
      if (args.workspace === "all") {
        for (const ws of listWorkspaces()) {
          collectDiagrams(getPaths(ws)).forEach(d => diagrams.push({ ...d, ws }));
        }
      } else {
        const sp = args.workspace ? getPaths(args.workspace) : p();
        collectDiagrams(sp).forEach(d => diagrams.push({ ...d, ws: sp.ws }));
      }

      if (query) {
        diagrams = diagrams.filter(d =>
          d.source.toLowerCase().includes(query) ||
          (d.heading || "").toLowerCase().includes(query) ||
          d.code.toLowerCase().includes(query)
        );
      }

      if (!diagrams.length) return { content: [{ type: "text", text: `No Mermaid diagrams found${query ? ` for: "${args.query}"` : ""}.` }] };

      const out = diagrams.slice(0, limit).map(d => {
        const label = [d.ws !== p().ws ? `[${d.ws}]` : null, d.source, d.heading ? `— ${d.heading}` : null].filter(Boolean).join(" ");
        return `**${label}**\n\`\`\`mermaid\n${d.code}\n\`\`\``;
      });

      return { content: [{ type: "text", text: out.join("\n\n---\n\n") }] };
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
