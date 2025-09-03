/**
 * src/cli/verify.ts
 * Verify a sealed Passport JSON using a local ECDSA (P-256) public key (PEM).
 *
 * Usage:
 *   tsx src/cli/verify.ts --in samples/sealed/<file>.sealed.json --pub seal_public.pem
 *
 * Exit code:
 *   0 = valid
 *   3 = invalid signature or hash mismatch
 *   2 = input not a sealed passport / parse error
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import type { PassportSealed } from "../types/passport.js";
import { verifySealedPassport } from "../crypto/sealer-local.js";
import { validateSealed } from "../schema/index.js";

const program = new Command();
program
  .requiredOption("--in <file>", "sealed Passport JSON")
  .requiredOption("--pub <pem>", "ECDSA P-256 public key (PEM)");

program.parse(process.argv);
const opts = program.opts<{ in: string; pub: string }>();

async function main() {
  // read + parse sealed JSON
  const raw = await fs.readFile(path.resolve(opts.in), "utf8");
  let sealed: PassportSealed;
  try {
    sealed = JSON.parse(raw);
  } catch (e) {
    console.error("[verify] not valid JSON:", e);
    process.exit(2);
    return;
  }

  // sanity: must validate against sealed schema
  const ok = validateSealed(sealed);
  if (!ok) {
    console.error("[verify] input is not a valid PassportSealed.");
    console.error(validateSealed.errors);
    process.exit(2);
    return;
  }

  // read public key
  const publicKeyPem = await fs.readFile(path.resolve(opts.pub), "utf8");

  // verify
  const res = verifySealedPassport(sealed, publicKeyPem);
  console.log(JSON.stringify({ valid: res.valid, reasons: res.reasons || [] }, null, 2));
  process.exit(res.valid ? 0 : 3);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
