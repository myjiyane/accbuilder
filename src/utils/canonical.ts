/**
 * Deterministic canonical JSON: stable key ordering and normalized primitives.
 * This is intentionally simple for Week-1 and can be hardened later.
 */
export function canonicalize(obj: unknown): string {
  return JSON.stringify(sortKeys(obj), replacer);
}

function sortKeys(input: any): any {
  if (Array.isArray(input)) {
    return input.map(sortKeys);
  } else if (input && typeof input === 'object') {
    const out: Record<string, any> = {};
    for (const key of Object.keys(input).sort()) {
      out[key] = sortKeys((input as any)[key]);
    }
    return out;
  }
  return input;
}

function replacer(_key: string, value: any) {
  if (typeof value === 'number') {
    // Normalize to max 3 decimals for mm / pct if accidental floats occur
    return Math.round(value * 1000) / 1000;
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  return value;
}