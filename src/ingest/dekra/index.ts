/**
 * src/ingest/dekra/index.ts
 * Barrel exports for DEKRA ingest (loader + extractors + mapper).
 */

export type { DtcStatus, DtcCode, TyreDepths } from "./extractors.js";
export {
  extractVin,
  extractInspectionDate,
  extractSite,
  extractOdometerKm,
  extractTyres,
  extractDtc,
  normalizeDateIso,
} from "./extractors.js";

export type { LoadedPdf } from "./loaders.js";
export {
  listPdfs,
  loadPdf,
  loadPdfText,
  loadManyPdfTexts,
  normalizeWhitespace,
} from "./loaders.js";

export type { MapOptions } from "./mapper.js";
export { mapToPassportDraft } from "./mapper.js";
