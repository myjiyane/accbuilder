// src/server/app.ts
import express from "express";
import cors from "cors";
import multer from "multer";
import rateLimit from "express-rate-limit";
import path from "node:path";
import pdf from "pdf-parse";
import crypto from "node:crypto";
import photosRouter from "./photos";


// ---- project modules (adjust paths if your tree differs)
import { createDevStorage } from "./storage.js";
import type { PassportDraft, PassportSealed } from "../types/passport.js";
import { validateDraft, validateSealed } from "../schema/index.js";
import { mapToPassportDraft } from "../ingest/dekra/mapper.js";

// (optional) if you exported normalize from loaders; else keep this inline helper
// import { normalizeWhitespace } from "../ingest/dekra/loaders.js";

// ---------- helpers ----------
const DATA_DIR = process.env.DATA_DIR || "data";
const PORT = Number(process.env.PORT || 3000);
const API_PREFIX = process.env.API_PREFIX || "/api/v1";
const API_KEY = process.env.API_KEY || ""; // leave empty to disable in dev

// dev signing keypair (PEM strings)
// You can set PRIVATE_KEY_PEM / PUBLIC_KEY_PEM in env to override
const PRIVATE_KEY_PEM = process.env.PRIVATE_KEY_PEM || "";
const PUBLIC_KEY_PEM = process.env.PUBLIC_KEY_PEM || "";

// simple, predictable whitespace normalizer for OCR/PDF text
function normalizeWhitespace(s: string): string {
  return (s || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/\s+\n/g, "\n")
    .trim();
}

// stable canonicalization for signing
function canonicalize(input: any): any {
  if (Array.isArray(input)) return input.map(canonicalize);
  if (input && typeof input === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(input).sort()) out[k] = canonicalize((input as any)[k]);
    return out;
  }
  return input;
}
function canonicalBytes(obj: any): Buffer {
  const canon = canonicalize(obj);
  return Buffer.from(JSON.stringify(canon));
}

// compute sha256 hex of buffer
function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// sign bytes with RSA-SHA256 if PRIVATE_KEY_PEM provided
function signBytesRS256(buf: Buffer): string | null {
  if (!PRIVATE_KEY_PEM) return null;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(buf);
  signer.end();
  return signer.sign(PRIVATE_KEY_PEM).toString("base64");
}

function verifyBytesRS256(buf: Buffer, b64sig: string): boolean | null {
  if (!PUBLIC_KEY_PEM) return null;
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(buf);
  verifier.end();
  try {
    return verifier.verify(PUBLIC_KEY_PEM, Buffer.from(b64sig, "base64"));
  } catch {
    return false;
  }
}

// VIN sanitizer
function sanitizeVin(v?: string) {
  return (v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 17);
}

// ---------- app ----------
const app = express();
const storage = await createDevStorage(DATA_DIR);

// middlewares
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// static assets (ops console, staging pages, widget bundles)
app.use(express.static(path.resolve("public")));

// (optional) dev image serving – if you use the /uploads folder in photos pipeline
app.use("/uploads", express.static(path.resolve("uploads")));

