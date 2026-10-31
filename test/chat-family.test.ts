import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildFamily,
  exportFamilyIds,
  familyImportAdjustments,
  keptParentNote,
  narrowDeletion,
  remapFamilyRecord,
  topLevelChats,
  withoutDeletedSubagents,
} from '../src/chat-family';
import { headerUpsertSql } from '../src/db-write';
import { remapValue } from '../src/import-bundle-publish';
import { execSql, execSqlScript } from '../src/sqlite';
import { findSqliteExecutable } from './support/sqlite-cli';
import type { ComposerHeader } from '../src/types';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function header(
  composerId: string,
  extra: Partial<ComposerHeader> = {},
): ComposerHeader {
  return { composerId, ...extra };
}

test('a child hangs under its direct parent, including a grandchild', () => {
  const headers = [
    header(A, { subagentComposerIds: [B] }),
    header(B, {
      isSubagent: true,
      subagentInfo: {
        parentComposerId: A,
        rootParentConversationId: A,
        subagentTypeName: 'generalPurpose',
      },
      subagentComposerIds: [C],
    }),
    header(C, {
      isSubagent: true,
      subagentInfo: {
        parentComposerId: B,
        rootParentConversationId: A,
        subagentTypeName: 'explore',
      },
    }),
  ];

  const graph = buildFamily(headers);

  assert.equal(graph.nodes.get(C)?.parentComposerId, B);
  assert.equal(graph.nodes.get(C)?.rootComposerId, A);
  assert.deepEqual(graph.nodes.get(B)?.childComposerIds, [C]);

  assert.deepEqual(
    topLevelChats(headers).map((item) => item.composerId),
    [A],
  );

  assert.equal(graph.nodes.get(C)?.relation, 'child');
  assert.deepEqual(exportFamilyIds(headers, [A]).ids.sort(), [A, B, C].sort());
  assert.deepEqual(exportFamilyIds(headers, [C]).ids.sort(), [A, B, C].sort());
});

test('a cycle and a missing parent stay unresolved', () => {
  const cycle = buildFamily([
    header(A, {
      isSubagent: true,
      subagentInfo: { parentComposerId: B },
    }),
    header(B, {
      isSubagent: true,
      subagentInfo: { parentComposerId: A },
    }),
  ]);

  assert.equal(
    cycle.diagnostics.some((item) => item.code === 'cycle'),
    true,
  );

  assert.equal(cycle.nodes.get(A)?.relation, 'unresolved');

  const missing = buildFamily([
    header(A, {
      isSubagent: true,
      subagentInfo: { parentComposerId: B },
    }),
  ]);

  assert.equal(missing.nodes.get(A)?.relation, 'unresolved');
  assert.equal(missing.diagnostics[0]?.code, 'missing-parent');
});

