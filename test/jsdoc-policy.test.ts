import test from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

test('documentation policy requires exported contracts but not obvious local callbacks', async () => {
  const eslint = new ESLint();

  const lint = async (code: string) =>
    (
      await eslint.lintText(code, {
        filePath: 'src/documentation-policy-fixture.ts',
      })
    )[0].messages.filter((message) => message.ruleId?.startsWith('jsdoc/'));

  for (const code of [
    'export function read() {}',
    'export class Reader {}',
    'export interface Row { id: string; }',
    'export type Row = string;',
    'export const read = () => 1;',
    'export const limit = 32;',
  ]) {
    assert.ok(
      (await lint(code)).some(
        (message) => message.ruleId === 'jsdoc/require-jsdoc',
      ),
      code,
    );
  }

  assert.deepEqual(
    await lint(
      '/** Reads one bounded record; throws on malformed input. */\nexport function read() { return [1].map(value => value + 1); }',
    ),
    [],
  );

  assert.deepEqual(
    await lint('function helper() { return 1; }\nexport {};'),
    [],
  );

  assert.ok(
    (
      await lint(
        '/** Reads text.\n * @param {string} value Input.\n */\nexport function read(value: string) { return value; }',
      )
    ).some((message) => message.ruleId === 'jsdoc/no-types'),
  );
});
