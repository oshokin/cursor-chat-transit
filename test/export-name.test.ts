import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  cleanFilenamePart,
  selectionForFilename,
  suggestExportFilename,
  workspaceNameFromIdentity,
} from '../src/export-name';

/** Fixed clock so suggested filenames stay deterministic. */
const now = new Date('2026-09-27T13:42:45.123Z');

test('all chats uses workspace name and an explicit Cursor chat suffix', () => {
  assert.equal(
    suggestExportFilename({
      workspaceName: 'dispersed-object-store',
      selection: { kind: 'all', count: 6 },
      now,
    }),
    'dispersed-object-store--all-chats--20260927T134245123Z.cursor-chat.json',
  );
});

test('one selected chat uses its readable Unicode title', () => {
  assert.equal(
    suggestExportFilename({
      workspaceName: 'hydra',
      selection: {
        kind: 'selected',
        count: 1,
        chatTitle: 'Исправление таймаутов',
      },
      now,
    }),
    'hydra--Исправление-таймаутов--20260927T134245123Z.cursor-chat.json',
  );
});

test('multiple selected chats use the selection count', () => {
  assert.match(
    suggestExportFilename({
      workspaceName: 'libucsdos',
      selection: { kind: 'selected', count: 3 },
      now,
    }),
    /libucsdos--3-chats--/,
  );
});

test('Windows forbidden characters and path traversal cannot create a path', () => {
  const name = suggestExportFilename({
    workspaceName: '../a\\b:<c>|d?*',
    selection: { kind: 'selected', count: 1, chatTitle: '../../title' },
    now,
  });
  assert.equal(path.posix.basename(name), name);
  assert.equal(path.win32.basename(name), name);
  // eslint-disable-next-line no-control-regex -- forbidden filename bytes
  assert.doesNotMatch(name, /[<>:"/\\|?*\x00-\x1f]/u);
});

test('reserved device names, trailing dots, and empty titles are handled', () => {
  for (const name of ['CON', 'nul', 'COM1', 'LPT²', 'AUX.txt']) {
    assert.match(cleanFilenamePart(name, 'chat'), /^_/);
  }
  assert.equal(cleanFilenamePart('title.  ', 'chat'), 'title');
  assert.equal(cleanFilenamePart('... / \\', 'chat'), 'chat');
});

test('NFC normalization preserves non-Latin names', () => {
  assert.equal(cleanFilenamePart('cafe\u0301', 'chat'), 'café');
  assert.equal(cleanFilenamePart('Обсуждение базы', 'chat'), 'Обсуждение-базы');
});

test('long names respect byte limits and retain a differentiating hash', () => {
  const a = cleanFilenamePart('😀'.repeat(300) + 'a', 'chat');
  const b = cleanFilenamePart('😀'.repeat(300) + 'b', 'chat');
  assert.ok(Buffer.byteLength(a) <= 72);
  assert.notEqual(a, b);
  const name = suggestExportFilename({
    workspaceName: 'Ж'.repeat(400),
    selection: { kind: 'selected', count: 1, chatTitle: '😀'.repeat(400) },
    now,
  });
  assert.ok(Buffer.byteLength(name) <= 200);
  assert.ok(name.length <= 200);
});

test('zero selection and invalid dates do not produce a misleading export name', () => {
  assert.throws(() =>
    suggestExportFilename({
      workspaceName: 'x',
      selection: { kind: 'all', count: 0 },
      now,
    }),
  );
  assert.throws(() =>
    suggestExportFilename({
      workspaceName: 'x',
      selection: { kind: 'all', count: 1 },
      now: new Date(NaN),
    }),
  );
});

test('bidi controls cannot visually hide the suffix', () => {
  const name = suggestExportFilename({
    workspaceName: 'x\u202eexe',
    selection: { kind: 'all', count: 1 },
    now,
  });
  assert.doesNotMatch(name, /[\u202a-\u202e\u2066-\u2069]/u);
  assert.ok(name.endsWith('.cursor-chat.json'));
});

test('workspace identity uses URI leaf and strips .code-workspace', () => {
  assert.equal(
    workspaceNameFromIdentity('workspace', '/tmp/team.code-workspace'),
    'team',
  );
  assert.equal(
    workspaceNameFromIdentity('folder', '/tmp/my project'),
    'my project',
  );
});

test('one selected chat passes its real title into the filename helper', () => {
  const selection = selectionForFilename('selected', [
    { name: 'Починить SSH' },
    { name: 'Other' },
  ]);
  assert.deepEqual(selection, { kind: 'selected', count: 2 });
  assert.deepEqual(
    selectionForFilename('selected', [{ name: 'Починить SSH' }]),
    {
      kind: 'selected',
      count: 1,
      chatTitle: 'Починить SSH',
    },
  );
  const name = suggestExportFilename({
    workspaceName: 'real-project',
    selection: selectionForFilename('selected', [{ name: 'Починить SSH' }]),
    now,
  });
  assert.match(name, /Починить-SSH/);
});

test('a missing chat title does not become Untitled chat or a timestamp', () => {
  const selection = selectionForFilename('selected', [{}]);
  assert.deepEqual(selection, {
    kind: 'selected',
    count: 1,
    chatTitle: 'chat',
  });
  const name = suggestExportFilename({
    workspaceName: 'ws',
    selection,
    now,
  });
  assert.doesNotMatch(name, /Untitled/);
  assert.doesNotMatch(name, /1790418430150/);
  assert.match(name, /--chat--/);
});
