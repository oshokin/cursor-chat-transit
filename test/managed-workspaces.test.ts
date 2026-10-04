import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryDetail } from '../src/recovery-preview';

test('recovery copy explains concrete losses and does not promise continuation', () => {
  const detail = recoveryDetail({
    complete: 2,
    historyOnly: 1,
    skipped: 21,
    alreadyImported: 3,
    missingResources: { image: 2, kv: 1 },
    details: ['Unavailable: missing message body'],
  });

  assert.match(
    detail,
    /2 complete · 1 history only · 21 cannot be imported · 3 already imported/,
  );

  assert.match(detail, /2 images, 1 agent data records/);
  assert.match(detail, /missing original text cannot be recreated/);
  assert.match(detail, /may not allow recovered chats to continue/);
  assert.match(detail, /More details/);
});
