import 'dotenv/config';
import express from "express";
import cors from "cors";
import multer from "multer";
import rateLimit from "express-rate-limit";
import path from "node:path";
import pdf from "pdf-parse";
import crypto from "node:crypto";
import NodeCache from "node-cache";
import sharp from "sharp";
import { makePhotosRouter } from "./photos.js";
import { TextractClient, DetectDocumentTextCommand } from "@aws-sdk/client-textract";
import { fromEnv } from "@aws-sdk/credential-providers";

import { createDevStorage } from "./storage.js";
import type { PassportDraft, PassportSealed } from "../types/passport.js";
import { validateDraft, validateSealed } from "../schema/index.js";
import { mapToPassportDraft } from "../ingest/dekra/mapper.js";

// ---------- Configuration & Environment ----------
const DATA_DIR = process.env.DATA_DIR || "data";
const PORT = Number(process.env.PORT || 3000);
const API_PREFIX = process.env.API_PREFIX || "/api/v1";
const API_KEY = process.env.API_KEY || ""; 
const PRIVATE_KEY_PEM = process.env.PRIVATE_KEY_PEM || "";
const PUBLIC_KEY_PEM = process.env.PUBLIC_KEY_PEM || "";
const AWS_REGION = process.env.AWS_REGION || "eu-west-1";
const TEXTRACT_MAX_FILE_SIZE = Number(process.env.TEXTRACT_MAX_FILE_SIZE);
const TEXTRACT_CACHE_TTL = Number(process.env.TEXTRACT_CACHE_TTL);

// ---------- AWS Configuration ----------
function validateAwsConfig(): boolean {
  const required = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.warn(`Missing AWS configuration: ${missing.join(', ')}`);
    console.warn('Textract OCR functionality will not work without proper AWS credentials');
    return false;
  }
  
  return true;
}

const hasAwsConfig = validateAwsConfig();

// Singleton Textract client with proper configuration
let textractClient: TextractClient | null = null;
const getTextractClient = () => {
  if (!textractClient && hasAwsConfig) {
    textractClient = new TextractClient({
      region: AWS_REGION,
      credentials: fromEnv(),
      maxAttempts: 3,
      retryMode: "adaptive",
    });
  }
  return textractClient;
};

// OCR result cache for cost optimization
const ocrCache = new NodeCache({ 
  stdTTL: TEXTRACT_CACHE_TTL,
  maxKeys: 1000 
});

// OCR metrics tracking
interface OcrMetrics {
  totalRequests: number;
  successfulRequests: number;
  averageProcessingTime: number;
  vinDetectionRate: number;
  cacheHits: number;
}

const metrics: OcrMetrics = {
  totalRequests: 0,
  successfulRequests: 0,
  averageProcessingTime: 0,
  vinDetectionRate: 0,
  cacheHits: 0
};

// ---------- Utility Functions ----------
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

function getImageHash(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
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

// ---------- Enhanced VIN Functions ----------
function sanitizeVin(v?: string) {
  return (v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 17);
}

function normalizeVin(raw: string) {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/[IOQ]/g, "").slice(0, 17);
}

function isValidVin(vin: string): boolean {
  if (vin.length !== 17) return false;
  
  // VIN check digit validation (position 9)
  const weights = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  const values: { [key: string]: number } = {
    '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    'A': 1, 'B': 2, 'C': 3, 'D': 4, 'E': 5, 'F': 6, 'G': 7, 'H': 8,
    'J': 1, 'K': 2, 'L': 3, 'M': 4, 'N': 5, 'P': 7, 'R': 9, 'S': 2,
    'T': 3, 'U': 4, 'V': 5, 'W': 6, 'X': 7, 'Y': 8, 'Z': 9
  };
  
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    if (i === 8) continue; // skip check digit position
    sum += (values[vin[i]] || 0) * weights[i];
  }
  
  const checkDigit = sum % 11;
  const expectedCheck = checkDigit === 10 ? 'X' : checkDigit.toString();
  return vin[8] === expectedCheck;
}

function findVinCandidates(text: string): string[] {
  const U = text.toUpperCase();
  const CHUNKY = /(?:[A-Z0-9][ -]?){11,25}/g;
  const lines = U.split(/\r?\n/);
  const near = lines.filter(l => /\bVIN\b/.test(l));
  const rawHits = [
    ...(U.match(CHUNKY) || []),
    ...near.flatMap(l => l.match(CHUNKY) || []),
  ];
  const uniq = new Set<string>();
  for (const h of rawHits) {
    const n = normalizeVin(h);
    if (n.length >= 11) uniq.add(n);
  }
  const all = [...uniq];
  all.sort((a, b) => {
    const a17 = a.length === 17 ? 1 : 0;
    const b17 = b.length === 17 ? 1 : 0;
    if (b17 !== a17) return b17 - a17;
    if (b.length !== a.length) return b.length - a.length;
    return 0;
  });
  return all;
}

