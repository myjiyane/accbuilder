/**
 * src/crypto/sealer-local.ts
 * Local ECDSA sealer (EC P-256) over the CANONICAL JSON string.
 * - Stores seal.hash = hex(SHA-256(canonical JSON))
 * - Stores seal.sig  = base64(DER-encoded ECDSA signature)
 * - key_id defaults to "local-ec-p256-v1" (overrideable per call)
 *
 * This is designed to be swapped with a KMS-backed implementation later
 * by keeping the same function shapes.
 */

import { createHash, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import type { PassportDraft, PassportSealed } from "../types/passport.js";
import { canonicalize } from "../utils/canonical.js";
import { validateDraft } from "../schema/index.js";

/** Compute SHA-256 hex hash of a UTF-8 string */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(Buffer.from(input, "utf8")).digest("hex");
}

/** Sign arbitrary UTF-8 content with ECDSA P-256, returning base64 DER */
export function ecdsaSignBase64DER(contentUtf8: string, privateKeyPem: string): string {
  const sig = nodeSign("sha256", Buffer.from(contentUtf8, "utf8"), {
    key: privateKeyPem,
  });
  return sig.toString("base64");
}

/** Verify a base64-DER ECDSA P-256 signature over UTF-8 content */
export function ecdsaVerifyBase64DER(
  contentUtf8: string,
  signatureB64: string,
  publicKeyPem: string
): boolean {
  return nodeVerify(
    "sha256",
    Buffer.from(contentUtf8, "utf8"),
    { key: publicKeyPem },
    Buffer.from(signatureB64, "base64")
  );
}

/**
 * Seal a PassportDraft (must validate) with a local private key.
 * Returns a new object of type PassportSealed.
 */
export function sealPassportDraft(
  draft: PassportDraft,
  options: {
    privateKeyPem: string;
    keyId?: string; // default "local-ec-p256-v1"
    sealedAtIso?: string; // override timestamp in tests
  }
): PassportSealed {
  const ok = validateDraft(draft);
  if (!ok) {
    const errs = JSON.stringify(validateDraft.errors, null, 2);
    throw new Error(`PassportDraft failed schema validation; cannot seal.\n${errs}`);
  }

  // IMPORTANT: never include `seal` in the canonical string
  const canonical = canonicalize(draft);
  const hashHex = sha256Hex(canonical);
  const sigB64 = ecdsaSignBase64DER(canonical, options.privateKeyPem);
  const sealed_ts = (options.sealedAtIso || new Date().toISOString()).replace("Z", "+02:00");

  const sealed: PassportSealed = {
    ...draft,
    seal: {
      hash: hashHex,
      sig: sigB64,
      key_id: options.keyId || "local-ec-p256-v1",
      sealed_ts,
    },
  };
  return sealed;
}

/**
 * Verify an already-sealed passport with a local public key:
 * - recompute canonical JSON (excluding seal)
 * - check SHA-256 matches seal.hash
 * - ECDSA verify seal.sig with publicKeyPem
 */
export function verifySealedPassport(
  sealed: PassportSealed,
  publicKeyPem: string
): { valid: boolean; reasons?: string[] } {
  const reasons: string[] = [];
  // Rebuild canonical WITHOUT the seal block
  const { seal, ...withoutSeal } = sealed as any;
  const canonical = canonicalize(withoutSeal);
  const hashHex = sha256Hex(canonical);

  if (!seal || typeof seal.sig !== "string" || typeof seal.hash !== "string") {
    reasons.push("missing seal fields");
    return { valid: false, reasons };
  }
  if (hashHex !== seal.hash) {
    reasons.push("hash mismatch");
  }
  const sigOk = ecdsaVerifyBase64DER(canonical, seal.sig, publicKeyPem);
  if (!sigOk) {
    reasons.push("signature verify failed");
  }
  return { valid: reasons.length === 0, reasons: reasons.length ? reasons : undefined };
}
