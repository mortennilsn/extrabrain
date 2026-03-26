# extrabrain

A local-first, AI-powered knowledge base CLI. Capture notes, documents, and code repositories — then search and ask questions using Claude as the reasoning engine.

All data stays on your machine. AI features run through the Claude CLI — if you have Claude Desktop or Claude Code installed, you're already set up.

---

## How it works

```
Sources (notes, docs, repos, URLs)
        ↓
   Chunked + embedded locally (all-mpnet-base-v2 via Xenova)
        ↓
   Hybrid search index (BM25 + cosine similarity)
        ↓
   Claude answers questions using retrieved context
        ↓
   Exposed as MCP tools to Claude Desktop / Claude Code
```

---

## Requirements

- **Node.js** 18+
- **Claude CLI** — `npm install -g @anthropic-ai/claude-code`

> Already using **Claude Desktop** or **Claude Code**? You're already set up — no extra steps needed.

---

## Installation

```bash
git clone https://github.com/mortennilsen/extrabrain
cd extrabrain
npm install
alias extrabrain="$(pwd)/extrabrain"
extrabrain init
```

`init` will walk you through adding repo paths and running your first sync.

Data is stored at `~/.extrabrain` (override with `$EXTRABRAIN_DIR`).

> **npm package coming soon** — `npm install -g extrabrain` will work once published.

---

## Quick start

```bash
# Save a quick note
extrabrain note "Decided to move auth to JWT tokens"

# Save a webpage
extrabrain save "https://docs.example.com/api"

# Add files to inbox and convert them
extrabrain add report.pdf design.xlsx
extrabrain convert

# Index your code repos, then build the vector index
extrabrain sync

# Ask a question
extrabrain ask "what auth approach are we using?"

# Generate a briefing before a meeting
extrabrain brief "API migration"

# Draft a document using your brain as context
extrabrain draft "write a proposal for moving to Kafka"
```

---

## Commands

### Capture

| Command | Description |
|---|---|
| `extrabrain note "text"` | Save a timestamped note |
| `extrabrain clip` | Save clipboard content as a note |
| `extrabrain save "https://..."` | Fetch a webpage and save as markdown |
| `extrabrain add <files>` | Copy files into the inbox |
| `extrabrain convert` | Convert inbox files (PDF, CSV, XLSX, HTML, EML) to markdown |
| `extrabrain scrape "https://..."` | Crawl an entire website and save all pages |
| `extrabrain meeting "title"` | Create a structured meeting note |

### Recall

| Command | Description |
|---|---|
| `extrabrain ask "question"` | Ask the brain — Claude answers using your content |
| `extrabrain search "query"` | Keyword + semantic search |
| `extrabrain brief "topic"` | Generate an intelligence briefing on a topic |
| `extrabrain draft "write X"` | Draft a doc (email, proposal, report) using brain as context |
| `extrabrain actions` | Extract action items from recent notes |
| `extrabrain digest` | Weekly summary of everything captured |
| `extrabrain recent` | Show recently added content |
| `extrabrain pull` | Run configured external connectors (Slack, Jira, custom APIs) |

### Maintain

| Command | Description |
|---|---|
| `extrabrain sync` | Re-index repos + rebuild vector search |
| `extrabrain embed` | Rebuild vector index only |
| `extrabrain retag` | Add AI-generated tags to untagged notes and docs |
| `extrabrain dedup` | Remove duplicate chunks from the vector index |
| `extrabrain cleanup` | Preview and strip boilerplate from scraped docs |
| `extrabrain fix-pdf` | Fix spacing artifacts from PDF conversion |

### System

| Command | Description |
|---|---|
| `extrabrain watch` | Start file watcher — auto-embeds on changes |
| `extrabrain embedder` | Start the embedder daemon for instant search |
| `extrabrain status` | Show what's in the brain |
| `extrabrain workspace` | Manage workspaces (create / use / list) |
| `extrabrain feedback` | Review verified Q&As and MCP audit log |

---

## Data directory structure

```
~/.extrabrain/
├── .workspace              # active workspace name
└── workspaces/
    └── default/
        ├── config/
        │   ├── sources.json    # repo paths to index
        │   └── pull.json       # external connector config
        ├── sources/
        │   ├── notes/          # markdown notes
        │   ├── docs/           # converted documents
        │   └── inbox/          # drop files here before convert
        ├── processed/          # indexed repo content (JSON)
        └── vector-db/
            ├── index.json      # vector embeddings
            ├── bm25.json       # keyword search index
            └── manifest.json   # tracks which files are embedded
```

The code directory and data directory are fully separate. You can store data anywhere by setting `EXTRABRAIN_DIR`:

```bash
export EXTRABRAIN_DIR=/your/custom/path
```

