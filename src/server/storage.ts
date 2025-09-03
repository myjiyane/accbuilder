/**
 * src/server/storage.ts
 * Dev storage: in-memory map, persisted as JSON files under ./data/
 *
 * - One file per VIN: data/<VIN>.json
 * - Atomic writes (tmp file + rename)
 * - Loads all existing JSONs on init()
 * - Designed for Week-1 dev; swap for DB later behind the same interface.
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import type { PassportDraft, PassportSealed } from "../types/passport.js";

export type PassportRecord = {
  vin: string;
  draft?: PassportDraft;
  sealed?: PassportSealed;
  updatedAt: string; // ISO
};

export interface Storage {
  init(): Promise<void>;
  upsertDraft(draft: PassportDraft): Promise<PassportRecord>;
  upsertSealed(sealed: PassportSealed): Promise<PassportRecord>;
  get(vin: string): Promise<PassportRecord | undefined>;
  list(): Promise<PassportRecord[]>;
  remove(vin: string): Promise<void>;
}

export class DevStorage implements Storage {
  private dataDir: string;
  private map = new Map<string, PassportRecord>();

  constructor(dir = path.resolve("data")) {
    this.dataDir = dir;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const entries = await fs.readdir(this.dataDir).catch(() => []);
    for (const name of entries) {
      if (!name.toLowerCase().endsWith(".json")) continue;
      const full = path.join(this.dataDir, name);
      try {
        const txt = await fs.readFile(full, "utf8");
        const rec = JSON.parse(txt) as PassportRecord;
        if (rec?.vin) this.map.set(rec.vin, rec);
      } catch (e) {
        // Move unreadable file aside instead of crashing dev
        const bad = full.replace(/\.json$/i, `.corrupt.${Date.now()}.json`);
        try { await fs.rename(full, bad); } catch {}
        console.warn(`[storage] skipped corrupt file: ${name}`);
      }
    }
    console.log(`[storage] loaded ${this.map.size} record(s) from ${this.dataDir}`);
  }

  async upsertDraft(draft: PassportDraft): Promise<PassportRecord> {
    const vin = sanitizeVin(draft.vin);
    if (!vin) throw new Error("draft missing valid VIN");
    const current = this.map.get(vin) || { vin, updatedAt: new Date().toISOString() };
    const next: PassportRecord = {
      ...current,
      vin,
      draft,
      // If draft changes, drop sealed (caller can re-seal)
      sealed: current.sealed && changed(current.draft, draft) ? undefined : current.sealed,
      updatedAt: new Date().toISOString(),
    };
    this.map.set(vin, next);
    await this.persist(next);
    return next;
  }

  async upsertSealed(sealed: PassportSealed): Promise<PassportRecord> {
    const vin = sanitizeVin(sealed.vin);
    if (!vin) throw new Error("sealed passport missing valid VIN");
    const current = this.map.get(vin) || { vin, updatedAt: new Date().toISOString() };
    const next: PassportRecord = {
      ...current,
      vin,
      draft: current.draft ?? stripSeal(sealed),
      sealed,
      updatedAt: new Date().toISOString(),
    };
    this.map.set(vin, next);
    await this.persist(next);
    return next;
  }

  async get(vin: string): Promise<PassportRecord | undefined> {
    return this.map.get(sanitizeVin(vin));
  }

  async list(): Promise<PassportRecord[]> {
    return Array.from(this.map.values()).sort((a, b) => (a.vin < b.vin ? -1 : 1));
  }

  async remove(vin: string): Promise<void> {
    const key = sanitizeVin(vin);
    this.map.delete(key);
    const file = path.join(this.dataDir, `${key}.json`);
    try { await fs.unlink(file); } catch {}
  }

  // ---- internals ----

  private async persist(rec: PassportRecord): Promise<void> {
    const file = path.join(this.dataDir, `${sanitizeVin(rec.vin)}.json`);
    const tmp = file + `.tmp-${process.pid}-${Date.now()}`;
    const json = JSON.stringify(rec, null, 2) + "\n";
    await fs.writeFile(tmp, json, "utf8");
    // rename is atomic on same volume
    await fs.rename(tmp, file);
    // best-effort fsync directory for metadata durability (dev only)
    try {
      const fd = fssync.openSync(this.dataDir, "r");
      fssync.fsyncSync(fd);
      fssync.closeSync(fd);
    } catch {}
  }
}

// helpers

function sanitizeVin(vin?: string): string {
  return (vin || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 17);
}

function stripSeal(sealed: PassportSealed): PassportDraft {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { seal, ...rest } = sealed as any;
  return rest;
}

function changed(a?: unknown, b?: unknown): boolean {
  // Shallow-ish check; good enough for Week-1
  const ja = safeStableStringify(a);
  const jb = safeStableStringify(b);
  return ja !== jb;
}

function safeStableStringify(x: unknown): string {
  // stable key order stringify
  const seen = new WeakSet();
  const sortKeys = (v: any): any => {
    if (v && typeof v === "object") {
      if (seen.has(v)) return null;
      seen.add(v);
      if (Array.isArray(v)) return v.map(sortKeys);
      const out: Record<string, any> = {};
      for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
      return out;
    }
    return v;
  };
  try {
    return JSON.stringify(sortKeys(x));
  } catch {
    return "";
  }
}

// convenience factory
export async function createDevStorage(dir?: string) {
  const s = new DevStorage(dir);
  await s.init();
  return s;
}