test('Best-of-N does not set the subagent column', async () => {
  const executable = findSqliteExecutable(process.env.SQLITE3_PATH);

  if (!executable) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cct-subagent-flag-'));

  try {
    const conn = {
      database: path.join(dir, 'db.sqlite'),
    };

    await execSqlScript({
      ...conn,
      sql:
        'CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY, value TEXT, isSubagent INTEGER);' +
        headerUpsertSql(
          [
            header(B, {
              isBestOfNSubcomposer: false,
              isSubagent: true,
              subagentInfo: { parentComposerId: A },
            }),
          ],
          'ws',
          ['composerId', 'value', 'isSubagent'],
        ),
    });

    assert.equal(
      (
        await execSql({
          ...conn,
          sql: 'SELECT isSubagent FROM composerHeaders;',
        })
      ).trim(),
      '1',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('family references use the destination composer map', async () => {
  const result = await remapValue(
    {
      ordinal: 1,
      row: { sourceId: B, targetId: 'new-child' } as never,
      work: {
        queryLines: async (_sql: string, onLine: (line: string) => void) => {
          onLine(JSON.stringify([A, 'new-root']));
          onLine(JSON.stringify([C, 'new-grand']));
        },
      } as never,
      plansDir: '/tmp/plans',
      canvasesDir: null,
      workspace: {} as never,
    },
    {
      composerId: B,
      text: `keep ${A} in the message`,
      subagentInfo: {
        parentComposerId: A,
        rootParentConversationId: A,
        toolCallId: 'tool_1',
      },
      subagentComposerIds: [C],
    },
    '',
    '',
  );

  const info = result.subagentInfo as {
    parentComposerId: string;
    toolCallId: string;
  };

  assert.equal(info.parentComposerId, 'new-root');
  assert.equal(info.toolCallId, 'tool_1');
  assert.deepEqual(result.subagentComposerIds, ['new-grand']);
  assert.equal(result.text, `keep ${A} in the message`);

  assert.equal(
    remapFamilyRecord(
      { subagentInfo: { parentComposerId: A } },
      new Map([[A, 'dest']]),
    ).subagentInfo &&
      (
        remapFamilyRecord(
          { subagentInfo: { parentComposerId: A } },
          new Map([[A, 'dest']]),
        ).subagentInfo as { parentComposerId: string }
      ).parentComposerId,
    'dest',
  );
});

test('a parent stays when a subagent is not selected', () => {
  const headers = [
    { composerId: A, name: 'Parent', subagentComposerIds: [B, C] },
    {
      composerId: B,
      name: 'Child',
      subagentInfo: { parentComposerId: A },
    },
    {
      composerId: C,
      name: 'Other',
      subagentInfo: { parentComposerId: A },
    },
  ];

  const narrowed = narrowDeletion(headers, [A, B]);

  assert.deepEqual(narrowed.deleteIds, [B]);
  assert.equal(narrowed.kept[0]?.composerId, A);

  assert.equal(
    keptParentNote(narrowed.kept),
    'Parent kept: 1 subagent was not selected',
  );

  assert.deepEqual(
    withoutDeletedSubagents(
      { text: `keep ${B}`, subagentComposerIds: [B, C] },
      new Set([B]),
    ).subagentComposerIds,
    [C],
  );
});

test('a changed subagent copies the whole family', () => {
  const parent = {
    composerId: A,
    subagentComposerIds: [B],
  };

  const child = {
    composerId: B,
    subagentInfo: { parentComposerId: A },
  };

  const same = familyImportAdjustments([
    { sourceId: A, decision: 'skip', header: parent },
    { sourceId: B, decision: 'skip', header: child },
  ]);

  assert.deepEqual(same.promote, []);
  assert.deepEqual(same.drop, []);

  const changed = familyImportAdjustments([
    { sourceId: A, decision: 'skip', header: parent },
    { sourceId: B, decision: 'create', header: child },
  ]);

  assert.deepEqual(changed.promote, [A]);

  const orphan = familyImportAdjustments([
    { sourceId: B, decision: 'create', header: child },
  ]);

  assert.deepEqual(orphan.drop, [B]);
});

test('a missing ancestor drops the descendant chain', () => {
  const dropped = familyImportAdjustments([
    {
      sourceId: 'child',
      decision: 'create',
      header: {
        composerId: 'child',
        subagentInfo: { parentComposerId: 'absent' },
        subagentComposerIds: ['grand'],
      },
    },
    {
      sourceId: 'grand',
      decision: 'create',
      header: {
        composerId: 'grand',
        subagentInfo: {
          parentComposerId: 'child',
          rootParentConversationId: 'absent',
        },
      },
    },
  ]).drop.sort();

  assert.deepEqual(dropped, ['child', 'grand']);
});

test('a contradictory root and a missing child are diagnosed', () => {
  const conflict = buildFamily([
    { composerId: 'root' },
    { composerId: 'other' },
    {
      composerId: 'child',
      subagentInfo: {
        parentComposerId: 'root',
        rootParentConversationId: 'other',
      },
    },
  ]);

  assert.ok(conflict.diagnostics.some((item) => item.composerId === 'child'));

  const missing = buildFamily([
    { composerId: 'root', subagentComposerIds: ['absent'] },
  ]);

  assert.ok(missing.diagnostics.length > 0);
});
