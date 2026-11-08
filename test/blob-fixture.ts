import { createHash } from 'node:crypto';

/** SHA-256 of blob bytes, which Cursor uses as the agentKv id. */
export function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Protobuf varint. */
function varint(value: number): Buffer {
  const out: number[] = [];
  let n = value;

  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }

  out.push(n);

  return Buffer.from(out);
}

/** Length-delimited protobuf field. */
function field(number: number, payload: Buffer): Buffer {
  return Buffer.concat([
    varint((number << 3) | 2),
    varint(payload.length),
    payload,
  ]);
}

/** 32-byte blob id field. */
function blob(number: number, id: string): Buffer {
  return field(number, Buffer.from(id, 'hex'));
}

/**
 * One chat shaped like Cursor's agent.v1 messages.
 * The todo blob is named and deliberately absent.
 */
export function agentChatFixture() {
  const text = Buffer.from('Please look at publish_deb.sh');
  const tool = Buffer.from('contents of publish_deb.sh');
  const fileBody = Buffer.from('package main\n');
  const initial = Buffer.from('package main\nfunc old()\n');
  const summary = Buffer.from('Packaging scripts were updated.');
  const textId = digest(text);
  const toolId = digest(tool);
  const fileId = digest(fileBody);
  const initialId = digest(initial);
  const summaryId = digest(summary);
  const selectedBody = Buffer.from('selected context payload\u0000');
  const selectedId = digest(selectedBody);
  const nestedBody = Buffer.from('nested read payload\u0000');
  const nestedId = digest(nestedBody);
  const originalStep = field(1, field(1, Buffer.from('original step')));
  const originalId = digest(originalStep);
  const read = field(8, field(2, field(1, blob(10, nestedId))));

  const truncated = field(
    34,
    Buffer.concat([blob(1, originalId), field(5, read)]),
  );

  const inline = Buffer.alloc(32, 0xef);

  const calls = [
    field(1, field(2, field(1, field(5, inline)))),
    field(12, field(2, field(1, field(7, inline)))),
    field(15, field(2, field(1, field(1, field(1, field(1, inline)))))),
    field(
      19,
      field(
        2,
        field(
          1,
          Buffer.concat([
            field(1, field(2, read)),
            field(1, field(2, truncated)),
          ]),
        ),
      ),
    ),
  ];

  const toolSteps = calls.map((call) => field(2, call));
  const toolIds = toolSteps.map(digest);

  const user = Buffer.concat([
    field(1, Buffer.from('update the packaging scripts')),
    field(3, field(1, blob(1, selectedId))),
    blob(18, textId),
  ]);

  const step = field(1, field(1, Buffer.from('I edited publish_deb.sh')));

  const userId = digest(user);
  const stepId = digest(step);

  const turn = field(
    1,
    Buffer.concat([
      blob(1, userId),
      blob(2, stepId),
      ...toolIds.map((id) => blob(2, id)),
    ]),
  );

  const turnId = digest(turn);
  const archive = blob(4, summaryId);
  const archiveId = digest(archive);
  const todoId = 'ab'.repeat(32);

  const state = Buffer.concat([
    blob(8, turnId),
    blob(3, todoId),
    blob(13, archiveId),
    field(
      15,
      Buffer.concat([
        field(1, Buffer.from('publish_deb.sh')),
        field(2, Buffer.concat([blob(1, fileId), blob(2, initialId)])),
      ]),
    ),
    field(18, Buffer.from('c'.repeat(32))),
  ]);

  const blobs = new Map<string, Buffer>([
    [turnId, turn],
    [userId, user],
    [stepId, step],
    [textId, text],
    [toolId, tool],
    [fileId, fileBody],
    [initialId, initial],
    [summaryId, summary],
    [archiveId, archive],
    [selectedId, selectedBody],
    [nestedId, nestedBody],
    [originalId, originalStep],
    ...toolSteps.map((bytes, i): [string, Buffer] => [toolIds[i]!, bytes]),
  ]);

  return {
    state: `~${state.toString('base64')}`,
    blobs,
    present: [
      turnId,
      archiveId,
      fileId,
      initialId,
      userId,
      stepId,
      summaryId,
      textId,
      selectedId,
      nestedId,
      originalId,
      ...toolIds,
    ],
    missing: todoId,
    decoy: Buffer.from('a'.repeat(32)).toString('hex'),
    readPath: Buffer.from('c'.repeat(32)).toString('hex'),
  };
}
