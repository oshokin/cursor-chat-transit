import test from 'node:test';
import assert from 'node:assert/strict';
import { selectChats } from '../src/core';
import { mergeHeaders } from '../src/db';
import { chatListLabel } from '../src/picker';
import type { ComposerHeader } from '../src/types';

/** Composer id whose name is taken from workspace headers. */
const A = '11111111-1111-4111-8111-111111111111';
/** Second composer used when two titles must stay distinct. */
const B = '22222222-2222-4222-8222-222222222222';

test('sparse table header keeps a known workspace name', () => {
  const merged = mergeHeaders([
    {
      source: 'workspace',
      records: [{ composerId: A, name: 'Починить SSH' }],
    },
    { source: 'table', records: [{ composerId: A }] },
  ]);
  assert.equal(merged[0].name, 'Починить SSH');
});

test('name fallback does not depend on source order', () => {
  const merged = mergeHeaders([
    { source: 'table', records: [{ composerId: A }] },
    {
      source: 'workspace',
      records: [{ composerId: A, name: 'Починить SSH' }],
    },
  ]);
  assert.equal(merged[0].name, 'Починить SSH');
});

test('a non-empty higher-rank name still wins', () => {
  const merged = mergeHeaders([
    {
      source: 'workspace',
      records: [{ composerId: A, name: 'old' }],
    },
    { source: 'table', records: [{ composerId: A, name: 'new' }] },
  ]);
  assert.equal(merged[0].name, 'new');
});

test('an explicit empty name is not replaced', () => {
  const merged = mergeHeaders([
    {
      source: 'workspace',
      records: [{ composerId: A, name: 'Keep' }],
    },
    { source: 'table', records: [{ composerId: A, name: '' }] },
  ]);
  assert.equal(merged[0].name, '');
});

test('when every source omits name, the field stays absent', () => {
  const merged = mergeHeaders([
    { source: 'workspace', records: [{ composerId: A, createdAt: 9 }] },
    { source: 'table', records: [{ composerId: A, lastUpdatedAt: 11 }] },
  ]);
  assert.equal(merged[0].name, undefined);
  assert.equal('name' in merged[0], false);
  assert.equal(chatListLabel(merged[0].name), 'Untitled chat');
  assert.notEqual(String(merged[0].createdAt), merged[0].name);
});

test('duplicate titles stay distinct by composerId', () => {
  const merged = mergeHeaders([
    {
      source: 'workspace',
      records: [
        { composerId: A, name: 'Same title' },
        { composerId: B, name: 'Same title' },
      ],
    },
  ]);
  assert.equal(merged.length, 2);
  const selected = selectChats(merged, [B]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].composerId, B);
  assert.equal(selected[0].name, 'Same title');
});

test('authoritative table header wins; unique legacy id is kept', () => {
  const merged = mergeHeaders([
    {
      source: 'workspace',
      records: [
        { composerId: 'a', name: 'old' },
        { composerId: 'legacy-only', name: 'keep' },
      ],
    },
    { source: 'table', records: [{ composerId: 'a', name: 'new' }] },
  ]);
  const byId = Object.fromEntries(merged.map((c) => [c.composerId, c]));
  assert.equal(byId.a.name, 'new');
  assert.equal(byId['legacy-only'].name, 'keep');
});

test('fallback copies only name and does not mutate the chosen record', () => {
  const table: ComposerHeader = { composerId: A, extra: true };
  const workspace: ComposerHeader = {
    composerId: A,
    name: 'Keep',
    leftover: 1,
  };
  const merged = mergeHeaders([
    { source: 'workspace', records: [workspace] },
    { source: 'table', records: [table] },
  ]);
  assert.equal(merged[0].name, 'Keep');
  assert.equal(merged[0].extra, true);
  assert.equal(merged[0].leftover, undefined);
  assert.equal('name' in table, false);
  assert.equal(workspace.name, 'Keep');
});
