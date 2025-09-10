import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createDevStorage } from "./storage.js";
import type { PassportDraft } from "../types/passport.js";

const router = express.Router();
const storage = await createDevStorage(process.env.DATA_DIR || "data");

// dev upload target
const DEV_UPLOAD_DIR = path.resolve("uploads");
await fs.mkdir(DEV_UPLOAD_DIR, { recursive: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const S3_BUCKET = process.env.S3_BUCKET; // e.g. wb-passport-stg-raw
const S3_REGION = process.env.AWS_REGION || "eu-west-1";
const s3 = (S3_BUCKET && process.env.AWS_ACCESS_KEY_ID) ? new S3Client({ region: S3_REGION }) : null;

// ---- DEV: direct multipart upload ----
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const vin = String(req.body.vin || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0,17);
    const role = String(req.body.role || "");
    if (!vin || !role || !req.file?.buffer) return res.status(400).json({ error: "vin_role_file_required" });

    const ts = new Date().toISOString().replace(/[:.]/g,"");
    const fname = `${vin}_${role}_${ts}.jpg`;
    const filePath = path.join(DEV_UPLOAD_DIR, fname);

    // normalize + write
    const img = sharp(req.file.buffer).rotate();
    const meta = await img.metadata();
    const buf = await img.jpeg({ quality: 82 }).toBuffer();
    await fs.writeFile(filePath, buf);

    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");

    const rec = await upsertImageManifest(vin, {
      role, object_key: `local:${fname}`, url: `/uploads/${fname}`,
      sha256, w: meta.width || undefined, h: meta.height || undefined, captured_ts: new Date().toISOString()
    });

    res.json({ ok:true, record: rec });
  } catch (e:any) {
    res.status(500).json({ error:"dev_upload_failed", message: e?.message || String(e) });
  }
});

// static serve dev uploads
router.use("/static", express.static(DEV_UPLOAD_DIR));

// ---- STAGING: presigned PUTs ----
router.post("/initiate", async (req, res) => {
  if (!s3 || !S3_BUCKET) return res.status(400).json({ error:"s3_not_configured" });
  const vin = String(req.body.vin || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0,17);
  const lot = String(req.body.lot_id || "");
  const files = Array.isArray(req.body.files) ? req.body.files : [];
  if (!vin || files.length === 0) return res.status(400).json({ error:"vin_and_files_required" });

  const uploads = await Promise.all(files.map(async (f:any) => {
    const ext = (f.mime === "image/png") ? "png" : "jpg";
    const key = `${vin}/${crypto.randomUUID()}.${ext}`;
    const put = new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: f.mime || "image/jpeg" });
    const url = await getSignedUrl(s3!, put, { expiresIn: 900 });
    return { role: f.role, method:"PUT", url, object_key: key };
  }));
  res.json({ vin, lot_id: lot, uploads });
});

router.post("/complete", async (req, res) => {
  if (!s3 || !S3_BUCKET) return res.status(400).json({ error:"s3_not_configured" });
  const vin = String(req.body.vin || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0,17);
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!vin || items.length === 0) return res.status(400).json({ error:"vin_and_items_required" });

  const out: any[] = [];
  for (const it of items) {
    // fetch object head – in a real pipeline, you’d compute sha256 on upload via Lambda; for POC we skip or set null
    let w: number|undefined, h: number|undefined;
    try {
      const head = await s3!.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: it.object_key }));
      // width/height not known from S3; keep undefined in POC unless you run an image processor
    } catch {}
    out.push({ role: it.role, object_key: it.object_key, url: null, sha256: null, w, h, captured_ts: new Date().toISOString() });
  }
  const rec = await upsertImageManifest(vin, ...out);
  res.json({ ok:true, record: rec });
});

// helper: append images to draft
async function upsertImageManifest(vin: string, ...items: Array<Required<NonNullable<PassportDraft["images"]>>["items"][number]>) {
  const rec = await storage.get(vin);
  const draft = (rec?.draft || { vin }) as PassportDraft;
  draft.images = draft.images || { items: [] };
  const byRole = new Map(draft.images.items.map(i => [i.role, i]));
  for (const it of items) byRole.set(it.role, it);
  draft.images.items = Array.from(byRole.values());
  const updated = await storage.upsertDraft(draft);
  return updated;
}

export default router;
