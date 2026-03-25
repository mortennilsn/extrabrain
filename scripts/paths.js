// Central workspace path resolver — imported by all scripts
// Data directory: $EXTRABRAIN_DIR or ~/.extrabrain (never the code dir)

import fs from "fs";
import path from "path";
import os from "os";

export const BRAIN_ROOT = process.env.EXTRABRAIN_DIR || path.join(os.homedir(), ".extrabrain");

const WS_FILE = path.join(BRAIN_ROOT, ".workspace");

export function getActiveWorkspace() {
  try { return fs.readFileSync(WS_FILE, "utf-8").trim() || "default"; } catch { return "default"; }
}

export function setActiveWorkspace(name) {
  fs.writeFileSync(WS_FILE, name, "utf-8");
}

export function workspaceDir(name) {
  return path.join(BRAIN_ROOT, "workspaces", name);
}

export function listWorkspaces() {
  const dir = path.join(BRAIN_ROOT, "workspaces");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isDirectory());
}

export function getPaths(name = null) {
  const ws = name || getActiveWorkspace();
  const base = workspaceDir(ws);
  return {
    ws,
    base,
    sources:   path.join(base, "sources"),
    notes:     path.join(base, "sources", "notes"),
    docs:      path.join(base, "sources", "docs"),
    inbox:     path.join(base, "sources", "inbox"),
    processed: path.join(base, "processed"),
    vectorDb:  path.join(base, "vector-db"),
    index:     path.join(base, "vector-db", "index.json"),
    manifest:  path.join(base, "vector-db", "manifest.json"),
    config:    path.join(base, "config", "sources.json"),
  };
}
