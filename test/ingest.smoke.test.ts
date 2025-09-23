import { describe, it, expect } from "vitest";
import { mapToPassportDraft } from "../src/ingest/dekra/mapper.js";
import { validateDraft } from "../src/schema/index.js";

const SAMPLE_TEXT = `
DEKRA We Buy Cars - Brackengate
Inspection Date: 29/04/2024
VIN WDD2040082R088866
Km Reading 238,574 KM
Tyre Specification & Measurement
FL 1 mm FR 0 mm RL 2 mm RR 2 mm
Diagnostic: no active error messages
`;

describe("DEKRA mapper → PassportDraft", () => {
  it("produces a schema-valid draft from typical text", () => {
    const draft = mapToPassportDraft(SAMPLE_TEXT, { lotId: "SAMPLE-LOT" });
    const ok = validateDraft(draft);
    if (!ok) console.error(validateDraft.errors);
    expect(ok).toBe(true);
    expect(draft.vin).toBe("WDD2040082R088866");
    expect(draft.odometer?.km).toBe(238574);
    expect(draft.tyres_mm?.fl).toBe(1);
    expect(draft.dtc?.status).toBe("green");
  });
});
