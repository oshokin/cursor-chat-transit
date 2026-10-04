import test from 'node:test';
import assert from 'node:assert/strict';
import { indexGlobalHeaders } from '../src/header-index';
import { matchesWorkspaceStorage, type HeaderSource } from '../src/db-headers';
import type { WorkspaceEntry } from '../src/types';

test('indexed header lookup preserves explicit binding, URI fallback, duplicates and source order', () => {
  const uri = { scheme: 'file', authority: '', path: '/same' };

  const sources: HeaderSource[] = [
    {
      source: 'blob',
      records: [
        { composerId: 'duplicate', workspaceIdentifier: { uri } },
        {
          composerId: 'duplicate',
          name: 'later explicit',
          workspaceIdentifier: { id: 'a' },
        },
        { composerId: 'other', workspaceIdentifier: { id: 'b', uri } },
        { composerId: 'unbound' },
        { composerId: 'fallback', workspaceIdentifier: { id: '', uri } },
        {
          composerId: 'invalid',
          workspaceIdentifier: { uri: { scheme: '', authority: '', path: '' } },
        },
      ],
    },
  ];

  const lookup = indexGlobalHeaders(sources);

  for (const storageId of ['a', 'b', 'c']) {
    const workspace = {
      storageId,
      identity: { kind: 'folder', uri },
    } as WorkspaceEntry;

    assert.deepEqual(
      lookup(workspace),
      sources.map((source) => ({
        ...source,
        records: source.records.filter((h) =>
          matchesWorkspaceStorage(h, workspace.storageId, workspace.identity),
        ),
      })),
    );
  }
});

test('many indexed lookups inspect only their buckets after the one-time build', () => {
  let identityReads = 0;

  const records = Array.from({ length: 10000 }, (_, i) => ({
    composerId: `chat-${i}`,
    get workspaceIdentifier() {
      identityReads++;

      return { id: `workspace-${i % 1000}` };
    },
  }));

  const lookup = indexGlobalHeaders([{ source: 'table', records }]);

  identityReads = 0;
  for (let i = 0; i < 1000; i++)
    assert.equal(
      lookup({ storageId: `workspace-${i}` } as WorkspaceEntry)[0].records
        .length,
      10,
    );
  assert.equal(identityReads, 0);
});