---

## Indexing code repositories

Edit `~/.extrabrain/workspaces/<name>/config/sources.json`:

```json
{
  "repos": [
    "/path/to/your/repos"
  ],
  "scan": true,
  "repoNameFilter": ["my-api", "frontend"]
}
```

- `repos` — array of paths. Can be individual repo dirs or a parent dir containing multiple repos.
- `scan: true` — scans the folder for all git repos instead of treating it as a single repo.
- `repoNameFilter` — optional allowlist of repo names. Empty array = include all.

Then run:

```bash
extrabrain sync
```

This extracts README overviews, file trees, commit history, and file contents into `processed/`, then builds the vector index.

---

## Pull connectors

`extrabrain pull` calls Claude with MCP tools to fetch data from external sources and save the results as notes.

Edit `~/.extrabrain/workspaces/<name>/config/pull.json`:

```json
{
  "connectors": [
    {
      "name": "slack-standup",
      "description": "Fetch standup messages from Slack",
      "enabled": true,
      "tags": ["slack", "standup"],
      "tools": "mcp__claude_ai_Slack__slack_read_channel",
      "prompt": "Read the #standup channel (channel ID: C0123456789) and summarize all messages from {{cutoff}} to {{date}}. List key updates, blockers, and decisions. Date: {{date}}"
    }
  ]
}
```

Prompt variables: `{{date}}` (today), `{{cutoff}}` (N days ago), `{{days}}` (the `--days` flag value).

Run:

```bash
extrabrain pull                  # run all enabled connectors
extrabrain pull --only slack-standup
extrabrain pull --days 7         # look back 7 days
extrabrain pull --dry-run        # preview without saving
```

Any MCP tool available in your Claude CLI environment can be used in a connector's `tools` field.

---

## MCP server

Expose your brain as tools to Claude Desktop or Claude Code:

```bash
node server/index.js
```

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "extrabrain": {
      "command": "node",
      "args": ["/path/to/extrabrain/server/index.js"]
    }
  }
}
```

### Available MCP tools

| Tool | Description |
|---|---|
| `search` | Hybrid search across the brain |
| `add_note` | Save a note directly from Claude |
| `read_doc` | Fetch full content of a document |
| `read_note` | Fetch full content of a note |
| `list_docs` | List all documents |
| `list_notes` | List all notes |
| `get_file_content` | Read a specific source file |
| `list_repos` | List indexed repositories |
| `get_repo_overview` | Get the README/overview for a repo |
| `get_repo_files` | Get the file tree for a repo |
| `get_repo_commits` | Get commit history for a repo |
| `search_diagrams` | Find Mermaid diagrams in the brain |
| `list_workspaces` | List all workspaces |
| `switch_workspace` | Switch the active workspace |

---

## Workspaces

Workspaces let you maintain separate knowledge bases — e.g. one per project or client.

```bash
extrabrain workspace create work
extrabrain workspace use work
extrabrain workspace list
```

Each workspace has its own notes, docs, repos, and vector index. The MCP server is workspace-aware and supports cross-workspace search.

---

## Embedder daemon

The embedder loads the `all-mpnet-base-v2` model once and keeps it in memory, making repeated `ask` and `search` calls much faster:

```bash
extrabrain watch        # starts both the file watcher and embedder
extrabrain embedder     # start embedder alone
extrabrain embedder stop
```

Without the daemon, the model loads fresh on each call (~2–5s cold start). The daemon brings this down to ~50ms.

The embedder runs on `localhost:7071` and is used automatically by `ask`, `search`, `brief`, and `draft`.

---

## Architecture notes

### Embedding

Uses [`Xenova/all-mpnet-base-v2`](https://huggingface.co/sentence-transformers/all-mpnet-base-v2) via `@xenova/transformers` — runs fully locally, no API calls for embedding.

Chunking strategy:
- **Markdown** — split on h1–h3 headings, packed to ~400 words
- **Code** — split on top-level TypeScript/Rust declarations
- **OpenAPI** — one chunk per endpoint
- **YAML** — split on `---` separators

### Search

Hybrid BM25 + cosine similarity. Scores are combined with a weighted sum. `search` and `ask` both use this pipeline. Results include a relevance score and source label (`[note]`, `[doc]`, or `[repo:name]`).

### Claude integration

All AI features call `claude -p` (Claude CLI in print mode) via the shared `scripts/ai.js` helper. This means any user with Claude Desktop or Claude Code installed is immediately ready — no API key setup required. Streaming is used for `ask` and `draft` so responses appear as they're generated.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `EXTRABRAIN_DIR` | `~/.extrabrain` | Data directory |
| `EXTRABRAIN_CODE` | script directory | Code directory (set automatically by the shell script) |
