import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectChats,
  workspaceKey,
  bubbleRange,
  sqlText,
  rewriteExactPaths,
  identityFromWorkspaceJson,
  currentIdentity,
  uriFromString,
} from '../src/core';
import { matchesWorkspace } from '../src/db';

test('undefined = all; [] = none', () => {
  const chats = [{ composerId: 'a' }, { composerId: 'b' }];
  assert.equal(selectChats(chats), chats);
  assert.deepEqual(selectChats(chats, []), []);
  assert.deepEqual(selectChats(chats, ['b']), [chats[1]]);
});

test('workspace identity preserves SSH authority and kind', () => {
  const a = {
    scheme: 'vscode-remote',
    authority: 'ssh-remote+host-a',
    path: '/repo',
  };
  const b = { ...a, authority: 'ssh-remote+host-b' };
  assert.notEqual(workspaceKey('folder', a), workspaceKey('folder', b));
  assert.notEqual(workspaceKey('folder', a), workspaceKey('workspace', a));
  assert.notEqual(
    workspaceKey('folder', a),
    workspaceKey('folder', { ...a, scheme: 'file' }),
  );
});

test('uriFromString percent-decodes the path once', () => {
  assert.equal(
    uriFromString('file:///tmp/my%20project').path,
    '/tmp/my project',
  );
  assert.equal(
    uriFromString('file:///tmp/my%2520project').path,
    '/tmp/my%20project',
  );
});

test('do not decode path twice or lowercase Linux paths', () => {
  const a = { scheme: 'file', authority: '', path: '/repo%20literal' };
  assert.notEqual(
    workspaceKey('folder', a),
    workspaceKey('folder', { ...a, path: '/repo literal' }),
  );
  assert.notEqual(
    workspaceKey('folder', a),
    workspaceKey('folder', { ...a, path: '/Repo%20literal' }),
  );
});

test('prefix bounds include only the selected composer', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const { lower, upper } = bubbleRange(id);
  assert.ok(`${lower}message` >= lower && `${lower}message` < upper);
  assert.throws(() => bubbleRange("a' OR 1=1 --"));
});

test('SQL text preserves apostrophes, NUL and Unicode without executable payload', () => {
  const s = "Олег's\0'); DELETE FROM ItemTable; --";
  const literal = sqlText(s);
  assert.match(literal, /^CAST\(X'[0-9a-f]*' AS TEXT\)$/);
  assert.equal(Buffer.from(literal.split("'")[1], 'hex').toString('utf8'), s);
});

test('exact field rewrite preserves user text and timestamps', () => {
  const obj = {
    composerId: 'old-c',
    bubbleId: 'old-b',
    nextBubbleId: 'old-next',
    text: 'Keep old-c and old-b',
    toolResult: { composerId: 'old-c' },
    createdAt: 7,
  };
  const ids = new Map([
    ['old-c', 'new-c'],
    ['old-b', 'new-b'],
    ['old-next', 'new-next'],
  ]);
  const changed = rewriteExactPaths(
    obj,
    ['/composerId', '/bubbleId', '/nextBubbleId'],
    ids,
  ) as typeof obj;
  assert.equal(changed.composerId, 'new-c');
  assert.equal(changed.nextBubbleId, 'new-next');
  assert.equal(changed.text, obj.text);
  assert.deepEqual(changed.toolResult, obj.toolResult);
  assert.equal(changed.createdAt, 7);
  assert.equal(obj.composerId, 'old-c');
});

test('prototype-like pointers are rejected', () => {
  assert.throws(() => rewriteExactPaths({}, ['/__proto__/x'], new Map()));
});

test('local and remote same path are different workspaces', () => {
  const remote = {
    scheme: 'vscode-remote',
    authority: 'ssh-remote+host-a',
    path: '/home/oleg/project',
  };
  const local = { scheme: 'file', authority: '', path: '/home/oleg/project' };
  assert.notEqual(
    workspaceKey('folder', remote),
    workspaceKey('folder', local),
  );
});

test('workspace.json workspace field wins over folder', () => {
  const id = identityFromWorkspaceJson({
    workspace: 'file:///home/oleg/project/team.code-workspace',
    folder: 'file:///home/oleg/project',
  });
  assert.equal(id.kind, 'workspace');
  assert.equal(id.uri.path, '/home/oleg/project/team.code-workspace');
});

test('header URI ending in .code-workspace matches workspace kind', () => {
  const identity = {
    kind: 'workspace' as const,
    uri: {
      scheme: 'file',
      authority: '',
      path: '/tmp/team.code-workspace',
      query: '',
      fragment: '',
    },
  };
  assert.equal(
    matchesWorkspace(
      {
        composerId: 'a',
        workspaceIdentifier: {
          id: 'other-storage',
          uri: identity.uri,
        },
      },
      'fixture',
      identity,
    ),
    true,
  );
});

test('same path on a different SSH authority does not match a header', () => {
  const identity = {
    kind: 'folder' as const,
    uri: {
      scheme: 'vscode-remote',
      authority: 'ssh-remote+host-a',
      path: '/repo',
      query: '',
      fragment: '',
    },
  };
  assert.equal(
    matchesWorkspace(
      {
        composerId: 'a',
        workspaceIdentifier: {
          id: 'other',
          uri: { ...identity.uri, authority: 'ssh-remote+host-b' },
        },
      },
      'fixture',
      identity,
    ),
    false,
  );
});

test('workspace.json identity equals a VS Code decoded URI identity', () => {
  const fromFile = identityFromWorkspaceJson({
    folder: 'file:///tmp/my%20project',
  });
  const fromHost = currentIdentity(undefined, [
    { uri: { scheme: 'file', authority: '', path: '/tmp/my project' } },
  ]);
  assert.ok(fromHost);
  assert.equal(
    workspaceKey(fromFile.kind, fromFile.uri),
    workspaceKey(fromHost.kind, fromHost.uri),
  );
});

test('currentIdentity uses workspaceFile before folders', () => {
  const id = currentIdentity(
    { scheme: 'file', authority: '', path: '/ws.code-workspace' },
    [{ uri: { scheme: 'file', authority: '', path: '/folder' } }],
  );
  assert.equal(id?.kind, 'workspace');
  assert.equal(id?.uri.path, '/ws.code-workspace');
});
