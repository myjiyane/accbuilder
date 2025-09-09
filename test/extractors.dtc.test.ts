import { describe, it, expect } from "vitest";
import { extractDtc } from "../src/ingest/dekra/extractors";

describe("extractDtc", () => {
  it("returns green with no codes when explicit no-fault text", () => {
    const t = "Diagnostic Trouble Codes: No fault codes found.";
    const out = extractDtc(t);
    expect(out.status).toBe("green");
    expect(out.codes).toEqual([]);
  });

  it("finds proper OBD-II codes and ignores random words", () => {
    const t = "USED CAR REPORT MERCEDES-BENZ COMMON TEXT\nDTC: P0420, P0301 pending";
    const out = extractDtc(t);
    expect(out.codes.map(c => c.code)).toEqual(["P0420", "P0301"]);
    expect(out.status).toBe("amber");
  });

  it("marks red when MIL ON or current", () => {
    const t = "MIL ON. Stored DTCs: U0100 P0700";
    const out = extractDtc(t);
    expect(out.status).toBe("red");
    expect(out.codes.map(c => c.code)).toEqual(["U0100", "P0700"]);
  });

  it("n/a when no DTC section and no codes", () => {
    const t = "Random PDF text without any diagnostic section.";
    const out = extractDtc(t);
    expect(out.status).toBe("n/a");
    expect(out.codes).toEqual([]);
  });
});
