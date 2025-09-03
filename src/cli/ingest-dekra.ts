/**
 * src/cli/ingest-dekra.ts
 * Batch-ingest a folder of DEKRA PDFs → PassportDraft JSON files.
 *
 * Usage:
 *   tsx src/cli/ingest-dekra.ts --in samples/pdfs --out samples/out
 * Options:
 *   --recursive            Recurse into subfolders (default: true)
 *   --lot-id-from name     Use file name (name|full) for lot_id (default: name)
 *   --site-hint STR        Fallback site string if extractor is weak
 *   --dekra-url URL        Canonical DEKRA URL to stamp (or leave default "N/A")
 */

import path from "node:path";
import fs from "node:fs/promises";
import { Command } from "commander";
import { listPdfs, loadPdf, normalizeWhitespace } from "../ingest/dekra/loaders.js";
import { mapToPassportDraft } from "../ingest/dekra/mapper.js";
import { validateDraft } from "../schema/index.js";

const program = new Command();
program
  .requiredOption("-i, --in <dir>", "input folder with PDFs")
  .requiredOption("-o, --out <dir>", "output folder for JSON drafts")
  .option("--recursive", "recurse into subfolders", true)
  .option("--lot-id-from <mode>", "lot_id source: name|full", "name")
  .option("--site-hint <str>", "fallback site string")
  .option("--dekra-url <url>", "canonical DEKRA URL to stamp (optional)");

program.parse(process.argv);
const opts = program.opts<{
  in: string;
  out: string;
  recursive?: boolean;
  lotIdFrom?: "name" | "full";
  siteHint?: string;
  dekraUrl?: string;
}>();

/** tiny helper to make sure a directory exists */
async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function lotIdFor(filePath: string, mode: "name" | "full") {
  return mode === "full" ? filePath : path.basename(filePath, path.extname(filePath));
}

type CoverageField =
  | "vin"
  | "dekra.inspection_ts"
  | "dekra.site"
  | "odometer.km"
  | "tyres_mm.fl"
  | "tyres_mm.fr"
  | "tyres_mm.rl"
  | "tyres_mm.rr";

function coverageCount(obj: any, fields: CoverageField[]) {
  const get = (p: string) => p.split(".").reduce((acc, k) => (acc ? acc[k] : undefined), obj);
  let found = 0;
  for (const f of fields) {
    const v = get(f);
    if (v !== undefined && v !== null && v !== "") found++;
  }
  return { found, total: fields.length };
}

(async () => {
  await ensureDir(opts.out);
  const pdfs = await listPdfs(opts.in, { recursive: opts.recursive !== false });

  if (!pdfs.length) {
    console.warn(`[ingest] No PDFs found under: ${opts.in}`);
    process.exit(0);
  }

  let aggFound = 0;
  let aggTotal = 0;

  for (const file of pdfs) {
    try {
      const loaded = await loadPdf(file);
      if (loaded.isLikelyScanned) {
        console.warn(`[warn] ${path.basename(file)} looks scanned (very little text) — consider OCR later`);
      }

      const text = normalizeWhitespace(loaded.text);
      const draft = mapToPassportDraft(text, {
        lotId: lotIdFor(file, (opts.lotIdFrom as any) || "name"),
        siteHint: opts.siteHint,
        dekraUrl: opts.dekraUrl,
      });

      const valid = validateDraft(draft);
      const outFile = path.join(opts.out, path.basename(file).replace(/\.pdf$/i, ".json"));
      await fs.writeFile(outFile, JSON.stringify(draft, null, 2), "utf8");

      const fields: CoverageField[] = [
        "vin",
        "dekra.inspection_ts",
        "dekra.site",
        "odometer.km",
        "tyres_mm.fl",
        "tyres_mm.fr",
        "tyres_mm.rl",
        "tyres_mm.rr",
      ];
      const cov = coverageCount(draft as any, fields);
      aggFound += cov.found;
      aggTotal += cov.total;

      const verdict = valid ? "valid" : "INVALID";
      console.log(`✅ ${path.basename(file)} → ${path.basename(outFile)} (${verdict}, coverage ${cov.found}/${cov.total})`);
      if (!valid) {
        console.error("   schema errors:", validateDraft.errors);
      }
    } catch (err) {
      console.error(`❌ Failed: ${file}`, err);
    }
  }

  const pct = Math.round((aggFound / Math.max(1, aggTotal)) * 100);
  console.log(`\nOverall coverage proxy: ${pct}% across ${pdfs.length} file(s).`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
