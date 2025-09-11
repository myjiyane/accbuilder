// src/server/photos.ts
import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { PassportDraft } from "../types/passport.js";

/** Minimal shape your storage exposes; matches createDevStorage */
export interface StorageLike {
  get(vin: string): Promise<any>;
  upsertDraft(draft: PassportDraft): Promise<any>;
}

/** Build a photos router that closes over the shared storage */
export function makePhotosRouter(storage: StorageLike) {
  const router = express.Router();

  // ---- Dev uploads (local disk) ----
  const DEV_UPLOAD_DIR = path.resolve("uploads");
  fs.mkdir(DEV_UPLOAD_DIR, { recursive: true }).catch(() => {});

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
  });

  // ---- Optional S3 presign path (only if env is set) ----
  const S3_BUCKET = process.env.S3_BUCKET;
  const S3_REGION = process.env.AWS_REGION || "eu-west-1";
  const s3 =
    S3_BUCKET && process.env.AWS_ACCESS_KEY_ID
      ? new S3Client({ region: S3_REGION })
      : null;

  // Utility
  const sanitizeVin = (v?: string) =>
    (v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 17);

  // ---- DEV: direct multipart upload ----
  router.post("/upload", upload.single("file"), async (req, res) => {
    try {
      const vin = sanitizeVin(req.body.vin);
      const role = String(req.body.role || "");
      const buf = req.file?.buffer;

      if (!vin || !role || !buf) {
        return res.status(400).json({ error: "vin_role_file_required" });
      }

      const ts = new Date().toISOString().replace(/[:.]/g, "");
      const fname = `${vin}_${role}_${ts}.jpg`;
      const filePath = path.join(DEV_UPLOAD_DIR, fname);

      // Normalize, rotate, and write
      const img = sharp(buf).rotate();
      const meta = await img.metadata();
      const out = await img.jpeg({ quality: 82 }).toBuffer();
      await fs.writeFile(filePath, out);

      const sha256 = crypto.createHash("sha256").update(out).digest("hex");

      const rec = await upsertImageManifest(vin, {
        role,
        object_key: `local:${fname}`,
        url: `/uploads/${fname}`,
        sha256,
        w: meta.width || undefined,
        h: meta.height || undefined,
        captured_ts: new Date().toISOString(),
      });

      res.json({ ok: true, record: rec });
    } catch (e: any) {
      res
        .status(500)
        .json({ error: "dev_upload_failed", message: e?.message || String(e) });
    }
  });

  // ---- STAGING: presigned PUTs (S3) ----
  router.post("/initiate", async (req, res) => {
    if (!s3 || !S3_BUCKET) {
      return res.status(400).json({ error: "s3_not_configured" });
    }
    const vin = sanitizeVin(req.body.vin);
    const lot = String(req.body.lot_id || "");
    const files = Array.isArray(req.body.files) ? req.body.files : [];
    if (!vin || files.length === 0) {
      return res.status(400).json({ error: "vin_and_files_required" });
    }

    const uploads = await Promise.all(
      files.map(async (f: any) => {
        const ext = f?.mime === "image/png" ? "png" : "jpg";
        const key = `${vin}/${crypto.randomUUID()}.${ext}`;
        const put = new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          ContentType: f?.mime || "image/jpeg",
        });
        const url = await getSignedUrl(s3, put, { expiresIn: 900 });
        return { role: f.role, method: "PUT", url, object_key: key };
      })
    );

    res.json({ vin, lot_id: lot, uploads });
  });

  router.post("/complete", async (req, res) => {
    if (!s3 || !S3_BUCKET) {
      return res.status(400).json({ error: "s3_not_configured" });
    }
    const vin = sanitizeVin(req.body.vin);
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!vin || items.length === 0) {
      return res.status(400).json({ error: "vin_and_items_required" });
    }

    const enriched: any[] = [];
    for (const it of items) {
      // Optional: probe object head (dims not known from S3)
      try {
        await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: it.object_key }));
      } catch {
        // ignore if not available; you can compute sha/dims via Lambda in prod
      }
      enriched.push({
        role: it.role,
        object_key: it.object_key,
        url: null, // keep null; you'll serve via CDN or presigned GET in prod
        sha256: null,
        w: undefined,
        h: undefined,
        captured_ts: new Date().toISOString(),
      });
    }

    const rec = await upsertImageManifest(vin, ...enriched);
    res.json({ ok: true, record: rec });
  });

  // ---- helper: append/merge image items by role ----
  async function upsertImageManifest(
    vin: string,
    ...items: Array<
      Required<NonNullable<PassportDraft["images"]>>["items"][number]
    >
  ) {
    const rec = await storage.get(vin);
    // Create a minimal draft if none exists (lets you upload before full ingest)
    const draft: PassportDraft = rec?.draft
      ? { ...rec.draft }
      : { vin, lot_id: rec?.sealed?.lot_id || "N/A" };

    draft.images = draft.images || { items: [] };
    const byRole = new Map(draft.images.items.map((i) => [i.role, i]));
    for (const it of items) byRole.set(it.role, it);
    draft.images.items = Array.from(byRole.values());

    const updated = await storage.upsertDraft(draft);
    return updated;
  }

  return router;
}
