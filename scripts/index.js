// MCP GitHub Extractor (Config-driven, multi-repo)
// Reads config/sources.json, scans repos (optionally), and builds MCP output

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { getPaths } from "./paths.js";
const _p = getPaths();
const CONFIG_PATH = _p.config;
const OUTPUT_PATH = _p.processed;

const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config at ${CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function isGitRepo(p) {
  return fs.existsSync(path.join(p, ".git"));
}

function listDirs(p) {
  return fs
    .readdirSync(p)
    .map((name) => path.join(p, name))
    .filter((p2) => fs.existsSync(p2) && fs.statSync(p2).isDirectory());
}

function resolveRepoPaths(config) {
  const repos = [];

  (config.repos || []).forEach((entry) => {
    if (typeof entry === "string") {
      // Direct path
      if (isGitRepo(entry)) {
        repos.push(entry);
      } else if (fs.existsSync(entry)) {
        // treat as folder, scan for repos
        listDirs(entry).forEach((sub) => {
          if (isGitRepo(sub)) repos.push(sub);
        });
      }
    } else if (entry && entry.path) {
      if (entry.scan) {
        listDirs(entry.path).forEach((sub) => {
          if (isGitRepo(sub)) repos.push(sub);
        });
      } else {
        if (isGitRepo(entry.path)) repos.push(entry.path);
      }
    }
  });

  const filter = config.repoNameFilter;
  if (filter) {
    const filters = Array.isArray(filter) ? filter : [filter];
    return repos.filter((r) =>
      filters.some((f) => path.basename(r).toLowerCase().includes(f.toLowerCase()))
    );
  }

  return repos;
}

function getRepoName(repoPath) {
  return path.basename(path.resolve(repoPath));
}

function readReadme(repoPath) {
  const readmePath = path.join(repoPath, "README.md");
  if (fs.existsSync(readmePath)) {
    return fs.readFileSync(readmePath, "utf-8");
  }
  return "No README found";
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".vitepress", ".nuxt", ".output", "coverage", "__pycache__"]);

const TEXT_EXTENSIONS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".cs", ".cpp", ".c", ".h", ".rb", ".php",
  ".html", ".css", ".scss", ".sass",
  ".json", ".yaml", ".yml", ".toml", ".xml",
  ".sh", ".bash", ".zsh",
  ".md", ".txt", ".sql", ".graphql", ".proto", ".env",
]);

const MAX_FILE_BYTES = 100 * 1024; // 100KB

function getFileTree(dir, base = "") {
  let results = [];
  const list = fs.readdirSync(dir);

  list.forEach((file) => {
    if (IGNORE_DIRS.has(file)) return;

    const fullPath = path.join(dir, file);
    const relPath = path.join(base, file);

    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        results.push({ type: "dir", path: relPath });
        results = results.concat(getFileTree(fullPath, relPath));
      } else {
        results.push({ type: "file", path: relPath });
      }
    } catch (e) {
      // ignore permission errors
    }
  });

  return results;
}

function getFileContents(dir, base = "", results = {}) {
  const list = fs.readdirSync(dir);

  list.forEach((file) => {
    if (IGNORE_DIRS.has(file)) return;

    const fullPath = path.join(dir, file);
    const relPath = path.join(base, file);
    const ext = path.extname(file).toLowerCase();

    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        getFileContents(fullPath, relPath, results);
      } else if (TEXT_EXTENSIONS.has(ext) && stat.size <= MAX_FILE_BYTES) {
        results[relPath] = fs.readFileSync(fullPath, "utf-8");
      }
    } catch (e) {
      // ignore permission errors or binary read failures
    }
  });

  return results;
}

function getGitCommits(repoPath) {
  try {
    const output = execSync(
      'git log --pretty=format:"%H|%an|%ad|%s" --date=iso',
      { cwd: repoPath }
    ).toString();

    return output.split("\n").map((line) => {
      const [hash, author, date, message] = line.split("|");
      return { hash, author, date, message };
    });
  } catch (err) {
    return [];
  }
}

function generateOverview(readme, repoName) {
  return `# Overview: ${repoName}\n\n${readme.slice(0, 2000)}\n`;
}

function processRepo(repoPath) {
  const repoName = getRepoName(repoPath);
  const repoOutput = path.join(OUTPUT_PATH, repoName);

  ensureDir(repoOutput);

  console.log(`📦 Processing repo: ${repoName}`);

  // README → overview
  const readme = readReadme(repoPath);
  fs.writeFileSync(
    path.join(repoOutput, "overview.md"),
    generateOverview(readme, repoName)
  );

  // File tree → code_map
  const tree = getFileTree(repoPath);
  fs.writeFileSync(
    path.join(repoOutput, "code_map.json"),
    JSON.stringify(tree, null, 2)
  );

  // Commits
  const commits = getGitCommits(repoPath);
  fs.writeFileSync(
    path.join(repoOutput, "commits.json"),
    JSON.stringify(commits, null, 2)
  );

  // File contents
  const contents = getFileContents(repoPath);
  const fileCount = Object.keys(contents).length;
  if (fileCount > 2000) {
    console.log(yellow(`  ⚠️  ${repoName}: ${fileCount} files — large repo, indexing may be slow. Use repoNameFilter in sources.json to limit scope.`));
  }
  fs.writeFileSync(
    path.join(repoOutput, "file_contents.json"),
    JSON.stringify(contents, null, 2)
  );
  console.log(`   📄 Indexed ${fileCount} file(s)`);
}

function run() {
  ensureDir(OUTPUT_PATH);

  const config = readConfig();
  const repos = resolveRepoPaths(config);

  if (!repos.length) {
    console.log("⚠️ No repositories found from config");
    return;
  }

  console.log(`🔎 Found ${repos.length} repo(s)`);

  repos.forEach((repoPath) => {
    processRepo(repoPath);
  });

  console.log("✅ MCP extraction complete");
}

run();
