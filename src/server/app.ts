/**
 * src/server/app.ts
 * Minimal API for Week-1:
 *  - Dev storage (in-memory + data/*.json persistence)
 *  - Ingest DEKRA PDF → PassportDraft
 *  - Seal a draft (local ECDSA P-256)
 *  - Fetch passport (draft + sealed)
 *  - Verify sealed passport
 *
 * ENV (optional):
 *   PORT=3000
 *   DATA_DIR=./data
 *   PRIVATE_KEY_PATH=./seal_private.pem
 *   PUBLIC_KEY_PATH=./seal_public.pem
 */

import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import multer from "multer";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - pdf-parse ESM default import
import pdf from "pdf-parse";

import { createDevStorage } from "./storage.js";
import { mapToPassportDraft } from "../ingest/dekra/mapper.js";
import { normalizeWhitespace } from "../ingest/dekra/loaders.js";
import { validateDraft, validateSealed } from "../schema/index.js";
import type { PassportDraft, PassportSealed } from "../types/passport.js";
import { sealPassportDraft, verifySealedPassport } from "../crypto/sealer-local.js";

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const PRIVATE_KEY_PATH = process.env.PRIVATE_KEY_PATH || path.resolve("seal_private.pem");
const PUBLIC_KEY_PATH = process.env.PUBLIC_KEY_PATH || path.resolve("seal_public.pem");

// --- bootstrap storage ---
const storage = await createDevStorage(DATA_DIR);

// --- lazy load keys (dev friendly) ---
async function maybeRead(pathLike: string): Promise<string | undefined> {
  try {
    return await fs.readFile(pathLike, "utf8");
  } catch {
    return undefined;
  }
}

function sanitizeVin(v?: string) {
  return (v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 17);
}


let PRIVATE_KEY_PEM = await maybeRead(PRIVATE_KEY_PATH);
let PUBLIC_KEY_PEM = await maybeRead(PUBLIC_KEY_PATH);

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));


import path from "node:path";
app.use(express.static(path.resolve("public")));


// memory storage for uploaded PDFs
const upload = multer({ storage: multer.memoryStorage() });

/**
 * Health
 */
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    storageRecords: "n/a",
    hasPrivateKey: !!PRIVATE_KEY_PEM,
    hasPublicKey: !!PUBLIC_KEY_PEM,
  });
});

/**
 * List (dev convenience)
 */
app.get("/passports", async (_req, res) => {
  const list = await storage.list();
  res.json(list);
});

/**
 * Get by VIN
 */
app.get("/passports/:vin", async (req, res) => {
  const rec = await storage.get(req.params.vin);
  if (!rec) return res.status(404).json({ error: "not found" });
  res.json(rec);
});

/**
 * Ingest DEKRA:
 *  - Accepts multipart/form-data with a 'pdf' file upload
 *  - OR application/json with a 'text' field (raw PDF text) for testing
 *  Body fields:
 *    - vin? lot_id? dekra_url? site_hint?
 */
app.post("/ingest/dekra", upload.single("pdf"), async (req, res) => {
  try {
    const lotId = (req.body.lot_id as string) || "N/A";
    const dekraUrl = (req.body.dekra_url as string) || undefined;
    const siteHint = (req.body.site_hint as string) || undefined;
    const capturedBy = (req.body.captured_by as string) || "system";
    const expectedVin = sanitizeVin(req.body.expected_vin as string | undefined); 

    let text: string | undefined;

    if (req.file && req.file.buffer) {
      const out = await pdf(req.file.buffer);
      text = normalizeWhitespace(String(out.text || ""));
    } else if (typeof req.body.text === "string" && req.body.text.trim().length > 0) {
      text = normalizeWhitespace(req.body.text);
    }

    if (!text || text.length < 10) {
      return res.status(400).json({ error: "no_pdf_or_text" });
    }

    const draft: PassportDraft = mapToPassportDraft(text, {
      lotId, dekraUrl, siteHint, capturedBy,
    });

    
    if (expectedVin && sanitizeVin(draft.vin) !== expectedVin) {
      return res.status(409).json({
        error: "vin_mismatch",
        expectedVin,
        parsedVin: sanitizeVin(draft.vin),
      });
    }

    const valid = validateDraft(draft);
    if (!valid) {
      return res.status(422).json({ error: "schema_invalid", details: validateDraft.errors, draft });
    }

    const rec = await storage.upsertDraft(draft);

    const fields = ["vin","dekra.inspection_ts","dekra.site","odometer.km","tyres_mm.fl","tyres_mm.fr","tyres_mm.rl","tyres_mm.rr"] as const;
    
    const coverage = fields.reduce((acc, p) => {
      const v = p.split(".").reduce<any>((cur, k) => (cur ? cur[k] : undefined), draft as any);
      return acc + (v !== undefined && v !== null && v !== "" ? 1 : 0);
    }, 0);

    res.json({ ok: true, coverage: `${coverage}/${fields.length}`, record: rec });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: "ingest_failed", message: e?.message || String(e) });
  }
});


