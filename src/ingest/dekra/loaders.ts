/**
 * src/ingest/dekra/loaders.ts
 * PDF → text utilities for DEKRA ingest (Week-1: text-based PDFs only).
 *
 * Uses `pdf-parse` under the hood. We DO NOT do OCR here.
 * If a file returns very little/no text, we flag `isLikelyScanned: true`
 * so upstream can decide to skip or queue for OCR in Week-2.
 */

import fs from "node:fs/promises";
import path from "node:path";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - pdf-parse has no official types for ESM default import
import pdf from "pdf-parse";

export interface LoadedPdf {
  text: string;
  meta: {
    pages: number;
    info?: Record<string, unknown>;
    filepath: string;
    bytes: number;
  };
  /** Heuristic: true if the extracted text is suspiciously short. */
  isLikelyScanned: boolean;
}

/**
 * Recursively list all PDF file paths in a directory.
 */
export async function listPdfs(
  dir: string,
  opts: { recursive?: boolean } = {},
): Promise<string[]> {
  const { recursive = true } = opts;
  const out: string[] = [];

  async function walk(d: string) {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) {
        if (recursive) await walk(fp);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".pdf")) {
        out.push(fp);
      }
    }
  }

  await walk(dir);
  return out.sort();
}

/**
 * Load a single PDF and extract text.
 * Returns the raw text (with page breaks preserved), some metadata,
 * and a quick heuristic that hints whether the PDF is likely a scanned image.
 */
export async function loadPdf(filePath: string): Promise<LoadedPdf> {
  const buf = await fs.readFile(filePath);
  const sizeBytes = buf.byteLength;

  const result = await pdf(buf); // { text, numpages, info, ... }
  const rawText = (result.text ?? "").toString();
  const text = normalizeWhitespace(rawText);

  // Heuristic: if text is extremely short relative to file size, assume scanned/image
  const charsPerKB = text.length / Math.max(1, sizeBytes / 1024);
  const isLikelyScanned = text.length < 200 || charsPerKB < 0.5;

  return {
    text,
    meta: {
      pages: (result as any).numpages ?? (result as any).numrender ?? 0,
      info: (result as any).info ?? {},
      filepath: filePath,
      bytes: sizeBytes,
    },
    isLikelyScanned,
  };
}

/**
 * Convenience: load only the text of a PDF.
 */
export async function loadPdfText(filePath: string): Promise<string> {
  const { text } = await loadPdf(filePath);
  return text;
}

/**
 * Convenience: load many PDFs from a folder into memory (text only).
 * Skips files that fail to parse but logs a warning.
 */
export async function loadManyPdfTexts(
  dir: string,
  opts: { recursive?: boolean } = {},
): Promise<Record<string, string>> {
  const files = await listPdfs(dir, opts);
  const out: Record<string, string> = {};
  for (const f of files) {
    try {
      out[f] = await loadPdfText(f);
    } catch (err) {
      console.warn(`[loaders] failed to parse: ${f}`, err);
    }
  }
  return out;
}

/**
 * Normalize whitespace for more stable downstream regex/proximity parsing.
 * - collapse tabs/multiple spaces
 * - trim each line
 * - drop repeated blank lines
 */
export function normalizeWhitespace(input: string): string {
  if (!input) return "";
  const collapsed = input
    .replace(/[^\S\r\n]+/g, " ") // collapse spaces/tabs but keep newlines
    .split(/\r?\n/)
    .map((l) => l.trim())
    .join("\n");
  // collapse multiple blank lines
  return collapsed.replace(/\n{3,}/g, "\n\n").trim();
}
