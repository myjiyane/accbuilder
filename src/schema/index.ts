import Ajv, {JSONSchemaType} from 'ajv';
import addFormats from 'ajv-formats';
import draft from './passportDraft.schema.json' assert { type: 'json' };
import sealed from './passportSealed.schema.json' assert { type: 'json' };
import type { PassportDraft, PassportSealed } from '../types/passport.js';

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);

export const validateDraft = ajv.compile<PassportDraft>(draft as unknown as JSONSchemaType<PassportDraft>);
export const validateSealed = ajv.compile<PassportSealed>(sealed as unknown as JSONSchemaType<PassportSealed>);