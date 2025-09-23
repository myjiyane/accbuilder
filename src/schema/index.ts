/**
 * src/schema/index.ts
 * AJV (2020-12) validators for PassportDraft & PassportSealed.
 */

import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import draft from "./passportDraft.schema.json" with { type: "json" };
import sealed from "./passportSealed.schema.json" with { type: "json" };
import type { JSONSchemaType } from "ajv";
import type { PassportDraft, PassportSealed } from "../types/passport.js";

const Ajv2020 = Ajv2020Import as unknown as new (opts?: any) => import("ajv").default;
const addFormats = addFormatsImport as unknown as (ajv: import("ajv").default) => unknown;

export const ajv = new Ajv2020({
  allErrors: true,
  strict: "log",
  unevaluated: true,
});

addFormats(ajv);

ajv.addSchema(draft);

export const validateDraft = ajv.compile<PassportDraft>(
  draft as unknown as JSONSchemaType<PassportDraft>
);

export const validateSealed = ajv.compile<PassportSealed>(
  sealed as unknown as JSONSchemaType<PassportSealed>
);
