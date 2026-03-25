// Shared auto-tagging utility
// Generates tags + summary via Claude and prepends YAML frontmatter to a markdown file.
// Only runs if content is >50 words (skips quick one-liners).
// Only runs on new files — skips if frontmatter already present.

import fs from "fs";
import { complete } from "./ai.js";

const MIN_WORDS = 50;

/**
 * Tag a markdown file in-place.
 * Reads the file, generates tags+summary, prepends frontmatter.
 * Silent on failure — never blocks the calling script.
 *
 * @param {string} filePath  Absolute path to the .md file
 */
export async function autotag(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");

    // Skip if frontmatter already present
    if (content.startsWith("---")) return;

    // Skip if too short to be worth tagging
    const wordCount = content.trim().split(/\s+/).length;
    if (wordCount < MIN_WORDS) return;

    const prompt = `Analyse this note and return ONLY a valid JSON object — no markdown, no explanation:

{
  "summary": "<1-2 sentence TL;DR of the key point>",
  "tags": ["<tag1>", "<tag2>", "<tag3>"]
}

Tags: 3-6 short lowercase topic words. Match the language of the note.

Note:
${content.slice(0, 3000)}`;

    const raw = (await complete(prompt, { maxTokens: 256 })).trim();

    const json = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "").trim();
    const { summary, tags } = JSON.parse(json);

    if (!tags?.length) return;

    const frontmatter = [
      "---",
      `tags: [${tags.join(", ")}]`,
      "---",
      "",
      summary ? `> ${summary}\n` : "",
    ].filter(s => s !== undefined).join("\n");

    fs.writeFileSync(filePath, frontmatter + content, "utf-8");
  } catch {
    // Silent — tagging is best-effort and should never break the calling script
  }
}
