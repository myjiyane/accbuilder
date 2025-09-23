import { describe, it, expect } from 'vitest';
import { validateDraft, validateSealed } from '../src/schema/index.js';
import draftJson from '../samples/sample-passport-draft.json' with { type: 'json' };
import sealedJson from '../samples/sample-passport-sealed.json' with { type: 'json' };

describe('schemas', () => {
  it('validates draft sample', () => {
    expect(validateDraft(draftJson as any)).toBe(true);
  });
  it('validates sealed sample', () => {
    expect(validateSealed(sealedJson as any)).toBe(true);
  });
});