function findBestVinCandidate(candidates: string[]): string | null {
  // First priority: valid VINs with correct check digits
  const validVins = candidates.filter(isValidVin);
  if (validVins.length > 0) return validVins[0];
  
  // Second priority: 17-character candidates (may have invalid check digits)
  const seventeenChar = candidates.filter(c => c.length === 17);
  if (seventeenChar.length > 0) return seventeenChar[0];
  
  // Last resort: longest candidate
  return candidates.length > 0 ? candidates[0] : null;
}

// ---------- Image Processing ----------
async function preprocessImageForOcr(buffer: Buffer): Promise<Buffer> {
  try {
    // Enhance image for better OCR results
    return await sharp(buffer)
      .resize(1920, 1080, { 
        fit: 'inside', 
        withoutEnlargement: true 
      })
      .sharpen()
      .normalize()
      .jpeg({ quality: 95 })
      .toBuffer();
  } catch (error) {
    console.warn('Image preprocessing failed, using original:', error);
    return buffer;
  }
}

// ---------- App Setup ----------
const app = express();
const storage = await createDevStorage(DATA_DIR);

const photosRouter = makePhotosRouter(storage);
app.use(`${API_PREFIX}/intake/photos`, photosRouter);
app.use("/intake/photos", photosRouter); 

// middlewares
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// static assets
app.use(express.static(path.resolve("public")));
app.use("/uploads", express.static(path.resolve("uploads")));

