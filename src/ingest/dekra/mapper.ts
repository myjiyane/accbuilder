/**
 * src/ingest/dekra/mapper.ts
 * Map raw DEKRA PDF text → PassportDraft using the extractors.
 * Week-1: keep it simple; set unknowns to null and don’t block on gaps.
 */

import type { PassportDraft } from "../../types/passport.js";
import {
  extractVin,
  extractInspectionDate,
  extractSite,
  extractOdometerKm,
  extractTyres,
  extractDtc,
} from "./extractors.js";

export interface MapOptions {
  lotId?: string;
  dekraUrl?: string;        // canonical link if known; else "N/A"
  capturedBy?: string;      // staff id / "system"
  siteHint?: string;        // optional site override if extractor is weak
  nowIso?: string;          // override timestamp for deterministic tests
}

/** Clamp helper for tyre depths (mm) */
function clampMm(n: number | null | undefined): number | null {
  if (n == null || Number.isNaN(n as number)) return null;
  const v = Math.max(0, Math.min(20, Number(n)));
  return Number.isFinite(v) ? Number(v) : null;
}

export function mapToPassportDraft(text: string, opts: MapOptions = {}): PassportDraft {
  const vin = extractVin(text) || "UNKNOWNVIN0000000";
  const inspection_ts = extractInspectionDate(text);
  const siteExtracted = extractSite(text);
  const site = opts.siteHint ?? siteExtracted ?? undefined;

  const km = extractOdometerKm(text);
  const tyresRaw = extractTyres(text);
  const tyres = {
    fl: clampMm(tyresRaw.fl),
    fr: clampMm(tyresRaw.fr),
    rl: clampMm(tyresRaw.rl),
    rr: clampMm(tyresRaw.rr),
  };

  const dtc = extractDtc(text);

  const now = opts.nowIso || new Date().toISOString().replace("Z", "+02:00");
  const dekraUrl = opts.dekraUrl && /^https?:\/\//i.test(opts.dekraUrl) ? opts.dekraUrl : undefined;

  const draft: PassportDraft = {
    vin,
    lot_id: opts.lotId || "N/A",
    
    dekra: {
      ...(dekraUrl ? { url: dekraUrl } : {}),
      inspection_ts: inspection_ts ?? undefined,
      site,
    },
    odometer: {
      km: km ?? null,
      source: km != null ? "DEKRA" : "n/a",
    },
    tyres_mm: tyres,
    brakes: {
      front_pct: null,
      rear_pct: null,
    },
    dtc: dtc.status === "n/a" && dtc.codes.length === 0 ? undefined : dtc,
    provenance: {
      captured_by: opts.capturedBy || "system",
      site,
      ts: now,
    },
  };

  return draft;
}
