// Persistent embedder daemon — loads Xenova once, serves vectors over HTTP
// Runs on localhost:7071
// Usage: node scripts/embedder-server.js
//        (started automatically by extrabrain watch)

import http from "http";
import { pipeline } from "@xenova/transformers";

const PORT    = 7071;
const MODEL   = "Xenova/all-mpnet-base-v2";
const PID_FILE = new URL("../.embedder.pid", import.meta.url).pathname;

import fs from "fs";
fs.writeFileSync(PID_FILE, String(process.pid));
const cleanup = () => { try { fs.unlinkSync(PID_FILE); } catch {} };
process.on("exit", cleanup);
process.on("SIGINT",  () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });

console.log(`🔄 Loading embedding model (${MODEL})...`);
const embedder = await pipeline("feature-extraction", MODEL);
console.log(`✅ Embedder ready on http://localhost:${PORT}\n`);

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/embed") {
    res.writeHead(404);
    res.end();
    return;
  }

  let body = "";
  req.on("data", d => { body += d; });
  req.on("end", async () => {
    try {
      const { text } = JSON.parse(body);
      if (!text) throw new Error("missing text");
      const output = await embedder(text, { pooling: "mean", normalize: true });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ vector: Array.from(output.data) }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT);
