import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLayout } from '../src/schema';
import type { SchemaInfo } from '../src/types';

/** SchemaInfo containing only ItemTable, plus optional extra columns. */
function itemInfo(
  extra?: Array<[string, string, string, string, string, string]>,
): SchemaInfo {
  return {
    tables: new Set(['ItemTable']),
    types: { ItemTable: 'table' },
    info: {
      ItemTable: [
        ['0', 'key', 'TEXT', '0', '', '1'],
        ['1', 'value', 'BLOB', '0', '', '0'],
        ...(extra || []),
      ],
    },
  };
}

test('workspace write is allowed for key/value ItemTable', () => {
  const layout = detectLayout(itemInfo());
  assert.equal(layout.canWriteWorkspace, true);
  assert.equal(layout.canWriteGlobal, false);
});

test('extra required ItemTable column blocks workspace writes', () => {
  const layout = detectLayout(
    itemInfo([['2', 'requiredExtra', 'TEXT', '1', '', '0']]),
  );
  assert.equal(layout.canWriteWorkspace, false);
  assert.match(layout.unsupportedReason || '', /NOT NULL/);
});

test('workspace does not require cursorDiskKV', () => {
  const layout = detectLayout(itemInfo());
  assert.equal(layout.cursorDiskKV, false);
  assert.equal(layout.itemTable, true);
});