// file upload configuration
const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: Math.max(15 * 1024 * 1024, TEXTRACT_MAX_FILE_SIZE) },
  fileFilter: (req, file, cb) => {
    // Allow document and image formats
    const allowedTypes = [
      'application/pdf',
      'image/jpeg', 'image/jpg', 'image/png', 'image/tiff', 'image/webp'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: ${allowedTypes.join(', ')}`));
    }
  }
});

// API gateway with rate limiting
const api = express.Router();
const limiter = rateLimit({ windowMs: 60_000, max: 60 });
api.use(limiter);
api.use((req, res, next) => {
  if (!API_KEY) return next();
  const got = req.header("X-Api-Key");
  if (got === API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
});

attachRoutes(app);
attachRoutes(api);

app.use(API_PREFIX, api);

// ---------- Routes ----------
function attachRoutes(r: express.Router) {
  // Enhanced health check with AWS status
  r.get("/healthz", async (_req, res) => {
    const health = {
      ok: true,
      dataDir: path.resolve(DATA_DIR),
      hasPrivateKey: !!PRIVATE_KEY_PEM,
      hasPublicKey: !!PUBLIC_KEY_PEM,
      aws: {
        configured: hasAwsConfig,
        region: AWS_REGION,
        textractAvailable: false
      },
      cache: {
        keys: ocrCache.keys().length,
        stats: ocrCache.getStats()
      }
    };

    // Test AWS connection if configured
    if (hasAwsConfig) {
      try {
        const client = getTextractClient();
        if (client) {
          // Make a minimal test call to verify connectivity
          await client.send(new DetectDocumentTextCommand({ 
            Document: { Bytes: Buffer.from([0x89, 0x50, 0x4E, 0x47]) } // Invalid PNG header
          }));
        }
      } catch (error: any) {
        // We expect this to fail with InvalidParameterException, but it confirms AWS connectivity
        health.aws.textractAvailable = error.name !== 'UnauthorizedOperation' && error.name !== 'AccessDenied';
      }
    }

    res.json(health);
  });

  // OCR metrics endpoint
  r.get("/metrics/ocr", (_req, res) => {
    res.json({
      ...metrics,
      successRate: metrics.totalRequests > 0 ? (metrics.successfulRequests / metrics.totalRequests * 100).toFixed(2) + '%' : '0%',
      cacheHitRate: metrics.totalRequests > 0 ? (metrics.cacheHits / metrics.totalRequests * 100).toFixed(2) + '%' : '0%'
    });
  });

  // Enhanced OCR VIN extraction endpoint
  r.post("/ocr/vin", upload.single("file"), async (req, res) => {
    const startTime = Date.now();
    metrics.totalRequests++;
    
    try {
      // Input validation
      const buf = req.file?.buffer;
      if (!buf || !buf.length) {
        return res.status(400).json({ 
          error: "no_file", 
          message: "No image file provided" 
        });
      }

      // AWS configuration check
      if (!hasAwsConfig) {
        return res.status(503).json({ 
          error: "aws_not_configured", 
          message: "AWS Textract is not properly configured" 
        });
      }

      // File size validation
      if (buf.length > TEXTRACT_MAX_FILE_SIZE) {
        return res.status(400).json({ 
          error: "file_too_large", 
          message: `File size exceeds ${TEXTRACT_MAX_FILE_SIZE / 1024 / 1024}MB limit` 
        });
      }

      // File type validation
      const fileType = req.file?.mimetype;
      
      const allowedTypes = ['image/jpeg', 'image/png', 'image/tiff', 'image/webp'];
      if (!fileType || !allowedTypes.includes(fileType)) {
        return res.status(400).json({ 
          error: "invalid_file_type", 
          message: "Only JPEG, PNG, TIFF, and WebP images are supported" 
        });
      }

      console.log(`Processing ${fileType} image, size: ${buf.length} bytes`);

      // Check cache first
      const imageHash = getImageHash(buf);
      const cached = ocrCache.get(imageHash);

      if (cached) {
        metrics.cacheHits++;
        console.log('Returning cached OCR result');
        return res.json({ 
          ...(cached as any), 
          fromCache: true,
          processingTime: Date.now() - startTime
        });
      }

      // Preprocess image for better OCR
      const processedBuffer = await preprocessImageForOcr(buf);
      
      const client = getTextractClient();
      if (!client) {
        throw new Error('Textract client not available');
      }

      const command = new DetectDocumentTextCommand({ 
        Document: { Bytes: processedBuffer } 
      });
      
      const textractResult = await client.send(command);
      const processingTime = Date.now() - startTime;

      // Extract text with confidence scores
      const blocks = textractResult.Blocks || [];
      const lines = blocks
        .filter(b => b.BlockType === "LINE" && b.Text && b.Confidence)
        .map(b => ({
          text: b.Text as string,
          confidence: b.Confidence as number,
        }));

      // Filter high-confidence results for VIN detection
      const highConfidenceLines = lines
        .filter(l => l.confidence > 80)
        .map(l => l.text);

      const allText = lines.map(l => l.text).join("\n");
      const highConfidenceText = highConfidenceLines.join("\n");
      
      // Try VIN detection on high-confidence text first, fallback to all text
      let candidates = findVinCandidates(highConfidenceText);
      if (candidates.length === 0) {
        candidates = findVinCandidates(allText);
      }

      const bestVin = findBestVinCandidate(candidates);
      const avgConfidence = lines.length > 0 
        ? lines.reduce((sum, l) => sum + l.confidence, 0) / lines.length 
        : 0;

      // Update metrics
      metrics.successfulRequests++;
      if (bestVin) {
        metrics.vinDetectionRate = (metrics.vinDetectionRate * (metrics.successfulRequests - 1) + 1) / metrics.successfulRequests;
      } else {
        metrics.vinDetectionRate = (metrics.vinDetectionRate * (metrics.successfulRequests - 1)) / metrics.successfulRequests;
      }
      metrics.averageProcessingTime = (metrics.averageProcessingTime * (metrics.successfulRequests - 1) + processingTime) / metrics.successfulRequests;

      // Create result object
      const result = { 
        ok: true, 
        vin: bestVin,
        vinValid: bestVin ? isValidVin(bestVin) : false,
        candidates: candidates.slice(0, 5),
        confidence: Math.round(avgConfidence * 100) / 100,
        processingTime,
        textExtracted: allText.length > 0,
        totalBlocks: blocks.length,
        lineCount: lines.length,
        fromCache: false
      };

      // Cache the result
      ocrCache.set(imageHash, result);

      res.json(result);

    } catch (error: any) {
      const processingTime = Date.now() - startTime;
      
      console.error("Textract OCR error:", {
        error: error.message,
        code: error.code,
        requestId: error.$metadata?.requestId,
        processingTime
      });

      // Handle specific AWS errors
      if (error.name === 'InvalidParameterException') {
        return res.status(400).json({ 
          error: "invalid_image", 
          message: "Image format is not supported or corrupted",
          processingTime
        });
      }
      
      if (error.name === 'ProvisionedThroughputExceededException') {
        return res.status(429).json({ 
          error: "rate_limit_exceeded", 
          message: "Too many requests, please try again later",
          processingTime
        });
      }

      if (error.code === 'UnauthorizedOperation' || error.code === 'AccessDenied') {
        return res.status(500).json({ 
          error: "aws_auth_error", 
          message: "AWS credentials not configured properly",
          processingTime
        });
      }

      res.status(500).json({ 
        error: "textract_failed", 
        message: "OCR processing failed",
        processingTime,
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
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

  // ingest DEKRA PDF → Draft
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

      const ok = validateDraft(draft);
      if (!ok) {
        return res.status(422).json({
          error: "schema_invalid",
          details: validateDraft.errors,
          draft,
        });
      }

      const rec = await storage.upsertDraft(draft);

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

  // seal a draft → sealed passport
  r.post("/passports/seal", async (req, res) => {
    try {
      const vin = sanitizeVin(req.body?.vin);
      if (!vin) return res.status(400).json({ error: "vin_required" });
      const rec = await storage.get(vin);
      if (!rec?.draft) return res.status(404).json({ error: "draft_not_found" });

      const payload = { ...rec.draft };
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

  // verify sealed passport
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

  // Initialize/ensure a draft for a new VIN
  r.post("/intake/init", async (req, res) => {
    try {
      const vin = sanitizeVin(req.body?.vin);
      const lotId = String(req.body?.lot_id || "WB-POC-001");
      if (!vin) return res.status(400).json({ error: "vin_required" });

      const rec = await storage.get(vin);
      const draft = rec?.draft ? { ...rec.draft } : { vin, lot_id: lotId };

      if (Array.isArray(req.body?.required_photos)) {
        draft.images = draft.images || { items: [] };
        draft.images.required = req.body.required_photos as any;
      }

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

  // Intake seed: set required photos for a VIN/lot
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
      draft.images.required = required as any;
      const updated = await storage.upsertDraft(draft);
      res.json({ ok: true, record: updated });
    } catch (e: any) {
      res.status(500).json({ error: "seed_failed", message: e?.message || String(e) });
    }
  });

  // Intake checklist/readiness for a VIN
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

  // Seal with readiness enforcement (override with ?force=1)
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
    const hasOdo = model.odometer?.km != null;

    const reasons: string[] = [];
    if (!hasDekra) reasons.push("missing_dekra_url");
    if (!hasOdo) reasons.push("missing_odometer_km");
    if (missing.length > 0) reasons.push(`missing_photos:${missing.join(",")}`);

    if (reasons.length && !force) {
      return res.status(412).json({ error: "not_ready", reasons });
    }

    // delegate to existing seal logic
    try {
      const payload = { ...rec0.draft } as any;
      delete payload.seal;
      const bytes = canonicalBytes(payload);
      const hash = sha256Hex(bytes);
      const sig = signBytesRS256(bytes) || "";
      const sealed: PassportSealed = { 
        ...(rec0.draft as PassportDraft), 
        seal: {
          hash, 
          sig, 
          key_id: process.env.KEY_ID || "local-dev", 
          sealed_ts: new Date().toISOString()
        }
      };
      const ok = validateSealed(sealed);
      if (!ok) {
        return res.status(422).json({ 
          error: "sealed_schema_invalid", 
          details: validateSealed.errors 
        });
      }
      const updated = await storage.upsertSealed(sealed);
      res.json({ 
        ok: true, 
        record: updated, 
        forced: reasons.length > 0 && force ? reasons : undefined 
      });
    } catch (e: any) {
      res.status(500).json({ 
        error: "seal_failed", 
        message: e?.message || String(e) 
      });
    }
  });
}

// Mount photo routes
app.use(`${API_PREFIX}/intake/photos`, photosRouter);
app.use("/intake/photos", photosRouter); 

// ---------- Server Startup ----------
if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`WB Passport API listening on http://localhost:${PORT}`);
    console.log(`Versioned API at ${API_PREFIX}`);
    console.log(`AWS Textract configured: ${hasAwsConfig ? '✅' : '❌'}`);
    console.log(`OCR cache TTL: ${TEXTRACT_CACHE_TTL}s`);
    console.log(`Max file size: ${TEXTRACT_MAX_FILE_SIZE / 1024 / 1024}MB`);
    
    if (!hasAwsConfig) {
      console.log('⚠️  Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to enable OCR');
    }
  });
}

export default app;