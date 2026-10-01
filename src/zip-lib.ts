import { createRequire } from 'node:module';
import path from 'node:path';

/** `require` aimed at the vendored ZIP packages. */
const load = createRequire(__filename);

/** Directory of the bundled yazl and yauzl builds. */
const vendor = path.join(__dirname, '..', 'vendor');

/** yazl loaded by path, not by package name. */
export const yazl = load(path.join(vendor, 'yazl')) as typeof import('yazl');

/** yauzl loaded by path, not by package name. */
export const yauzl = load(path.join(vendor, 'yauzl')) as typeof import('yauzl');