// file upload holder for ingest PDF
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ---- API gateway (/api/v1) with optional API key & rate limiter ----
const api = express.Router();
const limiter = rateLimit({ windowMs: 60_000, max: 60 });
api.use(limiter);
api.use((req, res, next) => {
  if (!API_KEY) return next(); // disabled in dev
  const got = req.header("X-Api-Key");
  if (got === API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
});

// Attach routes to both legacy app and versioned api
attachRoutes(app);
attachRoutes(api);

app.use(API_PREFIX, api);

// ---------- routes ----------
function attachRoutes(r: express.Router) {
  // health
  r.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      dataDir: path.resolve(DATA_DIR),
      hasPrivateKey: !!PRIVATE_KEY_PEM,
      hasPublicKey: !!PUBLIC_KEY_PEM,
    });
  });

  // list all passports (dev)
  r.get("/passports", async (_req, res) => {
    const list = await storage.list();
    res.json(list);
  });

  // get single passport
  r.get("/passports/:vin", async (req, res) => {
    const vin = sanitizeVin(req.params.vin);
    const rec = await storage.get(vin);
    if (!rec) return res.status(404).json({ error: "not_found" });
    res.json(rec);
  });

  // delete a record
  r.delete("/passports/:vin", async (req, res) => {
    const vin = sanitizeVin(req.params.vin);
    await storage.remove(vin);
    res.json({ ok: true });
  });

  // ingest DEKRA PDF → Draft (also accepts raw text for testing)
  r.post("/ingest/dekra", upload.single("pdf"), async (req, res) => {
    try {
      const lotId = (req.body.lot_id as string) || "N/A";
      const dekraUrl = (req.body.dekra_url as string) || undefined;
      const siteHint = (req.body.site_hint as string) || undefined;
      const capturedBy = (req.body.captured_by as string) || "system";
      const expectedVin = sanitizeVin(req.body.expected_vin as string | undefined);

      let text: string | undefined;
      if (req.file?.buffer) {
        const out = await pdf(req.file.buffer);
        text = normalizeWhitespace(String(out.text || ""));
      } else if (typeof req.body.text === "string" && req.body.text.trim().length > 0) {
        text = normalizeWhitespace(req.body.text);
      }

      if (!text || text.length < 10) {
        return res.status(400).json({ error: "no_pdf_or_text" });
      }

      const draft: PassportDraft = mapToPassportDraft(text, {
        lotId,
        dekraUrl,
        siteHint,
        capturedBy,
      });

      
      if (expectedVin && sanitizeVin(draft.vin) !== expectedVin) {
        return res.status(409).json({
          error: "vin_mismatch",
          expectedVin,
          parsedVin: sanitizeVin(draft.vin),
        });
      }

      // Validate against Draft schema
      const ok = validateDraft(draft);
      if (!ok) {
        return res.status(422).json({
          error: "schema_invalid",
          details: validateDraft.errors,
          draft,
        });
      }

      const rec = await storage.upsertDraft(draft);

      // quick coverage proxy (same fields we used in CLI)
      const fields = [
        "vin",
        "dekra.inspection_ts",
        "dekra.site",
        "odometer.km",
        "tyres_mm.fl",
        "tyres_mm.fr",
        "tyres_mm.rl",
        "tyres_mm.rr",
      ] as const;
      const coverage = fields.reduce((acc, p) => {
        const v = p.split(".").reduce<any>((cur, k) => (cur ? cur[k] : undefined), draft as any);
        return acc + (v !== undefined && v !== null && v !== "" ? 1 : 0);
      }, 0);

      res.json({
        ok: true,
        coverage: `${coverage}/${fields.length}`,
        record: rec,
      });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: "ingest_failed", message: e?.message || String(e) });
    }
  });

  // seal a draft → sealed passport (local dev signer)
  r.post("/passports/seal", async (req, res) => {
    try {
      const vin = sanitizeVin(req.body?.vin);
      if (!vin) return res.status(400).json({ error: "vin_required" });
      const rec = await storage.get(vin);
      if (!rec?.draft) return res.status(404).json({ error: "draft_not_found" });

      // canonicalize the payload WITHOUT seal
      const payload = { ...rec.draft };
      // (ensure no stray seal field)
      // @ts-ignore
      delete payload.seal;

      const bytes = canonicalBytes(payload);
      const hash = sha256Hex(bytes);
      const sig = signBytesRS256(bytes); // can be null if no private key set
      const sealed: PassportSealed = {
        ...(rec.draft as PassportDraft),
        seal: {
          hash,
          sig: sig || "", // schema expects a string; leave empty if unsigned
          key_id: process.env.KEY_ID || "local-dev",
          sealed_ts: new Date().toISOString(),
        },
      };

      // Validate sealed schema
      const ok = validateSealed(sealed);
      if (!ok) {
        return res.status(422).json({ error: "sealed_schema_invalid", details: validateSealed.errors });
      }

      const updated = await storage.upsertSealed(sealed);
      res.json({ ok: true, record: updated });
    } catch (e: any) {
      console.error(e);
      res.status(500).json({ error: "seal_failed", message: e?.message || String(e) });
    }
  });

  // verify sealed (hash + optional RSA verify if PUBLIC_KEY_PEM present)
  r.get("/verify", async (req, res) => {
    const vin = sanitizeVin(String(req.query.vin || ""));
    if (!vin) return res.status(400).json({ error: "vin_required" });
    const rec = await storage.get(vin);
    if (!rec?.sealed) return res.status(404).json({ error: "sealed_not_found" });

    const sealed = rec.sealed;
    const payload = { ...sealed } as any;
    delete payload.seal;

    const bytes = canonicalBytes(payload);
    const hashExpected = sha256Hex(bytes);
    const reasons: string[] = [];

    const hashOk = (sealed.seal?.hash || "") === hashExpected;
    if (!hashOk) reasons.push("hash_mismatch");

    let sigOk: boolean | null = null;
    if (sealed.seal?.sig) {
      sigOk = verifyBytesRS256(bytes, sealed.seal.sig);
      if (sigOk === false) reasons.push("signature_invalid");
      if (sigOk === null) reasons.push("no_public_key_configured");
    } else {
      reasons.push("no_signature_present");
    }

    const valid = hashOk && (sigOk !== false); // consider valid if hash ok and no bad signature
    res.json({ valid, reasons, hash: hashExpected, key_id: sealed.seal?.key_id || null });
  });
}


app.use(`${API_PREFIX}/intake/photos`, photosRouter);
app.use("/intake/photos", photosRouter); 

// ---------- server ----------
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`WB Passport API listening on http://localhost:${PORT}`);
    console.log(`Versioned API at ${API_PREFIX}`);
  });
}
export default app;
