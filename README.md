# WesBank Passport — Week 1 / W1-01 Schema

This is the VS Code-friendly starter for **W1-01 — Passport Schema v0.1** with TypeScript + AJV.

## Quick start

```bash
# From project root
npm install
npm run dev -- --validate draft samples/sample-passport-draft.json
npm run dev -- --validate sealed samples/sample-passport-sealed.json

# or
npm run test
```

## Structure
- `src/types/passport.ts` — TypeScript types for Draft & Sealed passport
- `src/schema/*.schema.json` — JSON Schemas (Draft & Sealed)
- `src/schema/index.ts` — AJV validators
- `src/utils/canonical.ts` — deterministic canonicalizer (used later by sealing)
- `samples/` — example payloads
- `test/` — vitest-based validation tests

## Notes
- VIN uses pattern `^[A-HJ-NPR-Z0-9]{17}$` (no I, O, Q).
- DTC codes pattern `^[PCBU][0-9]{4}$`.
- Sealed schema requires `seal` block (hash, sig, key_id, sealed_ts).

## Next
- W1-02: PDF→JSON mapper will output `PassportDraft` that validates against `passportDraft.schema.json`.
- W1-03: `canonicalize()` is ready; sealing adapter will consume its output in W1-05.