import fs from 'node:fs';
import path from 'node:path';
import { validateDraft, validateSealed } from './schema/index.js';
import { canonicalize } from './utils/canonical.js';

const args = process.argv.slice(2);
if (args[0] === '--validate') {
  const kind = args[1];
  const file = args[2];
  if (!file) {
    console.error('Usage: tsx src/index.ts --validate <draft|sealed> <file.json>');
    process.exit(1);
  }
  const json = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (kind === 'draft') {
    const ok = validateDraft(json);
    console.log('draft valid?', ok);
    if (!ok) console.error(validateDraft.errors);
  } else {
    const ok = validateSealed(json);
    console.log('sealed valid?', ok);
    if (!ok) console.error(validateSealed.errors);
  }
  console.log('canonical bytes:', Buffer.byteLength(canonicalize(json), 'utf8'));
} else {
  console.log('Usage: tsx src/index.ts --validate <draft|sealed> <file.json>');
}