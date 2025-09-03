/**
 * src/ingest/dekra/extractors.ts
 * Heuristic extractors for DEKRA PDFs → primitive fields we’ll map into PassportDraft.
 * Week-1 scope: text-based PDFs (no OCR), simple regex + proximity.
 */

export type DtcStatus = 'green' | 'amber' | 'red' | 'n/a';
export interface DtcCode { code: string; desc?: string }
export interface TyreDepths { fl: number | null; fr: number | null; rl: number | null; rr: number | null }

const VIN_RE = /\b([A-HJ-NPR-Z0-9]{17})\b/; // ISO VIN (no I,O,Q)
const DATE_LABEL_RE =
  /(Inspection\s*Date|Inspected\s*on|Date\s*of\s*Inspection|Report\s*Date|Date)\s*:?\s*([0-3]?\d[\/.-][01]?\d[\/.-](?:\d{2}|\d{4}))\b/i;
const ANY_DATE_RE = /\b([0-3]?\d)[\/.-]([01]?\d)[\/.-](\d{2}|\d{4})\b/;

const ODO_RE = /(Km\s*Reading|Odometer|Mileage)\s*:?\s*([0-9][0-9,.\s]+)\s*(KM|km|Miles|mi)?/i;
const TYRE_HINT_RE = /(Tyre|Tire|Tread|Tyre\s*Specification|Tyre\s*Measurement)/i;

const GENERIC_DTC_RE = /\b([PCBU]\d{4})\b/gi;                   // OBD-II style
const OEM_DTC_RE = /\b([A-Z]{1,3}\s?[A-Z0-9]{3,8})\b/g;         // manufacturer-ish tokens
const DTC_NEGATION_RE = /no\s+active\s+error\s+messages?/i;

const STOP_WORDS = new Set([
  'DEKRA','REPORT','VEHICLE','INSPECTION','CONDITION','DOCUMENT','RISK','VIN','DATE',
  'PASSENGER','AUTOMATIC','DIESEL','PETROL','WHITE','BLACK','BRACKENFELL','C','CLASS','SEDAN',
  'HATCHBACK','WE','BUY','CARS','CAPE','TOWN','RANDburg','UBER','SHUTTLE'
].map(s => s.toUpperCase()));

/** Trim + collapse inner whitespace (keeps newlines). */
const norm = (s: string) =>
  s.replace(/[ \t]+/g, ' ').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** dd/mm/(yy|yyyy) → ISO with +02:00 */
export function normalizeDateIso(input?: string): string | undefined {
  if (!input) return undefined;
  const m = input.match(ANY_DATE_RE);
  if (!m) return undefined;
  const dd = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const yy = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
  if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yy)) return undefined;
  const dt = new Date(Date.UTC(yy, mm - 1, dd, 0, 0, 0));
  return dt.toISOString().replace('Z', '+02:00'); // SAST
}

/** First ISO-valid VIN token we see. */
export function extractVin(text: string): string | undefined {
  // primary: raw 17-char VIN anywhere
  let m = VIN_RE.exec(text);
  if (m) return m[1];

  // fallback: look for a labelled line like "VIN: WDD..." or "VIN / Chassis: ..."
  for (const line of text.split(/\r?\n/)) {
    const ml = line.match(/VIN[^A-HJ-NPR-Z0-9]*([A-HJ-NPR-Z0-9]{17})/i);
    if (ml) return ml[1];
  }
  return undefined;
}

/** Prefer labelled date; fallback to first date token in the doc. */
export function extractInspectionDate(text: string): string | undefined {
  const t = norm(text);
  const labelled = DATE_LABEL_RE.exec(t);
  if (labelled) return normalizeDateIso(labelled[2]);
  const any = ANY_DATE_RE.exec(t);
  return normalizeDateIso(any?.[0]);
}

/** Grab a plausible site/branch line near keywords. */
export function extractSite(text: string): string | undefined {
  const lines = norm(text).split('\n');
  const idx = lines.findIndex(l => /(DEKRA|Inspection\s*Location|We\s*Buy\s*Cars|Branch|Randburg|Brackengate|Cape Town)/i.test(l));
  if (idx >= 0) {
    // Return this line; if it’s too generic, append the next non-empty line
    const here = lines[idx].trim();
    const next = lines.slice(idx + 1).find(l => l.trim().length > 3) || '';
    return (here + ' ' + next).trim().slice(0, 160);
  }
  // Fallback: first line containing “DEKRA”
  const alt = lines.find(l => /DEKRA/i.test(l));
  return alt?.trim();
}

/** Find odometer; convert miles→km if needed; round to int. */
export function extractOdometerKm(text: string): number | null {
  const m = ODO_RE.exec(text);
  if (!m) return null;
  const raw = m[2].replace(/[, ]/g, '');
  const unit = (m[3] || 'KM').toLowerCase();
  const val = Number.parseFloat(raw);
  if (!Number.isFinite(val)) return null;
  const km = unit.startsWith('mi') ? val * 1.60934 : val;
  return Math.round(km);
}

/**
 * Extract tyre depths (mm). Strategy: collect a small block of lines that look
 * like the tyre/tread table, then pick the first 4 “N mm” numbers as FL,FR,RL,RR.
 * Week-1 heuristic (good enough for common DEKRA layouts).
 */
export function extractTyres(text: string): TyreDepths {
  const lines = norm(text).split('\n');
  const blockLines: string[] = [];
  for (const l of lines) if (TYRE_HINT_RE.test(l)) blockLines.push(l);
  const block = blockLines.join('\n');
  const mm = [...block.matchAll(/(\d+(?:\.\d+)?)\s*mm/gi)].map(m => parseFloat(m[1]));
  const [fl, fr, rl, rr] = mm.slice(0, 4);
  return {
    fl: Number.isFinite(fl) ? fl : null,
    fr: Number.isFinite(fr) ? fr : null,
    rl: Number.isFinite(rl) ? rl : null,
    rr: Number.isFinite(rr) ? rr : null,
  };
}

/**
 * Extract diagnostic trouble codes (very lightweight).
 * - If “no active error messages” → green, [].
 * - Else collect up to 10 distinct code-like tokens, mark amber.
 * Note: many DEKRA PDFs include OEM codes, not pure OBD-II “P0xxx”.
 */
export function extractDtc(text: string): { status: DtcStatus; codes: DtcCode[] } {
  if (DTC_NEGATION_RE.test(text)) return { status: 'green', codes: [] };

  const tokens: string[] = [];
  for (const m of text.matchAll(GENERIC_DTC_RE)) tokens.push(m[1]);
  for (const m of text.matchAll(OEM_DTC_RE)) tokens.push(m[1]);

  // Normalize + filter stop-words
  const cleaned = tokens
    .map(t => t.trim())
    .filter(t => t.length >= 3)
    .filter(t => !STOP_WORDS.has(t.toUpperCase()));

  // Deduplicate, cap to 10
  const seen = new Set<string>();
  const codes: DtcCode[] = [];
  for (const c of cleaned) {
    const key = c.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      codes.push({ code: c });
      if (codes.length >= 10) break;
    }
  }

  return { status: codes.length ? 'amber' : 'n/a', codes };
}
