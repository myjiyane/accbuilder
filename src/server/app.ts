// src/server/app.ts
import express from "express";
import cors from "cors";
import multer from "multer";
import rateLimit from "express-rate-limit";
import path from "node:path";
import pdf from "pdf-parse";
import crypto from "node:crypto";
import { makePhotosRouter } from "./photos.js";

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
const API_KEY = process.env.API_KEY || ""; 

// dev signing keypair (PEM strings)
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


function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

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

function sanitizeVin(v?: string) {
  return (v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 17);
}

// ---------- app ----------
const app = express();
const storage = await createDevStorage(DATA_DIR);

const photosRouter = makePhotosRouter(storage);
app.use(`${API_PREFIX}/intake/photos`, photosRouter);
app.use("/intake/photos", photosRouter); 

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
      const sig = signBytesRS256(bytes);
      const sealed: PassportSealed = {
        ...(rec.draft as PassportDraft),
        seal: {
          hash,
          sig: sig || "", 
          key_id: process.env.KEY_ID || "local-dev",
          sealed_ts: new Date().toISOString(),
        },
      };

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

    const valid = hashOk && (sigOk !== false); 
    res.json({ valid, reasons, hash: hashExpected, key_id: sealed.seal?.key_id || null });
  });
  

  // Initialize/ensure a draft for a new VIN (creates if missing)
  r.post("/intake/init", async (req, res) => {
    try {
      const vin = sanitizeVin(req.body?.vin);
      const lotId = String(req.body?.lot_id || "WB-POC-001");
      if (!vin) return res.status(400).json({ error: "vin_required" });

      const rec = await storage.get(vin);
      const draft = rec?.draft ? { ...rec.draft } : { vin, lot_id: lotId };

      // Optional: accept required photo roles on init
      if (Array.isArray(req.body?.required_photos)) {
        draft.images = draft.images || { items: [] };
        draft.images.required = req.body.required_photos as any;
      }

      // Optional: accept DEKRA url / odo on init
      if (typeof req.body?.dekra_url === "string") {
        draft.dekra = draft.dekra || {};
        draft.dekra.url = req.body.dekra_url;
      }
      if (req.body?.odometer_km != null) {
        draft.odometer = draft.odometer || {};
        draft.odometer.km = Number(req.body.odometer_km);
        if (typeof req.body?.odometer_source === "string") {
          draft.odometer.source = req.body.odometer_source;
        }
      }

      const updated = await storage.upsertDraft(draft);
      res.json({ ok: true, record: updated });
    } catch (e: any) {
      res.status(500).json({ error: "init_failed", message: e?.message || String(e) });
    }
  });


  // ---- Intake seed: set required photos for a VIN/lot ----
  r.post("/intake/seed", async (req, res) => {
    try {
      const vin = sanitizeVin(req.body?.vin);
      const lotId = String(req.body?.lot_id || "").trim();
      const required = Array.isArray(req.body?.required_photos) ? req.body.required_photos : [];
      if (!vin || !lotId || required.length === 0) {
        return res.status(400).json({ error: "vin_lot_and_required_photos_required" });
      }
      const rec = await storage.get(vin);
      const draft = (rec?.draft || { vin, lot_id: lotId }) as PassportDraft;
      draft.lot_id = lotId;
      draft.images = draft.images || { items: [] };
      draft.images.required = required as any; // uses your ImageRole enum
      const updated = await storage.upsertDraft(draft);
      res.json({ ok: true, record: updated });
    } catch (e: any) {
      res.status(500).json({ error: "seed_failed", message: e?.message || String(e) });
    }
  });

  
  // ---- Intake checklist/readiness for a VIN ----
  r.get("/intake/checklist/:vin", async (req, res) => {
    const vin = sanitizeVin(req.params.vin);
    const rec = await storage.get(vin);

    if (!rec?.draft && !rec?.sealed) {
      return res.json({
        vin,
        lot_id: null,
        checklist: {
          hasDekra: false,
          hasOdo: false,
          photosOk: false,
          dtcStatus: "n/a",
          requiredCount: 0,
          presentCount: 0,
          missing: [] as string[],
        },
        ready: false
      });
    }

    const draft = rec.draft;
    const sealed = rec.sealed;

    const required: string[] =
      (draft?.images?.required?.length ? draft.images.required : sealed?.images?.required) || [];

    const items = [
      ...(sealed?.images?.items || []),
      ...(draft?.images?.items || []),
    ];
    
    const presentRoles = new Set(items.map((i) => i.role));
    const missing = required.filter((r) => !presentRoles.has(r));

    const hasDekra = !!(draft?.dekra?.url || sealed?.dekra?.url);
    const odoKm = draft?.odometer?.km ?? sealed?.odometer?.km;
    const hasOdo = odoKm !== undefined && odoKm !== null;
    const dtcStatus = (draft?.dtc?.status || sealed?.dtc?.status || "n/a") as "green"|"amber"|"red"|"n/a";

    const photosOk = required.length > 0 && missing.length === 0;
    const ready = hasDekra && hasOdo && (required.length === 0 ? false : photosOk);

    res.json({
      vin,
      lot_id: draft?.lot_id || sealed?.lot_id || null,
      checklist: {
        hasDekra,
        hasOdo,
        photosOk,
        dtcStatus,
        requiredCount: required.length,
        presentCount: presentRoles.size,
        missing,
      },
      ready,
    });
  });



  // ---- Seal with readiness enforcement (override with ?force=1) ----
  r.post("/passports/seal/strict", async (req, res) => {
    const vin = sanitizeVin(req.body?.vin);
    const force = String(req.query.force || "") === "1";
    if (!vin) return res.status(400).json({ error: "vin_required" });

    // compute readiness
    const rec0 = await storage.get(vin);
    if (!rec0?.draft) return res.status(404).json({ error: "draft_not_found" });
    const model = rec0.draft;
    const required = model.images?.required || [];
    const present = new Set((model.images?.items || []).map(i => i.role));
    const missing = required.filter(r => !present.has(r));
    const hasDekra = !!model.dekra?.url;
    const hasOdo  = model.odometer?.km != null;

    const reasons: string[] = [];
    if (!hasDekra) reasons.push("missing_dekra_url");
    if (!hasOdo) reasons.push("missing_odometer_km");
    if (missing.length > 0) reasons.push(`missing_photos:${missing.join(",")}`);

    if (reasons.length && !force) {
      return res.status(412).json({ error: "not_ready", reasons });
    }

    // delegate to your existing /passports/seal logic (inline here for clarity)
    try {
      const payload = { ...rec0.draft } as any;
      delete payload.seal;
      const bytes = canonicalBytes(payload);
      const hash = sha256Hex(bytes);
      const sig = signBytesRS256(bytes) || "";
      const sealed: PassportSealed = { ...(rec0.draft as PassportDraft), seal: {
        hash, sig, key_id: process.env.KEY_ID || "local-dev", sealed_ts: new Date().toISOString()
      }};
      const ok = validateSealed(sealed);
      if (!ok) return res.status(422).json({ error: "sealed_schema_invalid", details: validateSealed.errors });
      const updated = await storage.upsertSealed(sealed);
      res.json({ ok: true, record: updated, forced: reasons.length > 0 && force ? reasons : undefined });
    } catch (e: any) {
      res.status(500).json({ error: "seal_failed", message: e?.message || String(e) });
    }
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
