import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sqlText } from '../src/core';
import { execSqlScript, execSql } from '../src/sqlite';
import { exportToFile, importFromBundle } from '../src/transfer';
import { transcriptRelativePath } from '../src/historical-artifacts';
import type { WorkspaceEntry } from '../src/types';

const CHAT = '11111111-1111-4111-8111-111111111111';
const BUBBLE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('production archive transfer preserves external transcripts and historical terminal references across profiles', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'cct-history-integration-'),
  );

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const setup = async (
    name: string,
    source: boolean,
  ): Promise<WorkspaceEntry> => {
    const dir = path.join(root, name);

    await fs.mkdir(dir);

    const workspace: WorkspaceEntry = {
      storageRoot: dir,
      storageId: name,
      key: name,
      mtime: 0,
      globalDbPath: path.join(dir, 'global.vscdb'),
      workspaceDbPath: path.join(dir, 'workspace.vscdb'),
    };

    const terminal = path.join(root, 'source-project/terminals/42.txt');

    const body = {
      composerId: CHAT,
      fullConversationHeadersOnly: [{ bubbleId: BUBBLE, type: 1 }],
      context: { terminalFiles: [{ terminalFilePath: terminal + ':2:4' }] },
    };

    await execSqlScript({
      database: workspace.globalDbPath,
      sql: `
      CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB);
      CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB);
      INSERT INTO ItemTable VALUES('composer.composerHeaders','{"allComposers":[]}');
      ${
        source
          ? `INSERT INTO cursorDiskKV VALUES(${sqlText('composerData:' + CHAT)},${sqlText(JSON.stringify(body))});
      INSERT INTO cursorDiskKV VALUES(${sqlText(`bubbleId:${CHAT}:${BUBBLE}`)},${sqlText(JSON.stringify({ composerId: CHAT, bubbleId: BUBBLE, type: 1, text: 'history fixture', mentions: { terminalFiles: [terminal] } }))});`
          : ''
      }`,
    });

    await execSqlScript({
      database: workspace.workspaceDbPath,
      sql: `CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB);
      INSERT INTO ItemTable VALUES('composer.composerData',${sqlText(JSON.stringify({ allComposers: source ? [{ composerId: CHAT, name: 'History' }] : [] }))});`,
    });

    return workspace;
  };

  const source = await setup('profile-one', true);
  const target = await setup('profile-two', false);
  const sourceProject = path.join(root, 'source-project');
  const targetProject = path.join(root, 'target-project');
  const transcriptBytes = Buffer.from('opaque source UUID ' + CHAT + '\r\n\0');

  for (const layout of ['canonical', 'legacy'] as const)
    for (const extension of ['jsonl', 'txt'] as const) {
      const full = path.join(
        sourceProject,
        'agent-transcripts',
        transcriptRelativePath(CHAT, layout, extension),
      );

      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, transcriptBytes);
    }

  await fs.mkdir(path.join(sourceProject, 'terminals'));

  const terminalBytes = Buffer.from(
    'pid: 987\n<script>not executed</script>\n',
  );

  await fs.writeFile(
    path.join(sourceProject, 'terminals/42.txt'),
    terminalBytes,
  );

  const archive = path.join(root, 'history.zip');

  const summary = await exportToFile(
    { projectArtifactsDir: sourceProject },
    source,
    archive,
    [CHAT],
  );

  assert.equal('skipped' in summary, false);
  const ctx = { projectArtifactsDir: targetProject };

  await importFromBundle(ctx, archive, target);

  const rows = await execSql({
    database: target.globalDbPath,
    sql: "SELECT value FROM cursorDiskKV WHERE key GLOB 'composerData:*';",
  });

  const body = JSON.parse(rows.trim());
  const owner = body.composerId as string;

  assert.notEqual(owner, CHAT);
  for (const layout of ['canonical', 'legacy'] as const)
    for (const extension of ['jsonl', 'txt'] as const)
      assert.deepEqual(
        await fs.readFile(
          path.join(
            targetProject,
            'agent-transcripts',
            transcriptRelativePath(owner, layout, extension),
          ),
        ),
        transcriptBytes,
      );

  const historicalTerminal = path.join(
    targetProject,
    'chat-transit-history',
    owner,
    'terminal-snapshots/42.txt',
  );

  assert.deepEqual(await fs.readFile(historicalTerminal), terminalBytes);

  assert.equal(
    body.context.terminalFiles[0].terminalFilePath,
    historicalTerminal + ':2:4',
  );

  await assert.rejects(fs.stat(path.join(targetProject, 'terminals')), {
    code: 'ENOENT',
  });

  const repeated = await importFromBundle(ctx, archive, target);

  assert.ok(repeated);
  const reexport = path.join(root, 'reexport.zip');

  await exportToFile(ctx, target, reexport, [owner]);
  const third = await setup('profile-three', false);
  const thirdProject = path.join(root, 'third-project');

  await importFromBundle(
    { projectArtifactsDir: thirdProject },
    reexport,
    third,
  );

  const thirdRows = await execSql({
    database: third.globalDbPath,
    sql: "SELECT value FROM cursorDiskKV WHERE key GLOB 'composerData:*';",
  });

  const thirdBody = JSON.parse(thirdRows.trim());

  const thirdTerminal = path.join(
    thirdProject,
    'chat-transit-history',
    thirdBody.composerId,
    'terminal-snapshots/42.txt',
  );

  assert.deepEqual(await fs.readFile(thirdTerminal), terminalBytes);

  assert.equal(
    thirdBody.context.terminalFiles[0].terminalFilePath,
    thirdTerminal + ':2:4',
  );

  assert.deepEqual(
    await fs.readFile(path.join(sourceProject, 'terminals/42.txt')),
    terminalBytes,
  );
});
