import fs from 'node:fs/promises';
import path from 'node:path';

/** Bundle runtime-only JS and all eight upstream prebuilds for an offline universal VSIX. */
async function main(): Promise<void> {
  const source = path.dirname(require.resolve('better-sqlite3/package.json'));

  const metadata = JSON.parse(
    await fs.readFile(path.join(source, 'package.json'), 'utf8'),
  ) as { version: string };

  if (metadata.version !== '13.0.3')
    throw new Error(
      'Unexpected SQLite binding version; review and update the packaged engine deliberately.',
    );
  const target = path.resolve(__dirname, '../vendor/better-sqlite3');

  await fs.mkdir(target, { recursive: true });

  for (const name of ['lib', 'prebuilds', 'LICENSE']) {
    await fs.cp(path.join(source, name), path.join(target, name), {
      recursive: true,
      force: true,
    });
  }

  await fs.writeFile(
    path.join(target, 'package.json'),
    JSON.stringify(
      {
        name: 'better-sqlite3',
        version: '13.0.3',
        main: 'lib/index.js',
        license: 'MIT',
      },
      null,
      2,
    ) + '\n',
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
