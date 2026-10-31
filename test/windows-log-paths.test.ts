import test from 'node:test';
import assert from 'node:assert/strict';
import { logValue } from '../src/log-format';
import { startOperationLog } from '../src/operation-log';
import { asTransitLog } from '../src/output-ui';
import { sqliteTimeoutError } from '../src/sqlite-timeout';

for (const value of [
  String.raw`C:\Temp`,
  String.raw`C:\Users\Oleg Shokin\Проект`,
  String.raw`C:\new\tab`,
  '\\\\server\\share\\folder',
  '\\\\?\\C:\\Temp',
  'C:\\',
  '/home/oleg/a\\b',
]) {
  test(`human log preserves path separators: ${value}`, () => {
    assert.equal(logValue(value), `"${value}"`);
    const lines: string[] = [];

    const log = startOperationLog(
      asTransitLog({
        appendLine: (line) => lines.push(line),
        show() {},
        dispose() {},
      }),
      'import',
    );

    log.file(value);

    log.event({
      action: 'Read',
      status: 'started',
      path: value,
      source: value,
      destination: value,
    });

    log.phase('read', { file: value });
    assert.equal(lines.filter((line) => line.includes(`"${value}"`)).length, 3);
    assert.ok(sqliteTimeoutError(100, value).message.includes(value));
    assert.equal(JSON.parse(JSON.stringify(value)), value);
  });
}

test('quoted and control characters cannot forge another log field or line', () => {
  const rendered = logValue('a"b\n\r\t\u001b\u202e');

  assert.equal(rendered, '"a\\"b\\u000a\\u000d\\u0009\\u001b\\u202e"');
  assert.doesNotMatch(rendered, /[\p{Cc}\p{Cf}]/u);
});

test('UNC paths keep exactly their original two leading separators', () => {
  const unc = '\\\\host\\share\\file.zip';

  assert.equal(logValue(unc).slice(1, -1), unc);
  assert.notEqual(logValue(unc), JSON.stringify(unc));
});
