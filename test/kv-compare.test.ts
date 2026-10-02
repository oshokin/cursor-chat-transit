import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  classifyKvConflict,
  hexTextOfAddressedBlob,
  kvConflictDetail,
} from '../src/kv-compare';

/** Two different one-byte payloads. */
const left = Buffer.from([1]);
const right = Buffer.from([2]);

/** SHA-256 of raw bytes. */
function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('matching class and bytes are not a conflict', () => {
  assert.equal(
    classifyKvConflict(
      { storageClass: 'blob', bytes: left },
      { storageClass: 'blob', sha256: digest(left), byteLength: left.length },
    ),
    null,
  );
});

test('storage class, content, and both are distinct reasons', () => {
  const sameHash = classifyKvConflict(
    { storageClass: 'text', bytes: left },
    { storageClass: 'blob', sha256: digest(left), byteLength: left.length },
  );

  assert.equal(sameHash?.reason, 'storage-class');

  const different = classifyKvConflict(
    { storageClass: 'blob', bytes: left },
    { storageClass: 'blob', sha256: digest(right), byteLength: right.length },
  );

  assert.equal(different?.reason, 'content');

  const both = classifyKvConflict(
    { storageClass: 'text', bytes: left },
    { storageClass: 'blob', sha256: digest(right), byteLength: right.length },
  );

  assert.equal(both?.reason, 'both');

  const detail = kvConflictDetail(
    both!,
    `agentKv:blob:${digest(left)}`,
    'preflight',
  );

  assert.match(detail, /phase=preflight reason=both/);
  assert.match(detail, /keyMatchesExisting=true/);
  assert.match(detail, /keyMatchesIncoming=false/);
});

test('hex text restores only when it spells the addressed blob', () => {
  const raw = Buffer.from([1, 2, 3]);
  const key = `agentKv:blob:${digest(raw)}`;
  const hex = Buffer.from(raw.toString('hex'), 'utf8');

  const decoded = hexTextOfAddressedBlob(
    { storageClass: 'text', bytes: hex },
    { storageClass: 'blob', sha256: digest(raw), byteLength: raw.length },
    key,
  );

  assert.equal(decoded?.equals(raw), true);

  assert.equal(
    hexTextOfAddressedBlob(
      { storageClass: 'text', bytes: raw },
      { storageClass: 'blob', sha256: digest(raw), byteLength: raw.length },
      key,
    ),
    null,
  );

  assert.equal(
    hexTextOfAddressedBlob(
      { storageClass: 'text', bytes: Buffer.from('00', 'utf8') },
      { storageClass: 'blob', sha256: digest(raw), byteLength: raw.length },
      key,
    ),
    null,
  );
});
