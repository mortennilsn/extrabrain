// Shared AI helper — calls the Claude CLI (claude -p)
// Requires the Claude CLI to be installed and authenticated:
//   npm install -g @anthropic-ai/claude-code
//
// Claude Desktop and Claude Code users are already set up — nothing extra needed.

import { execSync, spawn } from "child_process";

function checkCLI() {
  try {
    execSync("which claude", { stdio: "pipe" });
  } catch {
    console.error("\n⚠️  Claude CLI not found.");
    console.error("   Install it: npm install -g @anthropic-ai/claude-code");
    console.error("   Then log in: claude\n");
    process.exit(1);
  }
}

/**
 * Single completion — returns the full response text.
 */
export async function complete(prompt, { maxBuffer = 10 * 1024 * 1024 } = {}) {
  checkCLI();
  return execSync("claude -p", {
    input: prompt,
    encoding: "utf-8",
    maxBuffer,
  }).trim();
}

/**
 * Streaming completion — prints each chunk as it arrives, returns full text.
 */
export function stream(prompt, onChunk) {
  checkCLI();
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["-p"], { stdio: ["pipe", "pipe", "pipe"] });
    proc.stdin.write(prompt, "utf-8");
    proc.stdin.end();

    let full = "";
    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      full += text;
      onChunk(text);
    });
    proc.stderr.on("data", () => {}); // suppress stderr
    proc.on("close", (code) => {
      if (code === 0) resolve(full);
      else reject(new Error(`claude exited with code ${code}`));
    });
  });
}
