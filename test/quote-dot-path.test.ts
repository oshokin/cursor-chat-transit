import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteDotPath } from '../src/sqlite';

test('quoteDotPath escapes backslash and double quote', () => {
  assert.equal(
    quoteDotPath(String.raw`C:\Users\a`),
    String.raw`"C:\\Users\\a"`,
  );
  assert.equal(quoteDotPath('a"b'), String.raw`"a\"b"`);
  assert.equal(quoteDotPath("O'Brien"), `"O'Brien"`);
  assert.equal(quoteDotPath('файл'), `"файл"`);
  assert.equal(quoteDotPath('my file'), `"my file"`);
  assert.equal(
    quoteDotPath(String.raw`\\server\share\db`),
    String.raw`"\\\\server\\share\\db"`,
  );
});

test('quoteDotPath rejects empty and control characters', () => {
  assert.throws(() => quoteDotPath(''), TypeError);
  assert.throws(() => quoteDotPath('a\n'), TypeError);
  assert.throws(() => quoteDotPath('a\0b'), TypeError);
});
