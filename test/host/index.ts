import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as vscode from 'vscode';

/** Activate the extension and exercise the public UI shell, not import/export. */
export async function run(): Promise<void> {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
  ) as { publisher: string; name: string };

  const id = `${manifest.publisher}.${manifest.name}`;
  const extension = vscode.extensions.getExtension(id);

  assert.ok(extension, `Extension not installed: ${id}`);
  await extension.activate();
  assert.equal(extension.isActive, true);
  const commands = await vscode.commands.getCommands(true);

  for (const command of [
    'cursorChatTransit.export',
    'cursorChatTransit.import',
    'cursorChatTransit.exportCurrentWorkspace',
    'cursorChatTransit.diagnostics',
    'cursorChatTransit.showOutput',
    'cursorChatTransit.manageSearch',
    'cursorChatTransit.manageCheck',
    'cursorChatTransit.manageDelete',
  ]) {
    assert.ok(commands.includes(command), `missing ${command}`);
  }

  assert.equal(extension.extensionKind, vscode.ExtensionKind.UI);
  await vscode.commands.executeCommand('cursorChatTransit.showOutput');

  await vscode.commands.executeCommand(
    'workbench.view.extension.cursorChatTransit',
  );

  await vscode.commands.executeCommand('cursorChatTransit.view.focus');
  await vscode.commands.executeCommand('cursorChatTransit.manage.focus');

  const html = fs.readFileSync(
    path.join(extension.extensionPath, 'resources', 'sidebar.html'),
    'utf8',
  );

  assert.match(html, /src="%%SCRIPT_URI%%"/);

  assert.equal(
    fs.existsSync(
      path.join(extension.extensionPath, 'resources', 'sidebar-client.js'),
    ),
    true,
  );

  const native = require(
    path.join(extension.extensionPath, 'out/sqlite-session.js'),
  ) as {
    SqliteSession: {
      open(options: { database: string }): Promise<{
        exec(sql: string, parameters?: unknown[]): Promise<string>;
        close(): Promise<void>;
      }>;
    };
  };

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-host-native-'));

  try {
    const session = await native.SqliteSession.open({
      database: path.join(temporary, 'test.sqlite'),
    });

    try {
      await session.exec('CREATE TABLE t(value);');
      await session.exec('INSERT INTO t VALUES (?);', ['native host']);

      assert.equal(
        (await session.exec('SELECT value FROM t;')).trim(),
        'native host',
      );

      assert.equal(
        (await session.exec('SELECT sqlite_version();')).trim(),
        '3.53.4',
      );
    } finally {
      await session.close();
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