/**
 * Seal a stored draft by VIN.
 * Body:
 *   { vin: string, key_id?: string, sealed_at?: string }
 * Requires seal_private.pem to exist (or PRIVATE_KEY_PATH env set).
 */
app.post("/passports/seal", async (req, res) => {
  try {
    const vin = String(req.body.vin || "").trim();
    if (!vin) return res.status(400).json({ error: "vin_required" });

    // refresh keys if they appeared after server start (dev nicety)
    if (!PRIVATE_KEY_PEM) PRIVATE_KEY_PEM = await maybeRead(PRIVATE_KEY_PATH);

    if (!PRIVATE_KEY_PEM) {
      return res.status(500).json({
        error: "private_key_missing",
        message:
          "No private key found. Generate one with `openssl ecparam -name prime256v1 -genkey -noout -out seal_private.pem`.",
      });
    }

    const rec = await storage.get(vin);
    if (!rec?.draft) return res.status(404).json({ error: "draft_not_found" });

    const sealed: PassportSealed = sealPassportDraft(rec.draft, {
      privateKeyPem: PRIVATE_KEY_PEM,
      keyId: req.body.key_id || "local-ec-p256-v1",
      sealedAtIso: req.body.sealed_at,
    });

    const updated = await storage.upsertSealed(sealed);
    res.json({ ok: true, record: updated });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: "seal_failed", message: e?.message || String(e) });
  }
});

/**
 * Verify sealed by VIN.
 * Query: ?vin=...
 */
app.get("/verify", async (req, res) => {
  try {
    const vin = String(req.query.vin || "").trim();
    if (!vin) return res.status(400).json({ error: "vin_required" });

    // refresh public key if it appeared after server start
    if (!PUBLIC_KEY_PEM) PUBLIC_KEY_PEM = await maybeRead(PUBLIC_KEY_PATH);

    const rec = await storage.get(vin);
    if (!rec?.sealed) return res.status(404).json({ error: "sealed_not_found" });

    if (!PUBLIC_KEY_PEM) {
      return res.status(500).json({
        error: "public_key_missing",
        message: "No public key found. Generate seal_public.pem or set PUBLIC_KEY_PATH.",
      });
    }

    // sanity check schema
    const ok = validateSealed(rec.sealed);
    if (!ok) {
      return res.status(422).json({ error: "sealed_schema_invalid", details: validateSealed.errors });
    }

    const out = verifySealedPassport(rec.sealed, PUBLIC_KEY_PEM);
    res.json({ vin, valid: out.valid, reasons: out.reasons || [], key_id: rec.sealed.seal.key_id, sealed_ts: rec.sealed.seal.sealed_ts });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: "verify_failed", message: e?.message || String(e) });
  }
});

/**
 * Dev convenience: delete a record
 */
app.delete("/passports/:vin", async (req, res) => {
  await storage.remove(req.params.vin);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] data dir: ${DATA_DIR}`);
  console.log(`[server] private key: ${PRIVATE_KEY_PATH} ${PRIVATE_KEY_PEM ? "(loaded)" : "(missing)"}`);
  console.log(`[server] public  key: ${PUBLIC_KEY_PATH} ${PUBLIC_KEY_PEM ? "(loaded)" : "(missing)"}`);
});
