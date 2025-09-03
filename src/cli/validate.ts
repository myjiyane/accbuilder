/**
 * src/cli/validate.ts
 * Small helper to validate a JSON file against our schemas.
 *
 * Usage:
 *   tsx src/cli/validate.ts draft samples/out/<file>.json
 *   tsx src/cli/validate.ts sealed samples/sample-passport-sealed.json
 */

import fs from "node:fs";
import path from "node:path";
import { validateDraft, validateSealed } from "../schema/index.js";

type Kind = "draft" | "sealed";

const kind = (process.argv[2] || "").toLowerCase() as Kind;
const file = process.argv[3];

if ((kind !== "draft" && kind !== "sealed") || !file) {
  console.log("Usage: tsx src/cli/validate.ts <draft|sealed> <file.json>");
  process.exit(1);
}

const json = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));

const ok = kind === "draft" ? validateDraft(json) : validateSealed(json);
console.log(`${kind} valid?`, ok);

if (!ok) {
  const errors = (kind === "draft" ? validateDraft : validateSealed).errors;
  console.error("Errors:", errors);
  process.exitCode = 2;
} else {
  process.exitCode = 0;
}
