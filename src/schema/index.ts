/**
 * src/schema/index.ts
 * AJV (2020-12) validators for PassportDraft & PassportSealed.
 */

import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import draft from "./passportDraft.schema.json" assert { type: "json" };
import sealed from "./passportSealed.schema.json" assert { type: "json" };
import type { JSONSchemaType } from "ajv";
import type { PassportDraft, PassportSealed } from "../types/passport.js";

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
