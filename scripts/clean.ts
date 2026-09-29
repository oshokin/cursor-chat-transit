import fs from 'node:fs/promises';
import path from 'node:path';

/** Build output only. Keep .dev profiles, exports, dependencies and user data. */
async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..');
  for (const name of ['out', 'dist', 'coverage']) {
    await fs.rm(path.join(root, name), { recursive: true, force: true });
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
