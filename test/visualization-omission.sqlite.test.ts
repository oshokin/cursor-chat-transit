import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sqlText } from '../src/core';
import { execSqlScript } from '../src/sqlite';
import { exportToFile } from '../src/transfer';
import { openBundle } from '../src/bundle-reader';
import { inspectChatHealth } from '../src/chat-health';
import { connOf } from '../src/transfer-context';
import { openReadTransaction } from '../src/read-transaction';
import type { WorkspaceEntry } from '../src/types';

/** Synthetic identities keep these tests entirely outside real Cursor data. */
const CHAT = '11111111-1111-4111-8111-111111111111';
const BUBBLE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Each case runs the archive writer and the production read-only check. */
const cases = [
  {
    name: 'composer renderer reference',
    body: { kind: 'visualization', src: 'chart.html' },
    bubble: {},
    count: 1,
  },
  {
    name: 'bubble renderer attribs',
    body: {},
    bubble: {
      attribs: { kind: 'visualization', src: 'visualizations/chart.html' },
    },
    count: 1,
  },
  {
    name: 'bubble renderer properties',
    body: {},
    bubble: { properties: { kind: 'visualization', src: ' chart.html ' } },
    count: 1,
  },
  {
    name: 'duplicate renderer and tool references count distinct filenames',
    body: {
      references: [
        { kind: 'visualization', src: 'chart.html' },
        { params: { relativeWorkspacePath: 'visualizations/chart.html' } },
      ],
    },
    bubble: {
      references: [
        {
          attribs: { kind: 'visualization', src: 'visualizations/chart.html' },
        },
        { properties: { kind: 'visualization', src: 'second.html' } },
        { params: { targetFile: '/synthetic/visualizations/second.html' } },
      ],
    },
    count: 2,
  },
  {
    name: 'tool-only references remain recognized',
    body: {
      toolCall: {
        params: { targetFile: '/synthetic/visualizations/chart.html' },
      },
    },
    bubble: {},
    count: 1,
  },
  {
    name: 'arbitrary text paths and unsafe renderer sources do not degrade chats',
    body: {
      text: 'visualizations/chart.html',
      rawText: '/synthetic/visualizations/chart.html',
      thinking: { kind: 'visualization', src: 'chart.html' },
      uri: { path: '/synthetic/visualizations/chart.html' },
      arbitrary: 'visualizations/chart.html',
    },
    bubble: {
      references: [
        { type: 'visualization', src: 'chart.html' },
        { kind: 'image', src: 'chart.html' },
        { src: 'chart.html' },
        { kind: 'visualization', src: '../chart.html' },
        { kind: 'visualization', src: '/synthetic/visualizations/chart.html' },
        { kind: 'visualization', src: 'visualizations/../chart.html' },
        { kind: 'visualization', src: 'chart.html?query' },
        { params: { targetFile: '/synthetic/not-visualizations/chart.html' } },
      ],
    },
    count: 0,
  },
];

for (const scenario of cases) {
  test(`visualization omission: ${scenario.name}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cct-visualization-'));

    t.after(() => fs.rm(root, { recursive: true, force: true }));

    const workspace: WorkspaceEntry = {
      storageRoot: root,
      storageId: 'fixture',
      key: 'fixture',
      mtime: 0,
      globalDbPath: path.join(root, 'User', 'globalStorage', 'state.vscdb'),
      workspaceDbPath: path.join(root, 'workspace.vscdb'),
    };

    await fs.mkdir(path.dirname(workspace.globalDbPath), { recursive: true });
    const header = { composerId: CHAT, name: 'Visualization fixture' };

    const body = {
      composerId: CHAT,
      fullConversationHeadersOnly: [{ bubbleId: BUBBLE, type: 1 }],
      ...scenario.body,
    };

    const bubble = {
      composerId: CHAT,
      bubbleId: BUBBLE,
      type: 1,
      text: 'Synthetic message',
      ...scenario.bubble,
    };

    await execSqlScript({
      database: workspace.globalDbPath,
      sql: `
      CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB);
      CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB);
      INSERT INTO cursorDiskKV VALUES(${sqlText(`composerData:${CHAT}`)},${sqlText(JSON.stringify(body))});
      INSERT INTO cursorDiskKV VALUES(${sqlText(`bubbleId:${CHAT}:${BUBBLE}`)},${sqlText(JSON.stringify(bubble))});`,
    });

    await execSqlScript({
      database: workspace.workspaceDbPath,
      sql: `
      CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB);
      INSERT INTO ItemTable VALUES('composer.composerData',${sqlText(JSON.stringify({ allComposers: [header] }))});`,
    });

    // HTML is hostile, not an input to export or inspection. Fail on attempted reads.
    const htmlDir = path.join(root, 'visualizations');

    await fs.mkdir(htmlDir);
    const marker = path.join(root, 'executed');
    const html = `<script>require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')</script>`;

    await fs.writeFile(path.join(htmlDir, 'chart.html'), html);
    let htmlReads = 0;

    for (const method of ['readFile', 'open'] as const) {
      const original = fs[method].bind(fs);

      t.mock.method(fs, method, (...args: unknown[]) => {
        if (String(args[0]).endsWith('.html')) {
          htmlReads++;

          throw new Error('Visualization HTML must never be read');
        }

        return Reflect.apply(original, fs, args);
      });
    }

    const hash = async (file: string) =>
      createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex');

    const before = await Promise.all([
      hash(workspace.globalDbPath),
      hash(workspace.workspaceDbPath),
    ]);

    const notes: string[] = [];

    const ctx = {
      timeoutMs: 10000,
      onNote: (note: string) => {
        notes.push(note);
      },
    };

    const dest = path.join(root, 'export.zip');
    const summary = await exportToFile(ctx, workspace, dest, [CHAT]);

    assert.equal('skipped' in summary, false);
    if ('skipped' in summary) return;
    assert.equal(summary.exported, 1);
    assert.equal(summary.complete, scenario.count === 0);
    assert.deepEqual(summary.incomplete, scenario.count ? [CHAT] : []);

    assert.deepEqual(
      summary.issues || [],
      scenario.count
        ? [
            {
              ...header,
              reason: 'missing-visualizations',
              omittedVisualizations: scenario.count,
            },
          ]
        : [],
    );

    const bundle = await openBundle(dest);

    try {
      assert.deepEqual(bundle.manifest.summary, summary);
      const entries = await fs.readdir(bundle.root, { recursive: true });

      assert.equal(
        entries.some((entry) => /\.html$/.test(entry)),
        false,
      );

      assert.equal(
        entries.some((entry) =>
          entry.split(path.sep).includes('visualizations'),
        ),
        false,
      );
    } finally {
      await bundle.close();
    }

    notes.length = 0;

    const view = await openReadTransaction(
      connOf(ctx, workspace.globalDbPath, true),
    );

    try {
      assert.equal(
        await inspectChatHealth(ctx, workspace, view.conn, header),
        scenario.count ? 'incomplete' : 'ready',
      );
    } finally {
      await view.close();
    }

    assert.equal(
      notes.some((note) =>
        note.includes(
          `${scenario.count} referenced visualization HTML files are missing`,
        ),
      ),
      scenario.count > 0,
    );

    assert.deepEqual(
      await Promise.all([
        hash(workspace.globalDbPath),
        hash(workspace.workspaceDbPath),
      ]),
      before,
    );

    assert.equal(htmlReads, 0);
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  });
}
