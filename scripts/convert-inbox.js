// Convert PDFs and CSVs in sources/inbox/ to markdown files in sources/docs/
// Processed files are moved to sources/inbox/processed/
//
// Usage:
//   npm run convert        — fast local conversion (no AI)
//   npm run convert -- --ai  — use Claude for better quality (slower)

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { parse } from "csv-parse/sync";
import { complete } from "./ai.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { NodeHtmlMarkdown } from "node-html-markdown";
import ExcelJS from "exceljs";
import { simpleParser } from "mailparser";

import { getPaths } from "./paths.js";
const _p = getPaths();
const INBOX     = _p.inbox;
const PROCESSED = path.join(_p.inbox, "processed");
const DOCS_OUT  = _p.docs;
const SUPPORTED = new Set([".pdf", ".csv", ".html", ".htm", ".xlsx", ".xls", ".eml"]);
const useAI = process.argv.includes("--ai");
const SUMMARY_THRESHOLD = 500; // words — docs longer than this get a search summary

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function yamlEscape(v) {
  if (typeof v !== "string") return v;
  // Quote if value contains YAML-special characters or leading/trailing spaces
  if (/[:#\[\]{},|>&*!?]/.test(v) || v !== v.trim() || v === "") {
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return v;
}

function buildFrontmatter(fields) {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${yamlEscape(String(v))}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

function hashFile(filePath) {
  return crypto.createHash("md5").update(fs.readFileSync(filePath)).digest("hex");
}

function existingHash(mdPath) {
  try {
    const firstLine = fs.readFileSync(mdPath, "utf-8").slice(0, 500);
    const m = firstLine.match(/^source_hash:\s*(\S+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// ── Local converters ──────────────────────────────────────────────────────────

function parsePdfDate(raw) {
  // PDF date format: D:YYYYMMDDHHmmSSOHH'mm  e.g. D:20240315143022+02'00
  if (!raw) return null;
  const m = raw.replace(/^D:/, "").match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

async function localPdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  const pdf = await getDocument({ data: new Uint8Array(buffer) }).promise;

  // Extract document metadata
  const { info } = await pdf.getMetadata().catch(() => ({ info: {} }));
  const extra = {};
  if (info.Title?.trim())    extra.pdf_title  = info.Title.trim();
  if (info.Author?.trim())   extra.pdf_author = info.Author.trim();
  const created = parsePdfDate(info.CreationDate);
  if (created) extra.pdf_created = created;

  const pageTexts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str).join(" ");
    pageTexts.push(text);
  }
  await pdf.destroy();

  const content = `# ${path.basename(filePath, ".pdf")}\n\n${pageTexts.join("\n\n").trim()}\n`;
  return { content, extra };
}

function localCsv(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const rows = parse(content, { skip_empty_lines: true });
  if (!rows.length) return "";

  const [header, ...body] = rows;
  const separator = header.map(() => "---").join(" | ");
  const headerRow = header.join(" | ");
  const bodyRows = body.map((r) => r.join(" | ")).join("\n");

  return `# ${path.basename(filePath, ".csv")}\n\n| ${headerRow} |\n| ${separator} |\n| ${bodyRows.split("\n").join(" |\n| ")} |\n`;
}

async function localXlsx(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sections = workbook.worksheets.map((sheet) => {
    const rows = [];
    sheet.eachRow((row) => {
      rows.push(row.values.slice(1).map((v) => (v == null ? "" : String(v))));
    });
    if (!rows.length) return `## ${sheet.name}\n\n_Empty sheet_`;
    const [header, ...body] = rows;
    const separator = header.map(() => "---").join(" | ");
    const headerRow = `| ${header.join(" | ")} |`;
    const bodyRows = body.map((r) => `| ${r.join(" | ")} |`).join("\n");
    return `## ${sheet.name}\n\n${headerRow}\n| ${separator} |\n${bodyRows}`;
  });
  return `# ${path.basename(filePath, path.extname(filePath))}\n\n${sections.join("\n\n")}`;
}

function localHtml(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  return NodeHtmlMarkdown.translate(content);
}

async function localEml(filePath) {
  const raw = fs.readFileSync(filePath);
  const mail = await simpleParser(raw);

  const subject = mail.subject || path.basename(filePath, ".eml");
  const from = mail.from?.text || "";
  const to = mail.to?.text || "";
  const cc = mail.cc?.text || "";
  const date = mail.date ? mail.date.toISOString().replace("T", " ").slice(0, 19) + " UTC" : "";

  const meta = [
    `**From:** ${from}`,
    `**To:** ${to}`,
    cc ? `**CC:** ${cc}` : null,
    date ? `**Date:** ${date}` : null,
  ].filter(Boolean).join("\n");

  let body = "";
  if (mail.text) {
    body = mail.text.trim();
  } else if (mail.html) {
    body = NodeHtmlMarkdown.translate(mail.html).trim();
  }

  const attachmentLines = (mail.attachments || [])
    .map((a) => `- ${a.filename || "unnamed"} (${a.contentType}, ${Math.round(a.size / 1024)} KB)`)
    .join("\n");
  const attachmentsSection = attachmentLines
    ? `\n\n## Attachments\n\n${attachmentLines}`
    : "";

  const content = `# ${subject}\n\n${meta}\n\n---\n\n${body}${attachmentsSection}\n`;
  const extra = { email_subject: subject, email_from: from, email_to: to, email_date: date };
  return { content, extra };
}

// ── AI converters (claude CLI) ────────────────────────────────────────────────

async function aiPdf(filePath) {
  const prompt = `Read the file at "${filePath}" and convert it to clean, well-structured markdown. Preserve all headings, lists, tables, and meaningful formatting. Output only the markdown content, no preamble.`;
  return await complete(prompt);
}

async function aiCsv(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const prompt = `Convert this CSV to clean, well-structured markdown. Present it as a markdown table. If the data is large, include a brief summary at the top. Output only the markdown content, no preamble.\n\n\`\`\`csv\n${content}\n\`\`\``;
  return await complete(prompt);
}

// ── Summary for search ────────────────────────────────────────────────────────

function wordCount(str) {
  return str.split(/\s+/).filter(Boolean).length;
}

async function generateSummary(content) {
  const prompt = `Summarize the following document in 2-4 sentences. Focus on the key topics, people, decisions, and conclusions — the things someone would search for. Output only the summary, no preamble.\n\n${content.slice(0, 8000)}`;
  try {
    return (await complete(prompt)).trim();
  } catch {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  ensureDir(INBOX);
  ensureDir(PROCESSED);
  ensureDir(DOCS_OUT);

  const files = fs
    .readdirSync(INBOX)
    .filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return SUPPORTED.has(ext) && fs.statSync(path.join(INBOX, f)).isFile();
    });

  if (!files.length) {
    console.log("📭 No supported files found in sources/inbox/ (PDF, CSV, XLSX, HTML, EML)");
    return;
  }

  console.log(`📥 Found ${files.length} file(s) to convert ${useAI ? "(AI mode)" : "(local mode)"}\n`);

  for (const file of files) {
    const filePath = path.join(INBOX, file);
    const ext = path.extname(file).toLowerCase();
    const baseName = path.basename(file, ext);
    const outFile = path.join(DOCS_OUT, `${slugify(baseName)}.md`);

    const sourceHash = hashFile(filePath);
    if (fs.existsSync(outFile) && existingHash(outFile) === sourceHash) {
      console.log(`  ⏭  Skipped (unchanged): ${file}\n`);
      continue;
    }

    console.log(`  Converting: ${file}`);
    try {
      let content;
      let extra = {};

      if (useAI) {
        content = ext === ".pdf" ? await aiPdf(filePath) : await aiCsv(filePath);
      } else if (ext === ".pdf") {
        ({ content, extra } = await localPdf(filePath));
      } else if (ext === ".csv") {
        content = localCsv(filePath);
      } else if (ext === ".xlsx" || ext === ".xls") {
        content = await localXlsx(filePath);
      } else if (ext === ".eml") {
        ({ content, extra } = await localEml(filePath));
      } else {
        content = localHtml(filePath);
      }

      let summary = null;
      if (wordCount(content) > SUMMARY_THRESHOLD) {
        process.stdout.write(`  Summarizing for search…`);
        summary = await generateSummary(content);
        console.log(summary ? " done" : " skipped (claude unavailable)");
      }

      const frontmatter = buildFrontmatter({
        source: file,
        type: ext.slice(1),
        converted: new Date().toISOString().slice(0, 10),
        source_hash: sourceHash,
        ...extra,
        ...(summary ? { summary } : {}),
      });

      fs.writeFileSync(outFile, frontmatter + content, "utf-8");
      console.log(`  ✅ Saved → sources/docs/${slugify(baseName)}.md`);
      fs.renameSync(filePath, path.join(PROCESSED, file));
      console.log(`  📦 Archived → sources/inbox/processed/${file}\n`);
    } catch (err) {
      console.error(`  ❌ Failed to convert ${file}: ${err.message}\n`);
    }
  }

  console.log("✅ Inbox conversion complete");
}

run();
