/**
 * src/cli/seal.ts
 * Seal a PassportDraft JSON using a local ECDSA (P-256) private key (PEM).
 *
 * Usage:
 *   tsx src/cli/seal.ts --in samples/out/<draft>.json --key seal_private.pem --out samples/sealed
 * Options:
 *   --key-id STR      Optional key identifier to embed (default: local-ec-p256-v1)
 *   --sealed-at ISO   Override sealed timestamp (useful for tests)
 *   --out PATH        Output file OR directory (if dir, we append ".sealed.json")
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { sealPassportDraft } from "../crypto/sealer-local.js";
import type { PassportDraft } from "../types/passport.js";
import { validateDraft } from "../schema/index.js";

const program = new Command();
program
  .requiredOption("--in <file>", "input PassportDraft JSON")
  .requiredOption("--key <pem>", "ECDSA P-256 private key (PEM)")
  .option("--key-id <id>", "seal key identifier", "local-ec-p256-v1")
  .option("--sealed-at <iso>", "override sealed timestamp (ISO8601)")
  .option("--out <path>", "output file OR directory", "samples/sealed");

program.parse(process.argv);
const opts = program.opts<{
  in: string;
  key: string;
  keyId: string;
  sealedAt?: string;
  out: string;
}>();

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function main() {
  // read draft json
  const draftBytes = await fs.readFile(path.resolve(opts.in), "utf8");
  const draft = JSON.parse(draftBytes) as PassportDraft;

  // validate early (nice error if wrong file)
  const ok = validateDraft(draft);
  if (!ok) {
    console.error("[seal] input is not a valid PassportDraft.");
    console.error(validateDraft.errors);
    process.exit(2);
  }

  // read private key
  const privateKeyPem = await fs.readFile(path.resolve(opts.key), "utf8");

  // seal
  const sealed = sealPassportDraft(draft, {
    privateKeyPem,
    keyId: opts.keyId,
    sealedAtIso: opts.sealedAt,
  });

  // compute output path
  const outPath = await computeOutPath(opts.out, opts.in);

  // write JSON
  await ensureDir(path.dirname(outPath));
  await fs.writeFile(outPath, JSON.stringify(sealed, null, 2), "utf8");

  console.log(`✅ sealed → ${outPath}`);
}

async function computeOutPath(outArg: string, inFile: string): Promise<string> {
  const stat = await fs
    .stat(path.resolve(outArg))
    .catch(() => null as unknown as { isDirectory: () => boolean });

  if (stat && typeof (stat as any).isDirectory === "function" && (stat as any).isDirectory()) {
    // treat as directory
    const base = path.basename(inFile).replace(/\.json$/i, "");
    return path.join(outArg, `${base}.sealed.json`);
  }

  // if it looks like a directory string (no .json), ensure dir and name file
  if (!/\.json$/i.test(outArg)) {
    await ensureDir(outArg);
    const base = path.basename(inFile).replace(/\.json$/i, "");
    return path.join(outArg, `${base}.sealed.json`);
  }

  // explicit file path
  return path.resolve(outArg);
}

// run
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
