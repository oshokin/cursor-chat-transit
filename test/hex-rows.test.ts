import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hexAsciiToBuffer,
  parseHexRowLine,
  createHexRowParser,
} from '../src/sqlite';

test('hex ASCII decodes without a JS string of the payload', () => {
  const ascii = Buffer.from('6869', 'ascii');
  assert.equal(hexAsciiToBuffer(ascii).toString('utf8'), 'hi');
});

test('hex row parser accepts chunked tabs and newlines', async () => {
  const rows: Buffer[][] = [];
  const parser = createHexRowParser(2, (fields) => {
    rows.push(fields);
  });
  parser.write(Buffer.from('6869\t'));
  parser.write(Buffer.from('7468\r\n6f\t6b\n'));
  await new Promise<void>((resolve, reject) => {
    parser.end((err: Error | null | undefined) =>
      err ? reject(err) : resolve(),
    );
  });
  assert.equal(rows[0][0].toString('utf8'), 'hi');
  assert.equal(rows[0][1].toString('utf8'), 'th');
  assert.equal(rows[1][0].toString('utf8'), 'o');
  assert.equal(rows[1][1].toString('utf8'), 'k');
});

test('parseHexRowLine pads missing columns', () => {
  const fields = parseHexRowLine(Buffer.from('61'), 2);
  assert.equal(fields[0].toString('utf8'), 'a');
  assert.equal(fields[1].length, 0);
});
