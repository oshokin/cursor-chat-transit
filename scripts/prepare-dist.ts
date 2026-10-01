import fs from 'node:fs';
import path from 'node:path';

/** Ensure `dist/` exists before vsce writes the VSIX. */
const root = path.resolve(__dirname, '..');
/** Destination directory for the packaged VSIX. */
const dir = path.join(root, 'dist');

fs.mkdirSync(dir, { recursive: true });
